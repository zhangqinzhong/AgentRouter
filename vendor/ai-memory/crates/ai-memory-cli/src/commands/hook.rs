//! `ai-memory hook` — emit a single lifecycle event natively.
//!
//! Reads the event payload from stdin. Instead of POSTing synchronously on the
//! agent's hot path (which would block every tool call on the network and drop
//! events against a slow/remote server), the event is **spooled** locally — an
//! instant write. `session-start` performs a short, lock-aware synchronous
//! cleanup pass before fetching handoff context. `session-end` returns quickly:
//! after enqueue it spawns a detached `hook-drain` process, whose stdout/stderr
//! are redirected away from the agent, and that process drains under an
//! exclusive spool lock with a longer bounded budget. Zero, whose hook sandbox
//! kills detached children, drains in-process within a short fixed budget.
//!
//! See `docs/windows.md#native-hook-command-claude-code-on-windows`.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use ai_memory_core::{AgentKind, ManagedRunId, SessionId};
use ai_memory_hooks::capture_policy::metadata_only_body;
use ai_memory_hooks::{
    CaptureDecision, CaptureDisposition, CaptureMode, CapturePolicy, CaptureSource, GlobStep,
    GlobWalk, HookEvent, PolicyState, absolute_tool_location_paths, capture_lookup_locations,
    glob_segment_matches, glob_walk, repository_admits_capture,
};
use ai_memory_llm::OidcToken;

use crate::cli::HookArgs;
use crate::config::{Config, RuntimeEnv};
use crate::server_profiles::{self, ProfileName, Rejection, ResolvedServer};

use sha2::{Digest as _, Sha256};

use super::hook_capture::{
    HookScope, build_client, canonical_context, capture_policy, extract_cwd, get_handoff,
    hook_scope, marker_capture_policy, marker_query_suffix, marker_query_suffix_without_briefing,
    marker_requests_briefing, resolve_cwd_with_fallbacks, url_encode,
};
use super::hook_drain_process;
use super::hook_spool;
use super::path_util::{home_dir, strip_windows_verbatim_prefix};

// All drain/handoff timings default to the current short values and can be
// overridden by whole-minute env vars for very high-latency or large-backlog
// instances. Two kinds: per-request timeouts cap each individual POST / handoff
// GET; session-boundary budgets cap how long a boundary spends draining (so a
// boundary never hangs unbounded).
const DEFAULT_DRAIN_TIMEOUT: Duration = Duration::from_secs(3);
const DEFAULT_HANDOFF_TIMEOUT: Duration = Duration::from_secs(3);
const DEFAULT_START_BUDGET: Duration = Duration::from_secs(3);
const DEFAULT_BACKGROUND_DRAIN_BUDGET: Duration = Duration::from_secs(5 * 60);
const MAX_OVERRIDE_MINUTES: u64 = 60;

const DRAIN_TIMEOUT_ENV: &str = "AI_MEMORY_HOOK_DRAIN_TIMEOUT_MINUTES";
const HANDOFF_TIMEOUT_ENV: &str = "AI_MEMORY_HOOK_HANDOFF_TIMEOUT_MINUTES";
const START_BUDGET_ENV: &str = "AI_MEMORY_HOOK_START_BUDGET_MINUTES";
const BACKGROUND_DRAIN_BUDGET_ENV: &str = "AI_MEMORY_HOOK_BACKGROUND_DRAIN_BUDGET_MINUTES";

const INCREMENTAL_THRESHOLD_ENV: &str = "AI_MEMORY_HOOK_INCREMENTAL_THRESHOLD";
const MANAGED_RUN_ENV: &str = "AI_MEMORY_RUN_ID";
const CAPTURE_OWNER_ENV: &str = "AI_MEMORY_CAPTURE_OWNER";
/// Backlog size at which `post-tool-use` does a mid-session catch-up drain, so a
/// light session pays only a `read_dir`. Override via the env var above.
const DEFAULT_INCREMENTAL_THRESHOLD: usize = 32;
const MAX_BRIEFED_MARKERS: usize = 512;
/// Total budget AND per-event timeout for the mid-session catch-up drain — kept
/// well under a second so a `post-tool-use` hook never stalls a tool call (one
/// in-flight POST against a slow server is bounded by this too).
const INCREMENTAL_DRAIN_BUDGET: Duration = Duration::from_millis(250);
/// Total budget, lock wait included, for a `session-end` drained in-process
/// ([`session_end_drains_in_process`]). Fixed rather than env-overridable:
/// together with [`IN_PROCESS_SESSION_END_DEADLINE`] it has to stay inside
/// Zero's 30-second hook timeout.
const IN_PROCESS_SESSION_END_DRAIN_BUDGET: Duration = Duration::from_secs(10);
/// Hard stop for that drain, the request in flight at the budget included.
const IN_PROCESS_SESSION_END_DEADLINE: Duration = Duration::from_secs(20);
// Zero kills a hook after 30 seconds; the hard stop must land first.
const _: () = assert!(
    IN_PROCESS_SESSION_END_DRAIN_BUDGET.as_secs() < IN_PROCESS_SESSION_END_DEADLINE.as_secs()
        && IN_PROCESS_SESSION_END_DEADLINE.as_secs() < 30
);

/// Per-event POST timeout during a drain. Env: `AI_MEMORY_HOOK_DRAIN_TIMEOUT_MINUTES`.
fn drain_event_timeout() -> Duration {
    drain_event_timeout_from(env_lookup)
}
/// Synchronous handoff GET timeout. Env: `AI_MEMORY_HOOK_HANDOFF_TIMEOUT_MINUTES`.
fn handoff_timeout() -> Duration {
    handoff_timeout_from(env_lookup)
}
/// Total budget for the `session-start` cleanup drain (kept tight so session
/// start stays snappy even when the server is down — leftovers wait). Env:
/// `AI_MEMORY_HOOK_START_BUDGET_MINUTES`.
fn start_drain_budget() -> Duration {
    start_drain_budget_from(env_lookup)
}
/// Total budget for detached background drains. Env:
/// `AI_MEMORY_HOOK_BACKGROUND_DRAIN_BUDGET_MINUTES`.
fn background_drain_budget() -> Duration {
    background_drain_budget_from(env_lookup)
}

fn drain_event_timeout_from(lookup: impl FnMut(&str) -> Option<String>) -> Duration {
    env_minutes(DRAIN_TIMEOUT_ENV, DEFAULT_DRAIN_TIMEOUT, lookup)
}

fn handoff_timeout_from(lookup: impl FnMut(&str) -> Option<String>) -> Duration {
    env_minutes(HANDOFF_TIMEOUT_ENV, DEFAULT_HANDOFF_TIMEOUT, lookup)
}

fn start_drain_budget_from(lookup: impl FnMut(&str) -> Option<String>) -> Duration {
    env_minutes(START_BUDGET_ENV, DEFAULT_START_BUDGET, lookup)
}

fn background_drain_budget_from(lookup: impl FnMut(&str) -> Option<String>) -> Duration {
    env_minutes(
        BACKGROUND_DRAIN_BUDGET_ENV,
        DEFAULT_BACKGROUND_DRAIN_BUDGET,
        lookup,
    )
}

/// Backlog size at which `post-tool-use` triggers a mid-session catch-up drain.
/// Env: `AI_MEMORY_HOOK_INCREMENTAL_THRESHOLD` (positive integer).
fn incremental_drain_threshold() -> usize {
    incremental_drain_threshold_from(env_lookup)
}

fn incremental_drain_threshold_from(mut lookup: impl FnMut(&str) -> Option<String>) -> usize {
    lookup(INCREMENTAL_THRESHOLD_ENV)
        .and_then(|s| s.trim().parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(DEFAULT_INCREMENTAL_THRESHOLD)
}

/// Whether to run a mid-session catch-up drain for this event: only
/// `post-tool-use` (the highest-frequency event) and only once the spool backlog
/// has crossed `threshold`. Boundaries run their own cleanup/background drains,
/// so a light session never drains mid-session.
fn should_incremental_drain(event: &str, spool_len: usize, threshold: usize) -> bool {
    event == "post-tool-use" && spool_len >= threshold
}

fn spawn_background_drainer(data_dir: &Path, live_token: Option<&str>) -> std::io::Result<()> {
    hook_drain_process::spawn(data_dir, live_token)
}

fn should_spawn_background_drainer(event: &str) -> bool {
    matches!(event, "session-end" | "stop" | "pre-compact")
}

/// Zero runs hooks in a sandbox started with `--die-with-parent`, which kills
/// a detached drainer the moment the hook exits, so its `session-end` drains
/// in-process within [`IN_PROCESS_SESSION_END_DRAIN_BUDGET`] instead (#1172).
fn session_end_drains_in_process(agent: AgentKind, event: &str) -> bool {
    agent == AgentKind::Zero && event == "session-end"
}

/// Drain the spool from the hook process itself, for a harness that kills the
/// detached drainer. Undelivered events stay spooled for the next boundary.
async fn drain_session_end_in_process(
    spool: &Path,
    data_dir: &Path,
    max_attempts: hook_spool::MaxAttempts,
) {
    let drain = hook_spool::drain_exclusive_within_budget(
        spool,
        data_dir,
        IN_PROCESS_SESSION_END_DRAIN_BUDGET,
        drain_event_timeout().min(IN_PROCESS_SESSION_END_DRAIN_BUDGET),
        max_attempts,
    );
    // The budget stops new requests; this also stops one already in flight
    // (an old server's per-event fallback, a token refresh). Cancelling only
    // at an await point leaves every spool file whole: at worst an accepted
    // event is re-sent and the server's ingest key skips it.
    let _ = tokio::time::timeout(IN_PROCESS_SESSION_END_DEADLINE, drain).await;
}

fn session_id_state_path(data_dir: &Path, agent: AgentKind) -> PathBuf {
    data_dir
        .join("hook-state")
        .join(format!("{}-session-id", agent.as_str()))
}

fn stored_session_id(data_dir: &Path, agent: AgentKind) -> Option<String> {
    let path = session_id_state_path(data_dir, agent);
    let raw = fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn store_session_id(data_dir: &Path, agent: AgentKind, session_id: &str) {
    let path = session_id_state_path(data_dir, agent);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, session_id);
}

pub(crate) fn clear_session_id(data_dir: &Path, agent: AgentKind) {
    let _ = fs::remove_file(session_id_state_path(data_dir, agent));
}

/// `<data_dir>/briefed/<key>` — records that the compiled project brief
/// (`[briefing] inject_on_session_start`) was already delivered for this
/// session by the user-prompt handoff path. kimi-code discards SessionStart
/// hook stdout, so the brief rides the FIRST user prompt of the session
/// (parity with Claude's once-per-SessionStart brief); the marker keeps
/// later prompts from re-requesting it. Keyed by the payload's canonical
/// session id when Kimi supplies one; payloads without one fall back to a
/// stable hash of agent+cwd so a session-less agent still briefs once per
/// checkout. The key is sanitized to a safe file name.
fn briefed_marker_path(
    data_dir: &Path,
    agent: &str,
    session_id: Option<&str>,
    cwd: Option<&str>,
) -> PathBuf {
    let key = session_id.map_or_else(
        || {
            format!(
                "{:x}",
                Sha256::digest(format!("{agent}\n{}", cwd.unwrap_or_default()).as_bytes())
            )
        },
        sanitize_briefed_key,
    );
    data_dir.join("briefed").join(key)
}

/// The once-per-session profile-digest marker beside a brief marker: same
/// key, `profile-` prefix, so the two gates never share a file. The shell and
/// PowerShell hooks name it the same way.
fn profile_digest_marker_path(brief_marker: PathBuf) -> PathBuf {
    let name = brief_marker
        .file_name()
        .map(|name| format!("profile-{}", name.to_string_lossy()))
        .unwrap_or_else(|| "profile-".to_owned());
    brief_marker.with_file_name(name)
}

fn sanitize_briefed_key(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Best-effort marker write with bounded retention: on failure the worst case
/// is a re-brief on the next prompt, which is acceptable.
fn mark_briefed(path: &Path) {
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() || fs::write(path, b"").is_err() {
        return;
    }

    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    let mut stale_candidates = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then_some((
                metadata.modified().ok(),
                entry.file_name(),
                entry.path(),
            ))
        })
        .filter(|(_, _, candidate)| candidate != path)
        .collect::<Vec<_>>();
    stale_candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    let keep_others = MAX_BRIEFED_MARKERS.saturating_sub(1);
    for (_, _, stale) in stale_candidates.into_iter().skip(keep_others) {
        let _ = fs::remove_file(stale);
    }
}

fn fresh_session_id(data_dir: &Path, agent: AgentKind) -> String {
    let session_id = SessionId::new().to_string();
    store_session_id(data_dir, agent, &session_id);
    session_id
}

fn payload_has_session_id(raw: &serde_json::Value) -> bool {
    [
        "session_id",
        "sessionId",
        "sessionID",
        "session",
        "conversationId",
    ]
    .iter()
    .any(|key| {
        raw.get(*key)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    })
}

/// Agents whose hook payloads do not reliably carry a session id. Devin's
/// payloads may omit it; ZCode's do too (and ZCode fires `Stop` per turn with
/// no SessionEnd, so without a persisted id each turn would fragment into a
/// fresh server-side session). For these agents the hook maintains a
/// `<data_dir>/hook-state/<agent>-session-id` file so a whole agent session
/// shares one stable id. Agents whose payloads always carry an id never touch
/// this path.
fn agent_needs_session_id_state(agent_kind: AgentKind) -> bool {
    matches!(agent_kind, AgentKind::Devin | AgentKind::Zcode)
}

fn session_id_query_suffix(
    data_dir: &Path,
    agent: &str,
    event: &str,
    raw: &serde_json::Value,
) -> String {
    let agent_kind = AgentKind::from_wire(agent);
    if !agent_needs_session_id_state(agent_kind) || payload_has_session_id(raw) {
        return String::new();
    }

    let session_id = if event == "session-start" {
        fresh_session_id(data_dir, agent_kind)
    } else {
        stored_session_id(data_dir, agent_kind)
            .unwrap_or_else(|| fresh_session_id(data_dir, agent_kind))
    };
    format!("&session_id={}", url_encode(&session_id))
}

fn resolve_hook_cwd_with(
    agent: &str,
    raw: &serde_json::Value,
    env_lookup: impl FnMut(&str) -> Option<String>,
    current_dir: impl FnOnce() -> Option<PathBuf>,
) -> Option<String> {
    let agent_kind = AgentKind::from_wire(agent);
    let (canonical_cwd, _) = canonical_context(raw);
    if canonical_cwd.is_some() {
        canonical_cwd
    } else if agent_kind == AgentKind::Devin {
        resolve_cwd_with_fallbacks(raw, env_lookup, current_dir)
    } else {
        extract_cwd(raw).filter(|s| !s.trim().is_empty())
    }
}

fn cwd_query_suffix(
    agent: &str,
    raw: &serde_json::Value,
    default_strategy: Option<&str>,
) -> String {
    resolve_hook_cwd_with(agent, raw, env_lookup, || std::env::current_dir().ok())
        .map(|cwd| marker_query_suffix(&cwd, default_strategy))
        .unwrap_or_default()
}

fn after_background_drain_event_enqueue(
    data_dir: &Path,
    live_token: Option<&str>,
    spawn: impl FnOnce(&Path, Option<&str>) -> std::io::Result<()>,
) -> std::io::Result<()> {
    spawn(data_dir, live_token)
}

/// Hidden drain-only fast path. Reads no stdin and writes no stdout.
pub async fn run_drain(data_dir: Option<PathBuf>) -> anyhow::Result<()> {
    let runtime_env = RuntimeEnv::from_process();
    let dd = resolve_data_dir_with(data_dir.as_deref(), &runtime_env);
    if !dd.is_dir() {
        // Purged (or never created): nothing was queued, and a warning has
        // nowhere useful to go since `hook-drain.log` lived in that dir.
        return Ok(());
    }
    // The hook path never runs a full `Config::load` (see the fast-path
    // contract in `lib.rs`): an invalid config section elsewhere must not
    // fail the drainer. Only the spool retry policy is needed, loaded
    // tolerantly — any load error falls back to defaults.
    let config =
        Config::load_with_runtime_env(Some(&dd.join("config.toml")), Some(dd.clone()), runtime_env)
            .unwrap_or_default();
    let max_attempts = hook_spool::MaxAttempts::new(config.hook_spool.max_attempts);
    let spool = hook_spool::spool_dir(&dd);
    match hook_spool::drain_until_quiescent(
        &spool,
        &dd,
        background_drain_budget(),
        drain_event_timeout(),
        hook_spool::DrainLockWait::Bounded(Duration::from_secs(30)),
        max_attempts,
    )
    .await
    {
        Ok(outcome) => {
            let _ = write_drain_report(&mut std::io::stderr(), &outcome);
        }
        Err(err) => eprintln!("ai-memory hook-drain warning: failed to acquire drain lock: {err}"),
    }
    Ok(())
}

/// Report a drain pass on stderr when it ended with events undelivered.
///
/// Silent on a clean pass (nothing queued, or everything delivered) so
/// `hook-drain.log` stays warning-only, matching the rotation budget in
/// [`hook_drain_process`]. stderr, never stdout: the drainer's stdout is
/// contractually empty and the detached helper redirects stderr into the log.
///
/// Without this the drain discarded its own [`hook_spool::DrainResult`], so a
/// pass that dropped every queued event without sending it was byte-identical,
/// on both streams and in the exit code, to one that delivered them all — and
/// so was a pass that did nothing because another drainer held the lock (#493).
fn write_drain_report<W: std::io::Write>(
    w: &mut W,
    outcome: &hook_spool::LockedDrainResult,
) -> std::io::Result<()> {
    match outcome {
        // Says what this pass did, not what the spool holds: `LockBusy` is
        // returned before `drain_until_quiescent` lists anything, so the count
        // of queued events is unknown here. Asserting one would repeat, inside
        // the fix, the confusion the fix is for.
        hook_spool::LockedDrainResult::LockBusy => writeln!(
            w,
            "ai-memory hook-drain warning: another drainer holds the spool lock; \
             this pass attempted no delivery and left the spool untouched"
        ),
        hook_spool::LockedDrainResult::Drained(result) => {
            if result.remaining == 0 && result.dropped == 0 {
                return Ok(());
            }
            // "acknowledged", not "delivered": `sent` counts what the server
            // ACKed, and an ack also covers an item the server accepted and then
            // dropped by capture policy (`accepted_indices` includes protocol
            // drops). Reporting those as delivered would assert storage the
            // drain cannot observe — the precise confusion #493 was written in.
            writeln!(
                w,
                "ai-memory hook-drain warning: {} event(s) acknowledged by the server, \
                 {} still queued, {} DROPPED undelivered (past the retry cap or \
                 older than the spool TTL)",
                result.sent, result.remaining, result.dropped
            )
        }
    }
}

fn env_lookup(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

fn managed_run_query_suffix_with(mut env_lookup: impl FnMut(&str) -> Option<String>) -> String {
    env_lookup(MANAGED_RUN_ENV)
        .filter(|value| value.parse::<ManagedRunId>().is_ok())
        .map_or_else(String::new, |value| {
            format!("&managed_run={}", url_encode(&value))
        })
}

fn managed_run_query_suffix() -> String {
    managed_run_query_suffix_with(env_lookup)
}

/// Read a positive-integer minute override from `name`, falling back to the
/// built-in short default for missing / empty / non-numeric / zero values. Clamp
/// large values so a typo cannot block a hook boundary for hours or days.
fn env_minutes(
    name: &str,
    default: Duration,
    mut lookup: impl FnMut(&str) -> Option<String>,
) -> Duration {
    parse_minutes(lookup(name), default)
}

fn parse_minutes(raw: Option<String>, default: Duration) -> Duration {
    let minutes = raw
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|&n| n > 0)
        .map(|n| n.min(MAX_OVERRIDE_MINUTES));
    match minutes {
        Some(n) => Duration::from_secs(n * 60),
        None => default,
    }
}

fn should_process_hook_event(agent: AgentKind, event: HookEvent, raw: &serde_json::Value) -> bool {
    if agent == AgentKind::AntigravityCli && event == HookEvent::SessionStart {
        return raw.get("invocationNum").and_then(serde_json::Value::as_u64) == Some(0);
    }
    true
}

/// A `--agent claude-code` hook invoked by Cursor (it runs Claude Code's
/// settings too) is a duplicate when Cursor's own ai-memory hooks are also
/// installed: the native `--agent cursor` hook already delivers the same
/// event. Dropping it keeps one observation per Cursor event (#721). The
/// installed check runs last so ordinary Claude Code events never touch disk.
fn is_redundant_cursor_copy(
    agent: AgentKind,
    raw: &serde_json::Value,
    cursor_hooks_installed: impl FnOnce() -> bool,
) -> bool {
    agent == AgentKind::ClaudeCode
        && ai_memory_hooks::agent_from_payload(raw) == Some(AgentKind::Cursor)
        && cursor_hooks_installed()
}

/// A plugin-launched event that a settings-file hook already delivers, or
/// that belongs to a session with no project folder (#1166). Ordinary
/// settings-file hooks carry no origin and never take this path.
fn is_dropped_plugin_copy(
    args: &HookArgs,
    raw: &serde_json::Value,
    mut lookup: impl FnMut(&str) -> Option<String>,
) -> bool {
    use super::plugin_origin::{PluginOrigin, drops_plugin_event, settings_files_for};
    let Some(origin) = PluginOrigin::from_env(&mut lookup) else {
        return false;
    };
    let (cwd, _) = hook_context(&args.agent, raw);
    let settings = settings_files_for(origin, cwd.as_deref(), &mut lookup);
    drops_plugin_event(origin, &args.event, cwd.as_deref(), &settings)
}

fn write_success_response<W: std::io::Write>(
    stdout: &mut W,
    agent: AgentKind,
    event: HookEvent,
) -> std::io::Result<()> {
    if agent == AgentKind::KiroCli {
        // Kiro adds successful SessionStart/UserPromptSubmit stdout to model
        // context, and v2/v3 Stop parse stdout for a block decision. Capture-only
        // hooks therefore stay silent unless SessionStart has real context.
        Ok(())
    } else if agent == AgentKind::Muse
        && matches!(event, HookEvent::SessionStart | HookEvent::UserPrompt)
    {
        // Muse adds SessionStart and UserPromptSubmit stdout to the turn as
        // developer context, so a capture-only reply stays empty rather than
        // put `{}` in front of the model on every prompt.
        Ok(())
    } else if event == HookEvent::UserPrompt && agent.user_prompt_injects_handoff() {
        // Kimi Code injects any non-empty UserPromptSubmit stdout into the turn
        // verbatim, so a `{}` here would become user-visible text on every
        // prompt a gate dropped (allowlist, capture policy, refused profile).
        Ok(())
    } else if agent == AgentKind::AntigravityCli && event == HookEvent::PreToolUse {
        writeln!(stdout, r#"{{"decision": "allow"}}"#)
    } else {
        writeln!(stdout, "{{}}")
    }
}

const GROK_ADDITIONAL_CONTEXT_CHARS: usize = 10_000;

fn grok_post_tool_handoff_envelope(handoff: &str) -> serde_json::Value {
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": clip_chars(handoff, GROK_ADDITIONAL_CONTEXT_CHARS),
        }
    })
}

fn payload_is_subagent(raw: &serde_json::Value) -> bool {
    [
        "subagentType",
        "subagent_type",
        "agent_type",
        "agent_id",
        "parentSessionId",
    ]
    .iter()
    .any(|key| {
        raw.get(*key)
            .and_then(|value| value.as_str())
            .is_some_and(|text| !text.trim().is_empty())
    })
}

fn clip_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let keep = max_chars.saturating_sub(12);
    let mut out: String = text.chars().take(keep).collect();
    out.push_str("\n[truncated]");
    out
}

fn handoff_shown_path(
    data_dir: &Path,
    agent: &str,
    session_id: Option<&str>,
    cwd: Option<&str>,
) -> PathBuf {
    let key = briefed_marker_path(data_dir, agent, session_id, cwd);
    data_dir
        .join("handoff-shown")
        .join(key.file_name().unwrap_or_default())
}

fn session_start_handoff_envelope(agent: AgentKind, handoff: String) -> serde_json::Value {
    if agent == AgentKind::AntigravityCli {
        serde_json::json!({
            "injectSteps": [{
                "ephemeralMessage": handoff,
            }]
        })
    } else if agent == AgentKind::CopilotCli {
        // Copilot CLI requires the SessionStart output envelope itself, rather
        // than Claude Code's nested hookSpecificOutput shape.
        serde_json::json!({
            "additionalContext": handoff,
        })
    } else {
        serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": handoff,
            }
        })
    }
}

/// Run a single hook end-to-end. Always returns Ok and always writes a JSON
/// object to stdout — a hook must never fail the agent.
///
/// `data_dir` is the resolved global `--data-dir` (if any); used to locate the
/// spool and the stored OIDC token.
pub async fn run(data_dir: Option<PathBuf>, args: HookArgs) -> anyhow::Result<()> {
    let mut payload = String::new();
    std::io::stdin().read_to_string(&mut payload).ok();
    let mut stdout = std::io::stdout();
    run_with_payload(
        data_dir,
        args,
        payload,
        &mut stdout,
        spawn_background_drainer,
    )
    .await
}

/// [`run`] with the payload and output sink injected, so tests drive the hook
/// implementation directly without stdin/stdout.
///
/// Hooks deliberately bypass the full `Config::load` (the fast-path contract
/// in `lib.rs`): an unrelated invalid config section must never fail the hook
/// or add stdout noise. The spool retry policy is the only config needed, and
/// it is loaded tolerantly — a malformed config falls back to defaults rather
/// than erroring. The process environment is captured once, here, and
/// threaded down as data.
async fn run_with_payload<W, S>(
    data_dir: Option<PathBuf>,
    args: HookArgs,
    payload: String,
    stdout: &mut W,
    spawn_background_drainer: S,
) -> anyhow::Result<()>
where
    W: std::io::Write,
    S: FnOnce(&Path, Option<&str>) -> std::io::Result<()>,
{
    let runtime_env = RuntimeEnv::from_process();
    let dd = resolve_data_dir_with(data_dir.as_deref(), &runtime_env);
    let spool_policy =
        Config::load_with_runtime_env(Some(&dd.join("config.toml")), Some(dd), runtime_env.clone())
            .unwrap_or_default();
    let max_attempts = hook_spool::MaxAttempts::new(spool_policy.hook_spool.max_attempts);
    // An empty `--server-url` means "not given": the plugin passes its unset
    // option through as "", and the install's configured server applies.
    let mut args = args;
    if args.server_url.trim().is_empty() {
        args.server_url.clone_from(&spool_policy.server_url);
    }
    let agent_kind = AgentKind::from_wire(&args.agent);
    let hook_event = HookEvent::parse(&args.event);
    // This is inherited execution context, like AI_MEMORY_RUN_ID, rather
    // than server configuration. Hooks deliberately bypass Config::load.
    let external_capture = env_lookup(CAPTURE_OWNER_ENV).is_some_and(|v| !v.trim().is_empty());
    let delivers_context = (hook_event == HookEvent::SessionStart
        && agent_kind.session_start_injects_handoff())
        || (hook_event == HookEvent::UserPrompt && agent_kind.user_prompt_injects_handoff())
        // Grok delivers the handoff on the first PostToolUse (its SessionStart /
        // UserPromptSubmit stdout is discarded); that path is context delivery
        // too, so external capture must not suppress it.
        || (hook_event == HookEvent::PostToolUse && agent_kind.post_tool_injects_handoff());
    if external_capture && !args.check_capture && !delivers_context {
        // Retiring the fallback session ID is lifecycle housekeeping, not
        // capture. Preserve it even when no event is enqueued.
        if agent_kind == AgentKind::Devin && hook_event == HookEvent::SessionEnd {
            clear_session_id(
                &resolve_data_dir_with(data_dir.as_deref(), &runtime_env),
                agent_kind,
            );
        }
        write_success_response(stdout, agent_kind, hook_event)?;
        return Ok(());
    }
    let (mut payload, mut json) = match parse_hook_payload(payload) {
        Ok(parsed) => parsed,
        Err(_) => {
            eprintln!(
                "ai-memory hook warning: could not parse event payload as JSON; nothing was captured"
            );
            write_success_response(stdout, agent_kind, hook_event)?;
            return Ok(());
        }
    };
    // Antigravity exposes PreInvocation rather than a true SessionStart. It
    // fires before every model call; invocation zero is the only startup
    // boundary. Fail closed when the documented counter is absent so a later
    // invocation can never consume a handoff intended for the next session.
    let event_admits_capture = should_process_hook_event(agent_kind, hook_event, &json)
        && !is_redundant_cursor_copy(
            agent_kind,
            &json,
            super::install_hooks::cursor_native_hooks_installed,
        )
        && !is_dropped_plugin_copy(&args, &json, env_lookup);
    if !event_admits_capture && !args.check_capture {
        write_success_response(stdout, agent_kind, hook_event)?;
        return Ok(());
    }
    // Assistant/Stop capture (#196). On an opted-in install
    // (`install-hooks --capture-assistant`), extract the assistant message,
    // sanitize + cap it, and splice the versioned `_ai_memory_assistant` marker
    // into the body. Otherwise just strip any raw assistant field defensively —
    // the field is never persisted until the server-gated opt-in accepts it.
    // Reserialize only when the JSON actually changed, so unrelated events keep
    // byte-exact spool bodies (see `native_hook_accepts_plain_and_bom_prefixed_json`).
    let capture_assistant = if args.capture_assistant {
        let transform = ai_memory_hooks::transform_for_client(&mut json, agent_kind, hook_event);
        if transform.changed {
            payload = serde_json::to_string(&json)?;
        }
        transform.captured
    } else {
        if ai_memory_hooks::strip_assistant_message_raw(&mut json) {
            payload = serde_json::to_string(&json)?;
        }
        false
    };
    if ai_memory_hooks::cap_lifecycle_body_for_client(&mut json, hook_event) {
        payload = serde_json::to_string(&json)?;
    }
    if agent_kind == AgentKind::AntigravityCli
        && ai_memory_hooks::enrich_antigravity_step_output(
            &mut json,
            hook_event,
            home_dir().as_deref(),
        )
    {
        payload = serde_json::to_string(&json)?;
    }
    let (payload_cwd, canonical_session_id) = hook_context(&args.agent, &json);
    let tool_event = is_tool_event(&args.event);
    // Some harnesses report a cwd other than where the tool ran: a subagent's
    // parent session (#932), or Hermes' own process cwd while its tools take
    // a per-call `workdir`/`path` (#1199). A recognized absolute location may
    // select that checkout, but only when every path proves the same
    // repository/marker boundary. This must precede capture policy and
    // server-profile resolution so the destination's privacy and credentials
    // remain authoritative.
    let tool_routing_cwd = payload_cwd.as_deref().and_then(|cwd| {
        tool_event
            .then(|| tool_location_routing_cwd(agent_kind, &json, cwd))
            .flatten()
    });
    if let Some(cwd) = tool_routing_cwd.as_deref()
        && let Some(object) = json.as_object_mut()
    {
        // `HookEnvelope` deliberately gives the native body cwd precedence
        // over the query fallback. Stamp the proven destination into that
        // canonical field too, or a URL-only reroute would be cosmetic.
        object.insert("cwd".into(), cwd.into());
        payload = serde_json::to_string(&json)?;
    }
    let policy_cwd = tool_routing_cwd.or(payload_cwd);
    let inspection_cwd = policy_cwd.as_deref().map(lexical_capture_cwd);
    let policy = policy_cwd.as_deref().map(capture_policy);
    let decision = policy.as_ref().filter(|_| tool_event).map(|policy| {
        let agent = AgentKind::from_wire(&args.agent);
        let inspection_cwd = inspection_cwd.as_deref().unwrap_or("");
        let decision = policy.inspect(agent, &json, inspection_cwd);
        // Another checkout's `ignore_paths` protect its files from a call
        // made here too (`cat ../other/secret.env`).
        if decision.protocol().disposition() == CaptureDisposition::Drop {
            return decision;
        }
        let own_marker = policy_cwd.as_deref().and_then(crate::marker::find_marker);
        match foreign_capture_decision(agent, &json, inspection_cwd, own_marker.as_deref()) {
            Some(foreign) => decision.stricter(foreign),
            None => decision,
        }
    });
    let dd = resolve_data_dir_with(data_dir.as_deref(), &runtime_env);
    // Precedence: an explicit flag (tests, one-off runs) wins; otherwise the
    // persisted per-install mode; otherwise the historical default.
    let capture_mode = args.capture_mode.map_or_else(
        || persisted_capture_mode(&dd),
        crate::cli::CaptureModeArg::mode,
    );
    let route = resolve_hook_route(&dd, policy_cwd.as_deref(), || std::env::current_dir().ok());
    let marker_present = marker_present(policy_cwd.as_deref());
    let routing_valid = routing_valid(policy_cwd.as_deref());
    let admits_capture = repository_admits_capture(capture_mode, marker_present);
    if args.check_capture {
        let protocol = decision.as_ref().map(|decision| decision.protocol());
        let scope = policy_cwd.as_deref().map(|cwd| {
            hook_scope(
                cwd,
                args.project_strategy
                    .and_then(crate::cli::ProjectStrategyArg::baked),
            )
        });
        let scope_resolution = match scope.as_ref() {
            None => "unavailable",
            Some(scope) if !scope.is_inspectable() => "unavailable",
            Some(scope) if scope.is_partial() => "partial",
            Some(scope) if scope.is_explicit() => "explicit",
            Some(_) => "server-derived",
        };
        let policy_admits_capture = admits_capture
            && routing_valid
            && event_admits_capture
            && !matches!(route, HookRoute::Rejected { .. })
            && scope_resolution != "partial"
            && scope_resolution != "unavailable"
            && protocol.is_none_or(|p| p.disposition() != CaptureDisposition::Drop);
        let mut output = serde_json::json!({
            "capture_mode": capture_mode,
            "marker_present": marker_present,
            "admits_capture": admits_capture && !external_capture,
            "policy_admits_capture": policy_admits_capture,
            "event_admits_capture": event_admits_capture,
            "scope": scope,
            "scope_resolution": scope_resolution,
            "version": protocol.map_or(1, |protocol| protocol.version()),
            "policy_state": protocol.map_or(PolicyState::Inactive, |protocol| protocol.policy_state()),
            "tool_family": protocol.map_or(ai_memory_hooks::ToolFamily::Unknown, |protocol| protocol.tool_family()),
            "path_count": protocol.map_or(0, |protocol| protocol.path_count()),
            "disposition": protocol.map_or(CaptureDisposition::Keep, |protocol| protocol.disposition()),
            "extraction_state": protocol.map_or(ai_memory_hooks::ExtractionState::NotApplicable, |protocol| protocol.extraction_state()),
            "server_profile": route.profile_name().map(ProfileName::as_str),
            "server_resolution": route.resolution(),
        });
        if external_capture {
            output["external_capture"] = true.into();
        }
        writeln!(stdout, "{output}")?;
        return Ok(());
    }
    // #992: a marker that selects a server profile which does not resolve
    // emits nothing — not the event, not a handoff fetch, not a backfill.
    // Delivering to the install default instead would hand one team's
    // capture to another team's server.
    let profile = match route {
        HookRoute::InstallDefault => None,
        HookRoute::Profile(resolved) => Some(resolved),
        HookRoute::Rejected { name, reason } => {
            eprintln!(
                "ai-memory hook warning: this repository's marker selects server profile {}, \
                 which was refused ({}); the event was dropped",
                name.as_ref()
                    .map_or_else(|| "<invalid>".to_owned(), |n| format!("`{n}`")),
                reason.as_str()
            );
            write_success_response(stdout, agent_kind, hook_event)?;
            return Ok(());
        }
    };
    // #446: under allowlist mode a repository that never opted in emits
    // nothing. This sits outside the `tool_event` path on purpose — `decision`
    // is `None` for UserPromptSubmit, SessionStart/End and Stop, so gating via
    // `CaptureDisposition` alone would still spool prompt text from an
    // opted-out repository while reporting it as excluded.
    if !admits_capture || !routing_valid {
        write_success_response(stdout, agent_kind, hook_event)?;
        return Ok(());
    }
    // Read before a metadata-only rewrite drops the payload's own fields.
    let subagent_payload = payload_is_subagent(&json);
    if let Some(decision) = decision {
        match decision.protocol().disposition() {
            CaptureDisposition::Drop => {
                write_success_response(stdout, agent_kind, hook_event)?;
                return Ok(());
            }
            CaptureDisposition::MetadataOnly => {
                json = metadata_only_body(
                    canonical_session_id.as_deref(),
                    policy_cwd.as_deref(),
                    &decision,
                );
                payload = serde_json::to_string(&json)?;
            }
            CaptureDisposition::Keep
                if decision.protocol().policy_state() != PolicyState::Inactive =>
            {
                if let Some(object) = json.as_object_mut() {
                    object.insert(
                        "_ai_memory_capture".into(),
                        serde_json::to_value(decision.protocol())?,
                    );
                    payload = serde_json::to_string(&json)?;
                }
            }
            CaptureDisposition::Keep => {}
        }
    }

    let qs = policy_cwd.as_deref().map_or_else(
        || {
            cwd_query_suffix(
                &args.agent,
                &json,
                args.project_strategy.and_then(|s| s.baked()),
            )
        },
        |cwd| marker_query_suffix(cwd, args.project_strategy.and_then(|s| s.baked())),
    );
    let spool = hook_spool::spool_dir(&dd);
    let session_qs = session_id_query_suffix(&dd, &args.agent, &args.event, &json);
    let managed_qs = managed_run_query_suffix();
    let hook_qs = format!("{qs}{session_qs}{managed_qs}");

    // Spool THIS event — an instant local write, never the network. The auth
    // mode is decided without a round-trip: an explicit `--auth-token` is
    // stored inline; otherwise a present OIDC token marks the event `oidc`
    // (resolved + refreshed at drain time); otherwise anonymous.
    // #552: the bearer is no longer rendered onto the hook's command line, so
    // fall back to the copy `install-hooks --apply` persisted under the data
    // dir. An explicit `--auth-token` still wins, which keeps every config
    // written before this change working exactly as it did.
    let persisted_token = crate::config::read_hook_auth_token(&dd);
    let install_token = args.auth_token.as_deref().or(persisted_token.as_deref());
    // A profile carries its own URL and token and never falls back to the
    // install's credentials or to OIDC: `auth.json` belongs to the install
    // default, and presenting it to a profile's server would leak it across
    // servers.
    let (base, effective_token, profile_name) = match &profile {
        Some(profile) => (
            profile.url.as_str(),
            Some(profile.token.as_str()),
            Some(profile.name.as_str()),
        ),
        None => (args.server_url.trim_end_matches('/'), install_token, None),
    };

    let oidc_present = effective_token.is_none()
        && OidcToken::load(&dd.join("auth.json"))
            .ok()
            .flatten()
            .is_some();
    // Append the opt-in capture flag outside the marker query so the server can
    // gate on it (#196). Only present when a valid protocol was actually spliced
    // into this event's body, so the flag and the marker always travel together.
    let capture_qs = if capture_assistant {
        "&capture_assistant=1"
    } else {
        ""
    };
    // Idempotency key: minted ONCE here and baked into the spooled URL, so
    // every retry of this entry re-sends the same key. The server claims it
    // atomically with the observation row and skips replays whose previous
    // delivery succeeded but whose response was lost — closing the
    // conservative-retry duplication vector. Older servers ignore the param.
    if !external_capture {
        let ingest_key = uuid::Uuid::new_v4().simple().to_string();
        let event_url = format!(
            "{base}/hook?event={}&agent={}{}{}&ingest_key={ingest_key}",
            args.event, args.agent, hook_qs, capture_qs
        );
        let entry =
            hook_spool::entry_for(event_url, payload.clone(), effective_token, oidc_present)
                .routed_to(profile_name);
        if hook_spool::enqueue_with_config(&spool, &entry, Some(&spool_policy)).is_err() {
            eprintln!(
                "ai-memory hook warning: failed to spool lifecycle event; capture for this event was skipped"
            );
        }
        // ZCode is intentionally absent here: it has no SessionEnd and fires Stop
        // per turn, so its stored id is cleared by `finalize-session` (or
        // overwritten by the next session-start), never by a hook event.
        if AgentKind::from_wire(&args.agent) == AgentKind::Devin && args.event == "session-end" {
            clear_session_id(&dd, AgentKind::Devin);
        }

        // Mid-session catch-up: per-event hooks only enqueue, so a heavy session
        // outpaces the boundary-only drain and the spool grows until the next
        // boundary. On `post-tool-use`, once the backlog crosses the threshold, do a
        // tightly time-boxed drain (budget == per-event timeout, sub-second) so the
        // spool stays flat without ever stalling a tool call.
        if should_incremental_drain(
            &args.event,
            hook_spool::spool_len(&spool),
            incremental_drain_threshold(),
        ) {
            let _ = hook_spool::drain_exclusive(
                &spool,
                &dd,
                INCREMENTAL_DRAIN_BUDGET,
                INCREMENTAL_DRAIN_BUDGET,
                hook_spool::DrainLockWait::NoWait,
                max_attempts,
            )
            .await;
        }

        // session-start: if this checkout has never had the one-time boot backfill
        // attempted, spawn it detached. It self-gates (config opt-out, empty-store
        // check) and records the attempt, so this is at most one extra process the
        // first time a project is opened after installing hooks — never inline, so
        // the SessionStart budget is untouched. Best-effort; a spawn failure must
        // not affect session start.
        if args.event == "session-start"
            && let Ok(trigger_cwd) = std::env::current_dir()
            && !super::backfill::sentinel_path(&dd, &trigger_cwd).exists()
        {
            let target = match profile_name {
                Some(name) => hook_drain_process::BackfillTarget::Profile(name),
                None => hook_drain_process::BackfillTarget::ServerUrl(base),
            };
            let _ = hook_drain_process::spawn_backfill(&dd, target);
        }
    }

    // session-start: drain any backlog (e.g. from a previous session that ended
    // abruptly), then fetch + inject the pending handoff for the resuming agent.
    if args.event == "session-start" {
        if !external_capture {
            let _ = hook_spool::drain_exclusive_within_budget(
                &spool,
                &dd,
                start_drain_budget(),
                drain_event_timeout(),
                max_attempts,
            )
            .await;
        }
        // Only fetch the handoff for agents that inject the session-start
        // hook's stdout as context. Grok ignores it, so fetching here would
        // consume the handoff server-side (the GET is destructive) and then
        // discard the result — silently losing it. Those agents recover the
        // handoff on demand via the MCP `memory_handoff_accept` tool.
        if agent_kind.session_start_injects_handoff() {
            let client = build_client();
            let bearer = hook_spool::resolve_bearer(&client, &dd, effective_token).await;
            let native_session_qs = canonical_session_id.as_deref().map_or_else(
                || session_qs.clone(),
                |session_id| format!("&session_id={}", url_encode(session_id)),
            );
            let handoff_url = format!(
                "{base}/handoff?agent={}{qs}{managed_qs}{native_session_qs}",
                args.agent
            );
            if let Some(handoff) =
                get_handoff(&client, &handoff_url, bearer.as_deref(), handoff_timeout()).await
            {
                if agent_kind == AgentKind::KiroCli {
                    // Kiro v2/v3 consume SessionStart stdout verbatim and define
                    // no wrapper envelope.
                    writeln!(stdout, "{handoff}")?;
                } else {
                    let envelope = session_start_handoff_envelope(agent_kind, handoff);
                    writeln!(stdout, "{envelope}")?;
                }
                return Ok(());
            }
        }
    }

    // user-prompt: agents whose SessionStart stdout is discarded AND whose
    // UserPromptSubmit stdout is injected (Kimi Code) receive the handoff
    // here. Grok discards both, so it must not take this path: the GET
    // accepts the handoff. The payload carries the native session id when
    // available, so the destructive GET can also link the managed run to the
    // native session, same as session-start does.
    // The installed kimi hook passes the script stem (`user-prompt-submit`)
    // while the legacy shell path posts `user-prompt`; HookEvent::parse
    // canonicalizes both (and the snake/native spellings) to UserPrompt.
    if HookEvent::parse(&args.event) == HookEvent::UserPrompt
        && AgentKind::from_wire(&args.agent).user_prompt_injects_handoff()
    {
        let client = build_client();
        let bearer = hook_spool::resolve_bearer(&client, &dd, effective_token).await;
        let native_session_qs = canonical_session_id
            .as_deref()
            .map_or_else(String::new, |session_id| {
                format!("&session_id={}", url_encode(session_id))
            });
        // Gate the `[briefing]` params to the FIRST user prompt of the
        // session: kimi has no working SessionStart injection, so the brief
        // is delivered here exactly once (parity with Claude); afterwards
        // the handoff fetch continues on every prompt — it is cheap and
        // self-limiting (empty body when nothing is pending) — but without
        // `&briefing`/`&briefing_budget`, so the server does not recompose
        // the brief per prompt. The marker survives `/clear`, so re-briefing
        // after a context clear is not supported in v1.
        let briefed_path = policy_cwd
            .as_deref()
            .filter(|cwd| marker_requests_briefing(cwd))
            .map(|_| {
                briefed_marker_path(
                    &dd,
                    &args.agent,
                    canonical_session_id.as_deref(),
                    policy_cwd.as_deref(),
                )
            });
        // The profile digest rides the first prompt the same way, gated on its
        // own marker because it is on by default rather than an opt-in.
        let profile_path = profile_digest_marker_path(briefed_marker_path(
            &dd,
            &args.agent,
            canonical_session_id.as_deref(),
            policy_cwd.as_deref(),
        ));
        let profile_qs = if profile_path.is_file() {
            "&profile_digest=0"
        } else {
            ""
        };
        let handoff_qs = if briefed_path.as_ref().is_some_and(|path| path.is_file()) {
            policy_cwd
                .as_deref()
                .map(|cwd| {
                    marker_query_suffix_without_briefing(
                        cwd,
                        args.project_strategy.and_then(|s| s.baked()),
                    )
                })
                .unwrap_or_default()
        } else {
            qs.clone()
        };
        let handoff_url = format!(
            "{base}/handoff?agent={}{handoff_qs}{managed_qs}{native_session_qs}{profile_qs}",
            args.agent
        );
        let handoff =
            get_handoff(&client, &handoff_url, bearer.as_deref(), handoff_timeout()).await;
        // Mark the session as briefed only AFTER the GET completed — success
        // OR error. Fail-open on purpose: with the server down, repeating
        // the brief-flagged request on every prompt would not deliver
        // anything anyway, and the one lost brief is recovered on the next
        // session.
        if let Some(path) = briefed_path.as_deref() {
            mark_briefed(path);
        }
        mark_briefed(&profile_path);
        if let Some(handoff) = handoff {
            writeln!(stdout, "{handoff}")?;
        }
        // Never print the usual `{}` here: kimi injects any non-empty stdout
        // into the turn verbatim, so an envelope would become user-visible
        // text. Empty handoff or any fetch error means print nothing at all
        // (kimi ignores empty stdout; warnings go to stderr).
        return Ok(());
    }

    // post-tool-use: Grok shows hookSpecificOutput.additionalContext to the
    // model after the tool result. SessionStart and UserPromptSubmit stdout
    // are discarded, so this is the event that can carry a handoff without
    // burning it. One fetch per session. A session that never calls a tool
    // leaves the handoff open for memory_handoff_accept.
    if HookEvent::parse(&args.event) == HookEvent::PostToolUse
        && AgentKind::from_wire(&args.agent).post_tool_injects_handoff()
    {
        let shown = handoff_shown_path(
            &dd,
            &args.agent,
            canonical_session_id.as_deref(),
            policy_cwd.as_deref(),
        );
        if !shown.is_file() && !subagent_payload {
            let client = build_client();
            let bearer = hook_spool::resolve_bearer(&client, &dd, effective_token).await;
            let native_session_qs = canonical_session_id
                .as_deref()
                .map_or_else(String::new, |session_id| {
                    format!("&session_id={}", url_encode(session_id))
                });
            let handoff_url = format!(
                "{base}/handoff?agent={}{qs}{managed_qs}{native_session_qs}",
                args.agent
            );
            let handoff =
                get_handoff(&client, &handoff_url, bearer.as_deref(), handoff_timeout()).await;
            // Only a real body consumes this session's one chance. An empty
            // or failed claim must retry on the next parent tool; a child
            // session that errors must not burn the baton for the parent.
            if let Some(handoff) = handoff {
                mark_briefed(&shown);
                let envelope = grok_post_tool_handoff_envelope(&handoff);
                writeln!(stdout, "{envelope}")?;
                return Ok(());
            }
        }
    }

    // Boundary drain trigger: enqueue first, then ask a detached native drainer
    // to flush the shared spool. `session-end` remains the primary close path,
    // but `stop` and `pre-compact` also trigger the helper so delivery does not
    // rely on the single hook most likely to be cancelled during agent shutdown.
    if !external_capture && session_end_drains_in_process(agent_kind, &args.event) {
        drain_session_end_in_process(&spool, &dd, max_attempts).await;
    } else if !external_capture
        && should_spawn_background_drainer(&args.event)
        && let Err(err) = after_background_drain_event_enqueue(
            &dd,
            // The install's own token, resolved the same way an install-default
            // event authenticates: `--auth-token`, else the copy
            // `install-hooks --apply` persisted under the data dir (#552).
            // Current by construction either way. The drain uses it only to
            // retry an install-default entry the server has already rejected
            // with 401 (#542); a profile entry retries with its own profile's
            // token, so a profile's token is never handed over here.
            install_token,
            spawn_background_drainer,
        )
    {
        eprintln!(
            "ai-memory hook warning: failed to start background spool drainer; event remains queued: {err}"
        );
    }

    write_success_response(stdout, agent_kind, hook_event)?;
    Ok(())
}

fn parse_hook_payload(mut payload: String) -> serde_json::Result<(String, serde_json::Value)> {
    if payload.starts_with('\u{feff}') {
        payload.drain(..'\u{feff}'.len_utf8());
    }
    let json = serde_json::from_str(&payload)?;
    Ok((payload, json))
}

fn hook_context(agent: &str, raw: &serde_json::Value) -> (Option<String>, Option<String>) {
    let (cwd, session_id) = canonical_context(raw);
    if cwd.is_some() {
        return (cwd, session_id);
    }
    if AgentKind::from_wire(agent) == AgentKind::Devin {
        (
            resolve_cwd_with_fallbacks(raw, env_lookup, || std::env::current_dir().ok()),
            session_id,
        )
    } else {
        (
            extract_cwd(raw).filter(|cwd| !cwd.trim().is_empty()),
            session_id,
        )
    }
}

#[derive(Debug, PartialEq, Eq)]
struct FileRouteAnchor {
    marker: Option<PathBuf>,
    repository: Option<PathBuf>,
}

/// Find the existing directory that can establish routing for a file target.
/// New files may name one or more not-yet-created parent directories.
fn existing_target_dir(path: &Path) -> Option<PathBuf> {
    let mut candidate = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()?.to_path_buf()
    };
    loop {
        if candidate.is_dir() {
            return Some(candidate);
        }
        candidate = candidate.parent()?.to_path_buf();
    }
}

fn file_route_anchor(cwd: &Path) -> FileRouteAnchor {
    let cwd_text = cwd.to_string_lossy();
    FileRouteAnchor {
        marker: crate::marker::find_marker(&cwd_text),
        repository: ai_memory_consolidate::discover_main_repo_root(cwd).ok(),
    }
}

/// Pick a destination cwd only when a tool call's absolute location (file
/// targets, a search directory, a shell `workdir`) proves a single
/// repository/marker boundary different from the payload cwd, and the payload
/// cwd's own capture policy would keep the event.
///
/// The second condition keeps a reroute from escaping the source's
/// `ignore_paths`: patterns may name paths outside the source checkout
/// (`~/vault/**`, an absolute path), and a shell command's arguments may name
/// source files while its `workdir` points elsewhere. Without a reroute the
/// event stays with the payload cwd, whose policy then drops it exactly as it
/// would have before any rerouting existed.
pub(crate) fn tool_location_routing_cwd(
    agent: AgentKind,
    raw: &serde_json::Value,
    payload_cwd: &str,
) -> Option<String> {
    let paths = absolute_tool_location_paths(agent, raw, payload_cwd)?;
    let source_dir = existing_target_dir(Path::new(payload_cwd))?;
    let source_anchor = file_route_anchor(&source_dir);
    let mut selected: Option<(FileRouteAnchor, PathBuf)> = None;
    for path in paths {
        let dir = existing_target_dir(Path::new(&path))?;
        let anchor = file_route_anchor(&dir);
        // An arbitrary absolute path is not a project and must not mint a new
        // scope merely because a file tool happened to inspect it.
        if anchor.marker.is_none() && anchor.repository.is_none() {
            return None;
        }
        match &selected {
            Some((expected, _)) if *expected != anchor => return None,
            Some(_) => {}
            None => selected = Some((anchor, dir)),
        }
    }
    let (target_anchor, dir) = selected?;
    if target_anchor == source_anchor {
        return None;
    }
    let source_keeps = capture_policy(payload_cwd)
        .inspect(agent, raw, &lexical_capture_cwd(payload_cwd))
        .protocol()
        .disposition()
        == CaptureDisposition::Keep;
    source_keeps.then(|| dir.to_string_lossy().into_owned())
}

/// How many markers other than the event's own one tool call may make
/// [`foreign_capture_decision`] apply.
const MAX_FOREIGN_MARKERS: usize = 16;
/// How many directories, and directory entries read, following the glob
/// syntax of one tool call's locations may cost, and how long: a hook has
/// about 200 ms in all.
const MAX_GLOB_DIRECTORIES: usize = 256;
const MAX_GLOB_ENTRIES: usize = 32_768;
const MAX_GLOB_TIME: Duration = Duration::from_millis(50);
/// How many filesystem probes looking up the markers of one call's locations
/// may cost; each directory's marker is found once ([`MarkerMemo`]), so only
/// a tree built to be deep and wide reaches it.
///
/// [`MarkerMemo`]: crate::marker::MarkerMemo
const MAX_LOOKUP_PROBES: usize = 16_384;

/// The stricter decision of every other marker that governs a location the
/// tool call names: a file-tool target, or a path a shell argument spells,
/// resolved from the event's `cwd`. A checkout's `ignore_paths` must hold
/// when the call is made from another checkout or an unmarked directory
/// (`cat ../a/secret.env`), so each such marker's policy inspects the call
/// as the event's own does. `None` when no other marker governs one.
///
/// Markers are found by the same lexical walk as the event's (no
/// canonicalization), from the nearest existing directory of each location,
/// with each directory's answer remembered for every lookup that passes it
/// ([`MarkerMemo`]), so a deep tree costs one probe per directory. A location
/// with glob syntax ([`glob_walk`]) is looked up from its literal root first,
/// and, when that root lies outside the event's own checkout, every directory the
/// glob could pass through below the root is checked for a marker of its
/// own: each glob segment lists the child directories (never following a
/// symlink), and a `**` lists the whole subtree except the own checkout's. A
/// glob rooted inside the event's own checkout is not walked, so a monorepo's
/// `packages/*/x` costs nothing; a checkout nested inside the event's own is
/// not reached through one. The own checkout is the nearest `.git` root of
/// the cwd unless that is the filesystem root or lies at or above the home
/// directory ([`own_checkout`]).
///
/// The walk and the lookups share one budget of time, directories, entries
/// and probes. Locations outside the own checkout come first: there a call
/// naming more locations or markers than the bounds, a walk or lookup past
/// the budget, glob syntax the walk cannot follow, or locations that cannot
/// be read is unprovable and gets the fail-closed decision of an invalid
/// policy. Inside the own checkout the own policy governs, so running out of
/// budget there ends the lookup without failing closed.
///
/// [`MarkerMemo`]: crate::marker::MarkerMemo
pub(crate) fn foreign_capture_decision(
    agent: AgentKind,
    raw: &serde_json::Value,
    inspection_cwd: &str,
    own_marker: Option<&Path>,
) -> Option<CaptureDecision> {
    foreign_decision_within(
        agent,
        raw,
        inspection_cwd,
        own_marker,
        home_dir().as_deref(),
        || GlobBudget::new(MAX_GLOB_TIME),
    )
}

/// [`foreign_capture_decision`] with the home directory and the budget given;
/// the budget is made once the event's own lookups are done.
fn foreign_decision_within(
    agent: AgentKind,
    raw: &serde_json::Value,
    inspection_cwd: &str,
    own_marker: Option<&Path>,
    home: Option<&Path>,
    budget: impl FnOnce() -> GlobBudget,
) -> Option<CaptureDecision> {
    let unprovable = || {
        Some(
            CapturePolicy::resolve(CaptureSource::Invalid, inspection_cwd, None).inspect(
                agent,
                raw,
                inspection_cwd,
            ),
        )
    };
    let Some(locations) =
        capture_lookup_locations(agent, raw, inspection_cwd, home.and_then(Path::to_str))
    else {
        return unprovable();
    };
    let mut markers: Vec<PathBuf> = Vec::new();
    let mut memo = crate::marker::MarkerMemo::with_home(home);
    // The event's own lookups already paid for these, outside the budget; a
    // location below the cwd then stops at it.
    let cwd = Path::new(inspection_cwd);
    let checkout = memo
        .checkout_root(cwd, &mut || Some(()))
        .flatten()
        .filter(|root| own_checkout(root, home));
    memo.remember(cwd, own_marker);
    if cwd.is_dir() {
        memo.note_directory(cwd);
    }
    let mut walk = budget();
    // Locations outside the own checkout first: there another checkout's
    // policy may apply, so running out of budget there is unprovable, and a
    // long list inside the checkout must not spend it first. Inside it the
    // own policy governs, as for a glob rooted there; a marker nested in it
    // is found while the budget lasts, the shallowest locations first.
    let (outside, mut inside): (Vec<String>, Vec<String>) =
        locations.into_iter().partition(|location| {
            checkout
                .as_deref()
                .is_none_or(|checkout| !Path::new(location).starts_with(checkout))
        });
    inside.sort_by_key(|location| Path::new(location).components().count());
    let inside_from = outside.len();
    for (index, location) in outside.into_iter().chain(inside).enumerate() {
        // Past a bound, a location inside the own checkout ends the lookup;
        // one outside it is unprovable.
        let exhausted = || {
            if index >= inside_from {
                None
            } else {
                Some(unprovable())
            }
        };
        let (lookup, steps) = match glob_walk(&location) {
            GlobWalk::Literal => (location, None),
            GlobWalk::Unprovable => return unprovable(),
            GlobWalk::Walk { root, steps } => (root, Some(steps)),
        };
        // The literal root's marker first: a few probes, before a directory
        // listing that may spend the rest of the time budget on its own.
        let Some(dir) = memo.existing_dir(Path::new(&lookup), &mut || walk.probe()) else {
            match exhausted() {
                Some(decision) => return decision,
                None => break,
            }
        };
        let marker = match dir {
            Some(dir) => {
                let Some(marker) = memo.find_marker(&dir, &mut || walk.probe()) else {
                    match exhausted() {
                        Some(decision) => return decision,
                        None => break,
                    }
                };
                marker
            }
            None => None,
        };
        let below = match steps {
            Some(steps) => {
                let Some(found) =
                    walk.markers_below(Path::new(&lookup), &steps, checkout.as_deref())
                else {
                    return unprovable();
                };
                found
            }
            None => Vec::new(),
        };
        for marker in marker.into_iter().chain(below) {
            if Some(marker.as_path()) == own_marker || markers.contains(&marker) {
                continue;
            }
            if markers.len() == MAX_FOREIGN_MARKERS {
                return unprovable();
            }
            markers.push(marker);
        }
    }
    markers
        .iter()
        .map(|marker| {
            marker_capture_policy(marker, inspection_cwd).inspect(agent, raw, inspection_cwd)
        })
        .reduce(CaptureDecision::stricter)
}

/// Whether a checkout root counts as the event's own for the rules that a
/// glob rooted inside it is not walked and that its locations come last:
/// not the filesystem root, and not at or above the home directory (a
/// dotfiles repository in `$HOME` would otherwise make every other checkout
/// under it "own"). It still counts as a checkout for marker lookups.
fn own_checkout(root: &Path, home: Option<&Path>) -> bool {
    let home = home.map(crate::marker::absolute_normalized);
    root.parent().is_some() && !home.is_some_and(|home| home.starts_with(root))
}

/// What following one call's glob locations and looking up their markers
/// has cost so far.
struct GlobBudget {
    directories: usize,
    entries: usize,
    probes: usize,
    /// Time spent since the walk started; injectable so a test can stand in
    /// for a slow filesystem.
    elapsed: Box<dyn FnMut() -> Duration>,
    limit: Duration,
}

impl GlobBudget {
    fn new(limit: Duration) -> Self {
        let started = std::time::Instant::now();
        Self::with_clock(limit, Box::new(move || started.elapsed()))
    }

    fn with_clock(limit: Duration, elapsed: Box<dyn FnMut() -> Duration>) -> Self {
        Self {
            directories: 0,
            entries: 0,
            probes: 0,
            elapsed,
            limit,
        }
    }

    /// Counts one more filesystem probe of the marker lookup; `None` past
    /// [`MAX_LOOKUP_PROBES`] or the time budget the walk shares.
    fn probe(&mut self) -> Option<()> {
        self.probes += 1;
        (self.probes <= MAX_LOOKUP_PROBES && (self.elapsed)() <= self.limit).then_some(())
    }

    /// Counts one more directory the glob reaches; `None` past the bound.
    fn reach(&mut self) -> Option<()> {
        self.directories += 1;
        (self.directories <= MAX_GLOB_DIRECTORIES).then_some(())
    }

    /// The marker files of every directory `steps` can reach below `root`,
    /// `root` itself excluded (its lookup is the caller's). Nothing when
    /// `root` lies inside the event's own `checkout`, and a `**` lists
    /// nothing inside it. `None` past the bounds.
    /// A step that reaches no directory ends the walk: the glob then matches
    /// nothing there.
    fn markers_below(
        &mut self,
        root: &Path,
        steps: &[GlobStep],
        checkout: Option<&Path>,
    ) -> Option<Vec<PathBuf>> {
        let mut found = Vec::new();
        if checkout.is_some_and(|checkout| root.starts_with(checkout)) {
            return Some(found);
        }
        let mut current = vec![root.to_path_buf()];
        for step in steps {
            let mut next = Vec::new();
            for dir in &current {
                match step {
                    GlobStep::Named(name) => {
                        let child = dir.join(name);
                        if child.is_dir() {
                            next.push(child);
                        }
                    }
                    GlobStep::Matching(segment) => {
                        next.extend(self.child_directories(dir)?.into_iter().filter(|child| {
                            child.file_name().is_some_and(|name| {
                                glob_segment_matches(segment, &name.to_string_lossy())
                            })
                        }))
                    }
                    GlobStep::Any => next.extend(self.child_directories(dir)?),
                    GlobStep::AnyDepth => {
                        if checkout.is_some_and(|checkout| dir.starts_with(checkout)) {
                            continue;
                        }
                        // Counted as listed: a deep tree must not cost a
                        // full listing before the bound applies. The own
                        // checkout's subtree is skipped, as a glob rooted
                        // in it is.
                        let outside = |path: &PathBuf| {
                            checkout.is_none_or(|checkout| !path.starts_with(checkout))
                        };
                        let mut pending: Vec<PathBuf> = self
                            .child_directories(dir)?
                            .into_iter()
                            .filter(outside)
                            .collect();
                        while let Some(below) = pending.pop() {
                            self.reach()?;
                            pending.extend(
                                self.child_directories(&below)?.into_iter().filter(outside),
                            );
                            next.push(below);
                        }
                    }
                }
            }
            for dir in &next {
                if !matches!(step, GlobStep::AnyDepth) {
                    self.reach()?;
                }
                let marker = dir.join(ai_memory_core::repository_identity::MARKER_FILENAME);
                if marker.is_file() {
                    found.push(marker);
                }
            }
            if next.is_empty() {
                break;
            }
            current = next;
        }
        Some(found)
    }

    /// The child directories of `dir`, symlinks left out. An unreadable
    /// directory has none the glob could match either.
    fn child_directories(&mut self, dir: &Path) -> Option<Vec<PathBuf>> {
        if (self.elapsed)() > self.limit {
            return None;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Some(Vec::new());
        };
        let mut children = Vec::new();
        for entry in entries {
            self.entries += 1;
            if self.entries > MAX_GLOB_ENTRIES {
                return None;
            }
            let Ok(entry) = entry else { continue };
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                children.push(entry.path());
            }
        }
        Some(children)
    }
}

/// Where one event is delivered (#992).
#[derive(Debug)]
enum HookRoute {
    /// No marker selects a server: the install-time `--server-url`, exactly
    /// as before profiles existed.
    InstallDefault,
    /// The marker's profile resolved; its URL and token replace the install's.
    Profile(ResolvedServer),
    /// The marker selects a profile that did not resolve. Nothing is emitted.
    Rejected {
        /// The selected name, when it is a valid one (safe to print).
        name: Option<ProfileName>,
        reason: Rejection,
    },
}

impl HookRoute {
    fn profile_name(&self) -> Option<&ProfileName> {
        match self {
            Self::InstallDefault => None,
            Self::Profile(resolved) => Some(&resolved.name),
            Self::Rejected { name, .. } => name.as_ref(),
        }
    }

    /// Label for `--check-capture`. Never a URL, path, or token.
    fn resolution(&self) -> &'static str {
        match self {
            Self::InstallDefault => "install-default",
            Self::Profile(_) => "marker",
            Self::Rejected { reason, .. } => reason.as_str(),
        }
    }
}

/// Resolve the route for one event.
///
/// The payload's cwd decides; when the payload carries none, the hook
/// process's own cwd does (the agent launches hooks in its workspace). An
/// event without a payload cwd must not escape a profile-routed tree to the
/// install default merely because the harness omitted the field.
fn resolve_hook_route(
    data_dir: &Path,
    policy_cwd: Option<&str>,
    process_cwd: impl FnOnce() -> Option<PathBuf>,
) -> HookRoute {
    let home = super::path_util::home_dir();
    let cwd = policy_cwd
        .map(str::to_owned)
        .or_else(|| process_cwd().map(|dir| dir.to_string_lossy().into_owned()));
    let Some(selection) = cwd
        .as_deref()
        .and_then(|cwd| crate::marker::find_server_selection(cwd, home.as_deref()))
    else {
        return HookRoute::InstallDefault;
    };
    let Some(raw_name) = selection.name else {
        return HookRoute::Rejected {
            name: None,
            reason: Rejection::UnreadableMarker,
        };
    };
    match server_profiles::resolve(data_dir, &raw_name, &selection.marker_dir, home.as_deref()) {
        Ok(resolved) => HookRoute::Profile(resolved),
        Err(reason) => HookRoute::Rejected {
            name: ProfileName::parse(&raw_name),
            reason,
        },
    }
}

/// Whether the live hook would deliver events from `destination` to the same
/// server as events from `source`, resolving each like [`resolve_hook_route`].
/// A refused selection on either side delivers nowhere, so it never matches.
/// A transcript import posts everything to one endpoint, so an event the hook
/// would send elsewhere must not ride along.
pub(crate) fn delivers_to_same_server(data_dir: &Path, source: &str, destination: &str) -> bool {
    match (
        resolve_hook_route(data_dir, Some(source), || None),
        resolve_hook_route(data_dir, Some(destination), || None),
    ) {
        (HookRoute::InstallDefault, HookRoute::InstallDefault) => true,
        (HookRoute::Profile(source), HookRoute::Profile(destination)) => source == destination,
        _ => false,
    }
}

/// Whether the live hook would file events from `destination` under the same
/// project as events from `source`. Both must send the same routing hints
/// ([`hook_scope`]). When those hints name no project or identity, the server
/// derives one from the cwd itself. Under the default `basename` strategy it
/// names the project after the cwd's own folder, and a cwd below a project
/// anchored at its repository root (one first seen at that root) joins that
/// project: the two agree in the same directory, or when `source` is the
/// root of the repository and marker boundary `destination` lies in. Two
/// subdirectories of one repository are two projects. Under `repo-root` it
/// matches the cwd to the project that owns the enclosing repository: the
/// two then agree inside one repository and marker boundary, or, outside any
/// repository, in the same directory.
/// A transcript import posts every event under one project, so an event the
/// hook would file under another project must not ride along.
pub(crate) fn routes_to_same_project(source: &str, destination: &str) -> bool {
    routes_to_same_project_with(source, destination, |cwd| hook_scope(cwd, None))
}

fn routes_to_same_project_with(
    source: &str,
    destination: &str,
    scope_of: impl Fn(&str) -> HookScope,
) -> bool {
    let scope = scope_of(source);
    if scope != scope_of(destination) {
        return false;
    }
    if scope.names_the_project() {
        return true;
    }
    let (source_dir, destination_dir) = (
        lexical_capture_cwd(source),
        lexical_capture_cwd(destination),
    );
    if source_dir == destination_dir {
        return true;
    }
    let anchor = |cwd: &str| existing_target_dir(Path::new(cwd)).map(|dir| file_route_anchor(&dir));
    let same_repository = || match (anchor(source), anchor(destination)) {
        (Some(source), Some(destination)) => source.repository.is_some() && source == destination,
        _ => false,
    };
    if scope.derives_from_repo_root() {
        return same_repository();
    }
    let source_dir = Path::new(&source_dir);
    Path::new(&destination_dir).starts_with(source_dir)
        && crate::marker::checkout_root(source_dir).as_deref() == Some(source_dir)
        && same_repository()
}

/// Normalize the raw hook `cwd` into the base `policy.inspect` joins a tool
/// event's relative candidate path onto — lexically, via
/// `marker::absolute_normalized`, NOT `fs::canonicalize` (#671).
///
/// `capture_policy(policy_cwd)` resolves `[capture] ignore_paths` against a
/// marker directory that is itself lexically normalized (never symlink- or
/// verbatim-prefix-resolved). Canonicalizing only this side used to resolve
/// a symlinked cwd to its real target while the marker directory stayed at
/// the symlinked path, so a relative candidate (joined onto the
/// canonicalized cwd) and the marker's `ignore_paths` directory_base ended
/// up in two different path namespaces and never matched
/// (`capture_drop_handles_symlinked_cwd` regressed this way). Normalizing
/// both sides with the same lexical function — instead of resolving either
/// against the filesystem — keeps them in one namespace on every platform,
/// including for a candidate file that doesn't exist on disk (canonicalize
/// would `Err` on that and silently fall back to the raw, un-normalized
/// cwd).
pub(crate) fn lexical_capture_cwd(cwd: &str) -> String {
    crate::marker::absolute_normalized(Path::new(cwd))
        .into_os_string()
        .into_string()
        .unwrap_or_else(|_| cwd.to_owned())
}

/// File under the data dir holding the per-install capture mode (#446).
///
/// Deliberately a standalone file rather than a flag baked into each agent's
/// hook command: the mode then covers every agent and every render path at
/// once, and `install-hooks --apply` cannot regenerate it away. The reporter's
/// binding requirement was that the protection survive an upgrade — here it
/// does so by construction rather than by preservation logic that a new render
/// path could forget.
pub(crate) const CAPTURE_MODE_FILE: &str = "capture-mode";

/// Marker presence is the opt-in signal under allowlist mode. Resolved from
/// the same upward walk the policy uses, so opting in needs no new file.
fn marker_present(cwd: Option<&str>) -> bool {
    cwd.is_some_and(|cwd| crate::marker::find_marker(cwd).is_some())
}

/// An unreadable routing marker emits nothing rather than guess a scope.
fn routing_valid(cwd: Option<&str>) -> bool {
    cwd.is_none_or(|cwd| crate::marker::routing_selection(cwd).is_ok())
}

/// The hook's repository admission gate (#446) for a transcript import from
/// the checkout at `cwd`: this install's persisted capture mode, the marker
/// opt-in, and a readable routing marker. `backfill` and the `ai-memory run`
/// ledger import nothing — prompts included — from a checkout the live hook
/// would emit nothing for.
pub(crate) fn checkout_admits_capture(data_dir: &Path, cwd: &str) -> bool {
    repository_admits_capture(persisted_capture_mode(data_dir), marker_present(Some(cwd)))
        && routing_valid(Some(cwd))
}

/// Read the persisted capture mode. Anything unreadable, absent, or
/// unrecognised means the historical default: this file can only ever tighten
/// capture, never silently loosen it below what the operator already had.
fn persisted_capture_mode(data_dir: &Path) -> CaptureMode {
    match std::fs::read_to_string(data_dir.join(CAPTURE_MODE_FILE)) {
        Ok(text) if text.trim().eq_ignore_ascii_case("allowlist") => CaptureMode::Allowlist,
        _ => CaptureMode::Denylist,
    }
}

/// Whether this install's capture mode admits a checkout at `cwd`: the same
/// gate a live hook applies, for callers that replay events outside a hook
/// (`finalize-session`).
pub(crate) fn admits_capture_at(data_dir: &Path, cwd: &Path) -> bool {
    let marker_present = crate::marker::find_marker(&cwd.to_string_lossy()).is_some();
    repository_admits_capture(persisted_capture_mode(data_dir), marker_present)
}

fn is_tool_event(event: &str) -> bool {
    matches!(
        event.to_ascii_lowercase().replace(['-', '_'], "").as_str(),
        "pretooluse" | "posttooluse" | "tooluse"
    )
}

/// Resolve the data dir for tests that exercise the hook implementation
/// directly: explicit `--data-dir`, then the captured runtime environment, then
/// the platform local-data directory.
#[cfg(test)]
fn resolve_data_dir(data_dir: Option<&Path>) -> PathBuf {
    resolve_data_dir_with(data_dir, &RuntimeEnv::from_process())
}

fn resolve_data_dir_with(data_dir: Option<&Path>, runtime_env: &RuntimeEnv) -> PathBuf {
    let dir = data_dir
        .map(Path::to_path_buf)
        .or_else(|| runtime_env.data_dir().map(Path::to_path_buf))
        .unwrap_or_else(|| {
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("ai-memory")
        });
    // Recover already-installed hooks that baked a safe verbatim data-dir form.
    match dir.to_str() {
        Some(s) if s.starts_with(r"\\?\") => {
            PathBuf::from(strip_windows_verbatim_prefix(s).into_owned())
        }
        _ => dir,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The regression this whole change exists for. `inspect` runs only for
    /// tool events, so a gate expressed through `CaptureDisposition` would
    /// leave prompt bodies spooling from a repository that never opted in —
    /// reporting it as excluded while writing the text to disk. Pin the fact
    /// that the gate is event-independent.
    #[test]
    fn allowlist_gate_covers_events_that_never_reach_capture_policy() {
        for event in ["user-prompt-submit", "session-start", "session-end", "stop"] {
            assert!(
                !is_tool_event(event),
                "{event} must not be a tool event, or this test proves nothing"
            );
        }
        // With no marker present, allowlist mode admits none of them.
        assert!(!repository_admits_capture(CaptureMode::Allowlist, false));
    }

    #[test]
    fn persisted_mode_defaults_to_denylist_when_absent() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            persisted_capture_mode(tmp.path()),
            CaptureMode::Denylist,
            "a missing file must not change existing installs"
        );
    }

    #[test]
    fn persisted_mode_reads_allowlist() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(CAPTURE_MODE_FILE), "allowlist\n").unwrap();
        assert_eq!(persisted_capture_mode(tmp.path()), CaptureMode::Allowlist);
    }

    #[test]
    fn unreadable_or_unknown_mode_falls_back_to_denylist_not_allowlist() {
        // Failing "closed" here would be a denial of service: a corrupt file
        // would silently stop all capture. Tightening is the operator's
        // explicit choice, so garbage must read as the historical default.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(CAPTURE_MODE_FILE), "\u{0}not-a-mode").unwrap();
        assert_eq!(persisted_capture_mode(tmp.path()), CaptureMode::Denylist);
    }

    #[test]
    fn admits_capture_at_applies_the_allowlist_to_unmarked_checkouts() {
        let data_dir = tempfile::tempdir().unwrap();
        let checkout = tempfile::tempdir().unwrap();
        assert!(
            admits_capture_at(data_dir.path(), checkout.path()),
            "denylist mode (the default) admits any checkout"
        );
        std::fs::write(data_dir.path().join(CAPTURE_MODE_FILE), "allowlist\n").unwrap();
        assert!(
            !admits_capture_at(data_dir.path(), checkout.path()),
            "allowlist mode admits no checkout without a marker"
        );
        std::fs::write(
            checkout.path().join(".ai-memory.toml"),
            "workspace = \"ws\"\nproject = \"proj\"\n",
        )
        .unwrap();
        assert!(admits_capture_at(data_dir.path(), checkout.path()));
    }

    /// "The server is down": a loopback endpoint that accepts and immediately
    /// closes every connection. A closed port would do, but Windows takes ~2s
    /// to report a refused loopback connect, which made every test that posts
    /// to a dead server cost 2s per request.
    fn dead_server_url() -> String {
        ai_memory_test_support::dead_http_endpoint()
    }

    fn devin_hook_args(event: &str) -> HookArgs {
        HookArgs {
            event: event.into(),
            agent: "devin".into(),
            server_url: dead_server_url(),
            auth_token: None,
            project_strategy: None,
            check_capture: false,
            capture_assistant: false,
            capture_mode: None,
        }
    }

    fn read_spooled_entries(spool: &Path) -> Vec<hook_spool::SpoolEntry> {
        let mut entries = std::fs::read_dir(spool)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
            .collect::<Vec<_>>();
        entries.sort();
        entries
            .into_iter()
            .map(|path| serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap())
            .collect()
    }

    fn query_param<'a>(url: &'a str, key: &str) -> Option<&'a str> {
        url.split('?')
            .nth(1)?
            .split('&')
            .filter_map(|part| part.split_once('='))
            .find_map(|(name, value)| (name == key).then_some(value))
    }

    #[test]
    fn resolve_data_dir_strips_verbatim_prefix_from_baked_arg() {
        // Recover safe verbatim data dirs baked by older installs (#116).
        let resolved =
            resolve_data_dir(Some(Path::new(r"\\?\C:\Users\me\AppData\Local\ai-memory")));
        assert_eq!(
            resolved,
            PathBuf::from(r"C:\Users\me\AppData\Local\ai-memory")
        );
    }

    #[test]
    fn resolve_data_dir_leaves_plain_path_untouched() {
        let resolved = resolve_data_dir(Some(Path::new(r"C:\Users\me\ai-memory")));
        assert_eq!(resolved, PathBuf::from(r"C:\Users\me\ai-memory"));
    }

    #[test]
    fn should_incremental_drain_only_post_tool_use_over_threshold() {
        assert!(should_incremental_drain("post-tool-use", 32, 32));
        assert!(should_incremental_drain("post-tool-use", 100, 32));
        // below threshold: a light session never drains mid-session
        assert!(!should_incremental_drain("post-tool-use", 31, 32));
        // other events only enqueue; boundaries do the real flush
        assert!(!should_incremental_drain("pre-tool-use", 999, 32));
        assert!(!should_incremental_drain("session-start", 999, 32));
        assert!(!should_incremental_drain("session-end", 999, 32));
        assert!(!should_incremental_drain("stop", 999, 32));
    }

    #[test]
    fn boundary_events_trigger_background_drainer() {
        assert!(should_spawn_background_drainer("session-end"));
        assert!(should_spawn_background_drainer("stop"));
        assert!(should_spawn_background_drainer("pre-compact"));

        assert!(!should_spawn_background_drainer("session-start"));
        assert!(!should_spawn_background_drainer("post-tool-use"));
        assert!(!should_spawn_background_drainer("pre-tool-use"));
        assert!(!should_spawn_background_drainer("user-prompt"));
    }

    #[test]
    fn only_zero_session_end_drains_in_process() {
        assert!(session_end_drains_in_process(
            AgentKind::Zero,
            "session-end"
        ));
        for event in ["session-start", "post-tool-use", "subagent-stop"] {
            assert!(
                !session_end_drains_in_process(AgentKind::Zero, event),
                "{event}"
            );
        }
        for agent in [AgentKind::ClaudeCode, AgentKind::Codex, AgentKind::Zcode] {
            assert!(
                !session_end_drains_in_process(agent, "session-end"),
                "{agent:?}"
            );
        }
    }

    #[test]
    fn antigravity_preinvocation_only_maps_invocation_zero_to_session_start() {
        for (raw, expected) in [
            (serde_json::json!({"invocationNum": 0}), true),
            (serde_json::json!({"invocationNum": 1}), false),
            (serde_json::json!({"invocationNum": 0.5}), false),
            (serde_json::json!({"invocationNum": "0"}), false),
            (serde_json::json!({}), false),
        ] {
            assert_eq!(
                should_process_hook_event(AgentKind::AntigravityCli, HookEvent::SessionStart, &raw,),
                expected,
                "{raw}"
            );
        }
        assert!(should_process_hook_event(
            AgentKind::ClaudeCode,
            HookEvent::SessionStart,
            &serde_json::json!({})
        ));
        assert!(should_process_hook_event(
            AgentKind::AntigravityCli,
            HookEvent::PostToolUse,
            &serde_json::json!({})
        ));
    }

    #[test]
    fn hook_success_response_is_specific_to_antigravity_pre_tool_use() {
        for (agent, event, expected) in [
            (
                AgentKind::AntigravityCli,
                HookEvent::PreToolUse,
                b"{\"decision\": \"allow\"}\n".as_slice(),
            ),
            (
                AgentKind::AntigravityCli,
                HookEvent::PostToolUse,
                b"{}\n".as_slice(),
            ),
            (
                AgentKind::ClaudeCode,
                HookEvent::PreToolUse,
                b"{}\n".as_slice(),
            ),
            (AgentKind::KiroCli, HookEvent::PreToolUse, b"".as_slice()),
            (AgentKind::KiroCli, HookEvent::SessionStart, b"".as_slice()),
            (AgentKind::KiroCli, HookEvent::UserPrompt, b"".as_slice()),
            (AgentKind::KiroCli, HookEvent::PostToolUse, b"".as_slice()),
            (AgentKind::KiroCli, HookEvent::Stop, b"".as_slice()),
        ] {
            let mut output = Vec::new();
            write_success_response(&mut output, agent, event).unwrap();
            assert_eq!(output, expected, "{agent:?} {event:?}");
        }
    }

    fn drain_report(outcome: &hook_spool::LockedDrainResult) -> String {
        let mut out = Vec::new();
        write_drain_report(&mut out, outcome).unwrap();
        String::from_utf8(out).unwrap()
    }

    /// A pass with nothing left behind says nothing, so `hook-drain.log` keeps
    /// receiving only warnings and a healthy instance never grows it.
    #[test]
    fn drain_report_is_silent_on_a_clean_pass() {
        for result in [
            hook_spool::DrainResult::default(),
            hook_spool::DrainResult {
                sent: 12,
                durable: 12,
                remaining: 0,
                dropped: 0,
            },
        ] {
            let report = drain_report(&hook_spool::LockedDrainResult::Drained(result));
            assert!(report.is_empty(), "clean pass emitted: {report}");
        }
    }

    /// The regression #493 exists for. Three passes that mean opposite things —
    /// everything delivered, everything discarded undelivered, and nothing even
    /// attempted because another drainer held the lock — used to produce the
    /// same empty output and the same exit 0, which is what left the reporter
    /// unable to tell a working drain from a silently lossy one. Pin that each
    /// one is now distinguishable from the other two.
    #[test]
    fn drain_report_separates_loss_and_contention_from_a_clean_pass() {
        let clean = drain_report(&hook_spool::LockedDrainResult::Drained(
            hook_spool::DrainResult {
                sent: 5,
                durable: 5,
                remaining: 0,
                dropped: 0,
            },
        ));
        let lossy = drain_report(&hook_spool::LockedDrainResult::Drained(
            hook_spool::DrainResult {
                sent: 0,
                durable: 0,
                remaining: 0,
                dropped: 7,
            },
        ));
        let busy = drain_report(&hook_spool::LockedDrainResult::LockBusy);

        assert!(clean.is_empty());
        assert!(
            lossy.contains("DROPPED") && lossy.contains('7'),
            "a pass that discarded 7 undelivered events must name the loss: {lossy}"
        );
        assert!(
            !busy.contains("queued"),
            "LockBusy is returned before the spool is listed, so the report must \
             not claim anything about queued events: {busy}"
        );
        assert!(
            busy.contains("lock"),
            "a contended pass must say it delivered nothing: {busy}"
        );
        assert_ne!(lossy, busy);
        assert_ne!(lossy, clean);
        assert_ne!(busy, clean);
    }

    /// Events merely still queued (server down, or the budget ran out) are a
    /// warning too — they are the state that precedes the drop — but they must
    /// not be reported as lost.
    #[test]
    fn drain_report_distinguishes_still_queued_from_dropped() {
        let report = drain_report(&hook_spool::LockedDrainResult::Drained(
            hook_spool::DrainResult {
                sent: 1,
                durable: 1,
                remaining: 4,
                dropped: 0,
            },
        ));
        assert!(report.contains("4 still queued"), "{report}");
        assert!(report.contains("0 DROPPED"), "{report}");
    }

    #[test]
    fn kiro_v3_live_lifecycle_fixtures_share_native_context() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/kiro-v3-hook-payloads.json"
        ))
        .unwrap();
        let events = fixture["events"].as_array().unwrap();
        assert_eq!(events.len(), 5);
        for event in events {
            let payload = &event["payload"];
            let (cwd, session_id) = hook_context("kiro-cli", payload);
            assert_eq!(cwd.as_deref(), Some("/workspace/project"));
            assert_eq!(session_id.as_deref(), Some("kiro-v3-session"));
        }
        assert_eq!(events[0]["payload"]["hook_event_name"], "SessionStart");
        assert_eq!(events[1]["payload"]["hook_event_name"], "UserPromptSubmit");
        assert_eq!(events[2]["payload"]["hook_event_name"], "PreToolUse");
        assert_eq!(events[3]["payload"]["hook_event_name"], "PostToolUse");
        assert_eq!(events[4]["payload"]["hook_event_name"], "Stop");
        assert_eq!(events[2]["payload"]["tool_name"], "read_file");
        assert_eq!(
            events[2]["payload"]["tool_input"]["path"],
            "/workspace/project/sample.txt"
        );
    }

    #[test]
    fn cursor_copy_via_claude_code_hooks_is_dropped_only_when_cursor_hooks_exist() {
        let cursor = serde_json::json!({
            "cursor_version": "2026.09.02-c22c1a3",
            "conversation_id": "c1",
        });
        let claude = serde_json::json!({"session_id": "s1"});
        assert!(is_redundant_cursor_copy(
            AgentKind::ClaudeCode,
            &cursor,
            || true
        ));
        // Without Cursor's own hooks the Claude Code path is the only capture.
        assert!(!is_redundant_cursor_copy(
            AgentKind::ClaudeCode,
            &cursor,
            || false
        ));
        // The native Cursor hook itself is never dropped.
        assert!(!is_redundant_cursor_copy(
            AgentKind::Cursor,
            &cursor,
            || true
        ));
        // A real Claude Code payload never consults the filesystem.
        assert!(!is_redundant_cursor_copy(
            AgentKind::ClaudeCode,
            &claude,
            || { panic!("must not check Cursor hooks for a Claude Code payload") }
        ));
    }

    #[tokio::test]
    async fn antigravity_native_pre_tool_use_allows_and_spools_valid_input() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let mut stdout = Vec::new();
        run_with_payload(
            Some(data_dir.clone()),
            antigravity_hook_args("pre-tool-use", &dead_server_url()),
            serde_json::json!({
                "conversationId": "agy-session",
                "workspacePaths": [tmp.path()],
                "toolCall": {"name": "view_file", "args": {"AbsolutePath": "README.md"}}
            })
            .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"{\"decision\": \"allow\"}\n");
        assert_eq!(hook_spool::spool_len(&hook_spool::spool_dir(&data_dir)), 1);
    }

    #[tokio::test]
    async fn antigravity_native_pre_tool_use_fails_open_on_malformed_input() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let mut stdout = Vec::new();
        run_with_payload(
            Some(data_dir.clone()),
            antigravity_hook_args("pre-tool-use", &dead_server_url()),
            "not-json".into(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"{\"decision\": \"allow\"}\n");
        assert_eq!(hook_spool::spool_len(&hook_spool::spool_dir(&data_dir)), 0);
    }

    #[test]
    fn incremental_threshold_parses_and_falls_back() {
        assert_eq!(incremental_drain_threshold_from(|_| Some("64".into())), 64);
        assert_eq!(
            incremental_drain_threshold_from(|_| None),
            DEFAULT_INCREMENTAL_THRESHOLD
        );
        // zero / non-numeric fall back to the default (a 0 threshold would drain
        // on every post-tool-use)
        assert_eq!(
            incremental_drain_threshold_from(|_| Some("0".into())),
            DEFAULT_INCREMENTAL_THRESHOLD
        );
        assert_eq!(
            incremental_drain_threshold_from(|_| Some("abc".into())),
            DEFAULT_INCREMENTAL_THRESHOLD
        );
    }

    #[test]
    fn parse_minutes_falls_back_on_invalid() {
        assert_eq!(
            parse_minutes(None, DEFAULT_DRAIN_TIMEOUT),
            DEFAULT_DRAIN_TIMEOUT
        );
        assert_eq!(
            parse_minutes(Some(String::new()), DEFAULT_DRAIN_TIMEOUT),
            DEFAULT_DRAIN_TIMEOUT
        );
        assert_eq!(
            parse_minutes(Some("abc".into()), DEFAULT_DRAIN_TIMEOUT),
            DEFAULT_DRAIN_TIMEOUT
        );
        // Zero is rejected (a 0-minute timeout would drop every request).
        assert_eq!(
            parse_minutes(Some("0".into()), DEFAULT_DRAIN_TIMEOUT),
            DEFAULT_DRAIN_TIMEOUT
        );
    }

    #[test]
    fn parse_minutes_honours_valid_override() {
        assert_eq!(
            parse_minutes(Some("2".into()), DEFAULT_DRAIN_TIMEOUT),
            Duration::from_secs(120)
        );
        assert_eq!(
            parse_minutes(Some("  3 ".into()), DEFAULT_DRAIN_TIMEOUT),
            Duration::from_secs(180)
        );
    }

    #[test]
    fn parse_minutes_clamps_large_values() {
        assert_eq!(
            parse_minutes(Some("999".into()), DEFAULT_DRAIN_TIMEOUT),
            Duration::from_secs(MAX_OVERRIDE_MINUTES * 60)
        );
    }

    #[test]
    fn background_drain_budget_defaults_and_clamps() {
        assert_eq!(
            background_drain_budget_from(|_| None),
            DEFAULT_BACKGROUND_DRAIN_BUDGET
        );
        assert_eq!(
            background_drain_budget_from(|_| Some("1".into())),
            Duration::from_secs(60)
        );
        assert_eq!(
            background_drain_budget_from(|_| Some("999".into())),
            Duration::from_secs(60 * 60)
        );
    }

    #[test]
    fn devin_query_session_id_is_stable_across_payloads_without_native_id() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        let session_start = serde_json::json!({
            "hook_event_name": "SessionStart",
            "source": "startup"
        });
        let post_tool_use = serde_json::json!({
            "hook_event_name": "PostToolUse",
            "tool_name": "exec",
            "tool_input": {"command": "ls"},
            "tool_use_id": "call_c101a272288d400b831e1498",
            "tool_response": {"success": true, "output": "ok", "error": null}
        });

        let first = session_id_query_suffix(data_dir, "devin", "session-start", &session_start);
        let second = session_id_query_suffix(data_dir, "devin", "post-tool-use", &post_tool_use);

        assert!(first.starts_with("&session_id="), "{first}");
        assert_eq!(second, first);
        assert_eq!(
            stored_session_id(data_dir, AgentKind::Devin).as_deref(),
            first.strip_prefix("&session_id=")
        );
    }

    #[tokio::test]
    async fn devin_session_start_real_fixture_without_session_id_or_cwd_is_accepted() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        let spool = hook_spool::spool_dir(&data_dir);
        let mut stdout = Vec::new();
        let payload = serde_json::json!({
            "hook_event_name": "SessionStart",
            "source": "startup"
        });

        run_with_payload(
            Some(data_dir),
            devin_hook_args("session-start"),
            payload.to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"{}\n");
        let entries = read_spooled_entries(&spool);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].url.contains("event=session-start"));
        assert!(entries[0].url.contains("agent=devin"));
        assert!(
            query_param(&entries[0].url, "session_id").is_some(),
            "{}",
            entries[0].url
        );
        assert!(
            query_param(&entries[0].url, "cwd").is_some(),
            "{}",
            entries[0].url
        );
    }

    #[tokio::test]
    async fn devin_generated_session_id_reaches_startup_handoff_claim() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let (base, mut requests) = serve_requests("200 OK", "DEVIN-HANDOFF").await;
        let mut args = devin_hook_args("session-start");
        args.server_url = base;
        let mut stdout = Vec::new();

        run_with_payload(
            Some(data_dir.clone()),
            args,
            serde_json::json!({
                "hook_event_name": "SessionStart",
                "source": "startup"
            })
            .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        let mut recorded = Vec::new();
        while let Some(request) = first_request(&mut requests).await {
            recorded.push(request);
        }
        assert!(
            recorded
                .iter()
                .any(|request| request.starts_with("POST /hook")),
            "session start must be posted: {recorded:?}"
        );
        let get = recorded
            .iter()
            .find(|request| request.starts_with("GET /handoff?"))
            .expect("startup handoff must be fetched");
        let request_param = |request: &str| {
            request
                .split_whitespace()
                .nth(1)
                .and_then(|target| query_param(target, "session_id"))
                .map(str::to_owned)
        };
        assert_eq!(
            request_param(get).as_deref(),
            stored_session_id(&data_dir, AgentKind::Devin).as_deref(),
            "the destructive startup claim must use the generated receiver id: {recorded:?}"
        );
    }

    #[tokio::test]
    async fn devin_post_tool_use_real_fixture_without_session_id_or_cwd_is_accepted() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        let spool = hook_spool::spool_dir(&data_dir);
        let mut stdout = Vec::new();
        let payload = serde_json::json!({
            "hook_event_name": "PostToolUse",
            "tool_name": "exec",
            "tool_input": {"command": "ls"},
            "tool_use_id": "call_c101a272288d400b831e1498",
            "tool_response": {"success": true, "output": "ok", "error": null}
        });

        run_with_payload(
            Some(data_dir),
            devin_hook_args("post-tool-use"),
            payload.to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"{}\n");
        let entries = read_spooled_entries(&spool);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].url.contains("event=post-tool-use"));
        assert!(entries[0].url.contains("agent=devin"));
        assert!(
            query_param(&entries[0].url, "session_id").is_some(),
            "{}",
            entries[0].url
        );
        assert!(
            query_param(&entries[0].url, "cwd").is_some(),
            "{}",
            entries[0].url
        );
    }

    #[tokio::test]
    async fn devin_events_share_session_id_when_payload_omits_it() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        let spool = hook_spool::spool_dir(&data_dir);
        let mut stdout = Vec::new();

        run_with_payload(
            Some(data_dir.clone()),
            devin_hook_args("session-start"),
            serde_json::json!({
                "hook_event_name": "SessionStart",
                "source": "startup"
            })
            .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        run_with_payload(
            Some(data_dir),
            devin_hook_args("post-tool-use"),
            serde_json::json!({
                "hook_event_name": "PostToolUse",
                "tool_name": "exec",
                "tool_input": {"command": "ls"},
                "tool_use_id": "call_c101a272288d400b831e1498",
                "tool_response": {"success": true, "output": "ok", "error": null}
            })
            .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        let entries = read_spooled_entries(&spool);
        assert_eq!(entries.len(), 2);
        let first = query_param(&entries[0].url, "session_id").unwrap();
        let second = query_param(&entries[1].url, "session_id").unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn devin_query_session_id_does_not_override_native_payload_id() {
        let tmp = tempfile::tempdir().unwrap();
        let with_session = serde_json::json!({
            "session_id": "native-session",
            "hook_event_name": "PostToolUse"
        });

        let suffix = session_id_query_suffix(tmp.path(), "devin", "post-tool-use", &with_session);

        assert!(suffix.is_empty());
        assert!(stored_session_id(tmp.path(), AgentKind::Devin).is_none());
    }

    #[test]
    fn session_id_query_suffix_is_opt_in_per_agent() {
        let tmp = tempfile::tempdir().unwrap();
        let raw = serde_json::json!({"hook_event_name": "PostToolUse"});

        let suffix = session_id_query_suffix(tmp.path(), "claude-code", "post-tool-use", &raw);

        assert!(suffix.is_empty());
        assert!(stored_session_id(tmp.path(), AgentKind::ClaudeCode).is_none());
    }

    #[test]
    fn zcode_query_session_id_is_stable_across_turns_without_native_id() {
        // ZCode fires Stop at the end of every turn and has no SessionEnd; the
        // stored id must survive Stop so one agent session maps to one
        // server-side session.
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        let bare = serde_json::json!({"hook_event_name": "SessionStart"});

        let first = session_id_query_suffix(data_dir, "zcode", "session-start", &bare);
        let after_stop = session_id_query_suffix(data_dir, "zcode", "stop", &bare);
        let next_turn = session_id_query_suffix(data_dir, "zcode", "pre-tool-use", &bare);

        assert!(first.starts_with("&session_id="), "{first}");
        assert_eq!(after_stop, first);
        assert_eq!(next_turn, first);
        assert_eq!(
            stored_session_id(data_dir, AgentKind::Zcode).as_deref(),
            first.strip_prefix("&session_id=")
        );
    }

    #[test]
    fn zcode_query_session_id_does_not_override_native_payload_id() {
        let tmp = tempfile::tempdir().unwrap();
        let with_session = serde_json::json!({
            "session_id": "zcode-native-session",
            "hook_event_name": "PostToolUse"
        });

        let suffix = session_id_query_suffix(tmp.path(), "zcode", "post-tool-use", &with_session);

        assert!(suffix.is_empty());
        assert!(stored_session_id(tmp.path(), AgentKind::Zcode).is_none());
    }

    #[test]
    fn zcode_stop_event_does_not_clear_stored_session_id() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path();
        store_session_id(data_dir, AgentKind::Zcode, "stable-zcode-session");

        // The only hook-side clearing is Devin's session-end; ZCode's stored
        // id is cleared by `finalize-session` (or overwritten by the next
        // session-start), never by Stop.
        let bare = serde_json::json!({"hook_event_name": "Stop"});
        let _ = session_id_query_suffix(data_dir, "zcode", "stop", &bare);

        assert_eq!(
            stored_session_id(data_dir, AgentKind::Zcode).as_deref(),
            Some("stable-zcode-session")
        );
    }

    #[test]
    fn devin_missing_cwd_uses_devin_project_dir_before_process_cwd() {
        let raw = serde_json::json!({
            "hook_event_name": "SessionStart",
            "source": "startup"
        });

        let cwd = resolve_hook_cwd_with(
            "devin",
            &raw,
            |name| (name == "DEVIN_PROJECT_DIR").then(|| "env-project".into()),
            || Some(PathBuf::from("process-project")),
        );

        assert_eq!(cwd.as_deref(), Some("env-project"));
    }

    #[test]
    fn devin_missing_cwd_uses_process_cwd_when_env_is_missing() {
        let raw = serde_json::json!({
            "hook_event_name": "PostToolUse",
            "tool_name": "exec"
        });

        let cwd = resolve_hook_cwd_with(
            "devin",
            &raw,
            |_| None,
            || Some(PathBuf::from("process-project")),
        );

        assert_eq!(cwd.as_deref(), Some("process-project"));
    }

    #[test]
    fn devin_missing_cwd_uses_env_or_process_cwd() {
        let raw = serde_json::json!({
            "hook_event_name": "PostToolUse",
            "tool_name": "exec"
        });

        let from_env = resolve_hook_cwd_with(
            "devin",
            &raw,
            |name| (name == "DEVIN_PROJECT_DIR").then(|| "env-project".into()),
            || Some(PathBuf::from("process-project")),
        );
        let from_process = resolve_hook_cwd_with(
            "devin",
            &raw,
            |_| None,
            || Some(PathBuf::from("process-project")),
        );

        assert_eq!(from_env.as_deref(), Some("env-project"));
        assert_eq!(from_process.as_deref(), Some("process-project"));
    }

    #[test]
    fn devin_payload_cwd_wins_over_fallbacks() {
        let raw = serde_json::json!({
            "hook_event_name": "PostToolUse",
            "cwd": "payload-project"
        });

        let cwd = resolve_hook_cwd_with(
            "devin",
            &raw,
            |name| (name == "DEVIN_PROJECT_DIR").then(|| "env-project".into()),
            || Some(PathBuf::from("process-project")),
        );

        assert_eq!(cwd.as_deref(), Some("payload-project"));
    }

    #[test]
    fn missing_cwd_process_fallback_is_devin_only() {
        let raw = serde_json::json!({"hook_event_name": "PostToolUse"});

        let cwd = resolve_hook_cwd_with(
            "claude-code",
            &raw,
            |_| Some("env-project".into()),
            || Some(PathBuf::from("process-project")),
        );

        assert!(cwd.is_none());
    }

    #[tokio::test]
    async fn devin_post_compaction_summary_without_payload_cwd_uses_same_session() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        let spool = hook_spool::spool_dir(&data_dir);
        let summary = "Context compacted: 15000/20000 tokens used";
        let mut stdout = Vec::new();

        run_with_payload(
            Some(data_dir.clone()),
            devin_hook_args("session-start"),
            serde_json::json!({
                "hook_event_name": "SessionStart",
                "source": "startup"
            })
            .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        run_with_payload(
            Some(data_dir),
            devin_hook_args("post-compaction"),
            serde_json::json!({
                "hook_event_name": "PostCompaction",
                "summary": summary
            })
            .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        let entries = read_spooled_entries(&spool);
        assert_eq!(entries.len(), 2);
        let first = query_param(&entries[0].url, "session_id").unwrap();
        let second = query_param(&entries[1].url, "session_id").unwrap();
        assert_eq!(first, second);
        assert!(query_param(&entries[1].url, "cwd").is_some());
        assert!(entries[1].body.contains(summary));
    }

    #[tokio::test]
    async fn session_end_run_enqueues_outputs_empty_json_and_spawns_after_enqueue() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        let spool = hook_spool::spool_dir(&data_dir);
        let called = std::cell::Cell::new(0);
        let mut stdout = Vec::new();
        let args = HookArgs {
            event: "session-end".into(),
            agent: "claude-code".into(),
            server_url: dead_server_url(),
            auth_token: None,
            project_strategy: None,
            check_capture: false,
            capture_assistant: false,
            capture_mode: None,
        };

        run_with_payload(
            Some(data_dir.clone()),
            args,
            r#"{"session_id":"s","cwd":"/tmp"}"#.into(),
            &mut stdout,
            |path, _token| {
                assert_eq!(path, data_dir.as_path());
                assert_eq!(hook_spool::spool_len(&spool), 1, "spawn runs after enqueue");
                called.set(called.get() + 1);
                Ok(())
            },
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"{}\n");
        assert_eq!(called.get(), 1);
        assert_eq!(
            hook_spool::spool_len(&spool),
            1,
            "session-end must not drain inline"
        );
    }

    #[tokio::test]
    async fn stop_and_pre_compact_spawn_background_drainer_after_enqueue() {
        for event in ["stop", "pre-compact"] {
            let tmp = tempfile::tempdir().unwrap();
            let data_dir = tmp.path().to_path_buf();
            let spool = hook_spool::spool_dir(&data_dir);
            let called = std::cell::Cell::new(0);
            let mut stdout = Vec::new();
            let args = HookArgs {
                event: event.into(),
                agent: "claude-code".into(),
                server_url: dead_server_url(),
                auth_token: None,
                project_strategy: None,
                check_capture: false,
                capture_assistant: false,
                capture_mode: None,
            };

            run_with_payload(
                Some(data_dir.clone()),
                args,
                r#"{"session_id":"s","cwd":"/tmp"}"#.into(),
                &mut stdout,
                |path, _token| {
                    assert_eq!(path, data_dir.as_path());
                    assert_eq!(hook_spool::spool_len(&spool), 1, "spawn runs after enqueue");
                    called.set(called.get() + 1);
                    Ok(())
                },
            )
            .await
            .unwrap();

            assert_eq!(stdout, b"{}\n", "{event} should keep hook stdout clean");
            assert_eq!(called.get(), 1, "{event} should start background drain");
            assert_eq!(
                hook_spool::spool_len(&spool),
                1,
                "{event} must not drain inline"
            );
        }
    }

    fn zero_hook_args(event: &str, server_url: &str) -> HookArgs {
        HookArgs {
            event: event.into(),
            agent: "zero".into(),
            server_url: server_url.into(),
            auth_token: None,
            project_strategy: None,
            check_capture: false,
            capture_assistant: false,
            capture_mode: None,
        }
    }

    /// Zero's sandbox kills the detached drainer with the hook (#1172), so its
    /// session-end must deliver before the hook returns.
    #[tokio::test]
    async fn zero_session_end_delivers_in_process_without_a_detached_drainer() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        let spool = hook_spool::spool_dir(&data_dir);
        let (base, mut requests) = serve_requests("200 OK", r#"{"accepted":1}"#).await;
        let mut stdout = Vec::new();

        run_with_payload(
            Some(data_dir.clone()),
            zero_hook_args("session-end", &base),
            r#"{"sessionId":"s","cwd":"/tmp"}"#.into(),
            &mut stdout,
            |_, _| panic!("zero's session-end must not spawn a detached drainer"),
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"{}\n");
        let request = first_request(&mut requests)
            .await
            .expect("drained in-process");
        assert!(request.starts_with("POST /hook/batch"), "{request}");
        assert_eq!(
            hook_spool::spool_len(&spool),
            0,
            "delivered event left the spool"
        );
    }

    /// With the sandbox's network denied the in-process drain fails fast and
    /// the event stays spooled for `hook-drain` or the next session.
    #[tokio::test]
    async fn zero_session_end_without_network_keeps_the_event_spooled() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        let spool = hook_spool::spool_dir(&data_dir);
        let refused = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", listener.local_addr().unwrap())
        };
        let mut stdout = Vec::new();

        run_with_payload(
            Some(data_dir.clone()),
            zero_hook_args("session-end", &refused),
            r#"{"sessionId":"s","cwd":"/tmp"}"#.into(),
            &mut stdout,
            |_, _| panic!("zero's session-end must not spawn a detached drainer"),
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"{}\n");
        let entries = read_spooled_entries(&spool);
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].attempts, 0,
            "an unreachable server costs no retry"
        );
    }

    #[tokio::test]
    async fn session_end_run_spawn_failure_keeps_event_queued_and_stdout_clean() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        let spool = hook_spool::spool_dir(&data_dir);
        let mut stdout = Vec::new();
        let args = HookArgs {
            event: "session-end".into(),
            agent: "claude-code".into(),
            server_url: dead_server_url(),
            auth_token: None,
            project_strategy: None,
            check_capture: false,
            capture_assistant: false,
            capture_mode: None,
        };

        run_with_payload(
            Some(data_dir),
            args,
            "{}".into(),
            &mut stdout,
            |_path, _token| Err(std::io::Error::other("spawn failed")),
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"{}\n");
        assert_eq!(hook_spool::spool_len(&spool), 1);
    }

    #[tokio::test]
    async fn devin_session_end_spools_stored_session_id_then_clears_state() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        let spool = hook_spool::spool_dir(&data_dir);
        store_session_id(&data_dir, AgentKind::Devin, "stable-devin-session");
        let mut stdout = Vec::new();
        let args = HookArgs {
            event: "session-end".into(),
            agent: "devin".into(),
            server_url: dead_server_url(),
            auth_token: None,
            project_strategy: None,
            check_capture: false,
            capture_assistant: false,
            capture_mode: None,
        };

        run_with_payload(
            Some(data_dir.clone()),
            args,
            r#"{"hook_event_name":"SessionEnd"}"#.into(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"{}\n");
        assert!(stored_session_id(&data_dir, AgentKind::Devin).is_none());
        let entries: Vec<_> = std::fs::read_dir(&spool)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(entries.len(), 1);
        let entry: hook_spool::SpoolEntry =
            serde_json::from_slice(&std::fs::read(&entries[0]).unwrap()).unwrap();
        assert!(
            entry.url.contains("&session_id=stable-devin-session"),
            "{}",
            entry.url
        );
    }

    #[test]
    fn session_end_spawn_failure_is_returned_for_warning_only() {
        let tmp = tempfile::tempdir().unwrap();
        let err = after_background_drain_event_enqueue(tmp.path(), None, |_path, _token| {
            Err(std::io::Error::other("spawn failed"))
        })
        .unwrap_err();

        assert_eq!(err.kind(), std::io::ErrorKind::Other);
    }

    #[test]
    fn background_drain_event_policy_spawns_without_inline_drain() {
        let tmp = tempfile::tempdir().unwrap();
        let called = std::cell::Cell::new(false);

        after_background_drain_event_enqueue(tmp.path(), None, |path, _token| {
            assert_eq!(path, tmp.path());
            called.set(true);
            Ok(())
        })
        .unwrap();

        assert!(called.get());
    }

    #[test]
    fn timing_accessors_read_the_expected_env_vars() {
        fn one_minute_for(expected_name: &'static str) -> impl FnMut(&str) -> Option<String> {
            move |actual_name| {
                assert_eq!(actual_name, expected_name);
                Some("1".to_string())
            }
        }

        assert_eq!(
            drain_event_timeout_from(one_minute_for(DRAIN_TIMEOUT_ENV)),
            Duration::from_secs(60)
        );
        assert_eq!(
            handoff_timeout_from(one_minute_for(HANDOFF_TIMEOUT_ENV)),
            Duration::from_secs(60)
        );
        assert_eq!(
            start_drain_budget_from(one_minute_for(START_BUDGET_ENV)),
            Duration::from_secs(60)
        );
        assert_eq!(
            background_drain_budget_from(one_minute_for(BACKGROUND_DRAIN_BUDGET_ENV)),
            Duration::from_secs(60)
        );
    }

    #[tokio::test]
    async fn capture_drop_prevents_spool_and_drainer() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(".ai-memory.toml"),
            "[capture]\nignore_paths = [\"secret/**\"]\n",
        )
        .unwrap();
        let data_dir = tmp.path().join("data");
        let mut stdout = Vec::new();
        let called = std::cell::Cell::new(false);
        let mut args = devin_hook_args("post-tool-use");
        args.server_url = dead_server_url();
        run_with_payload(Some(data_dir.clone()), args, serde_json::json!({"cwd":tmp.path(),"tool_name":"Edit","tool_input":{"path":"secret/SENTINEL"}}).to_string(), &mut stdout, |_, _| { called.set(true); Ok(()) }).await.unwrap();
        assert_eq!(stdout, b"{}\n");
        assert!(!called.get());
        assert_eq!(hook_spool::spool_len(&hook_spool::spool_dir(&data_dir)), 0);
    }

    #[tokio::test]
    async fn absolute_file_target_uses_destination_scope_and_capture_policy() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source");
        let destination = tmp.path().join("destination");
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(
            source.join(".ai-memory.toml"),
            "workspace = \"shared\"\nproject = \"source\"\n",
        )
        .unwrap();
        std::fs::write(
            destination.join(".ai-memory.toml"),
            "workspace = \"shared\"\nproject = \"destination\"\n[capture]\nignore_paths = [\"secret/**\"]\n",
        )
        .unwrap();
        let data_dir = tmp.path().join("data");

        let mut args = devin_hook_args("post-tool-use");
        args.agent = "claude-code".into();
        let excluded = serde_json::json!({
            "session_id": "cross-project",
            "cwd": source,
            "tool_name": "Edit",
            "tool_input": {"file_path": destination.join("secret/private.txt")},
            "tool_response": {"content": "SENTINEL_MUST_NOT_BE_SPOOLED"}
        });
        run_with_payload(
            Some(data_dir.clone()),
            args,
            excluded.to_string(),
            &mut Vec::new(),
            |_, _| panic!("a dropped tool event must not start a drainer"),
        )
        .await
        .unwrap();
        let spool = hook_spool::spool_dir(&data_dir);
        assert_eq!(hook_spool::spool_len(&spool), 0);

        let mut args = devin_hook_args("post-tool-use");
        args.agent = "claude-code".into();
        let public = serde_json::json!({
            "session_id": "cross-project",
            "cwd": source,
            "tool_name": "Edit",
            "tool_input": {"file_path": destination.join("public.txt")},
            "tool_response": {"content": "public"}
        });
        run_with_payload(
            Some(data_dir),
            args,
            public.to_string(),
            &mut Vec::new(),
            |_, _| panic!("a tool event below the threshold must only spool"),
        )
        .await
        .unwrap();
        let entries = read_spooled_entries(&spool);
        assert_eq!(entries.len(), 1);
        assert_eq!(query_param(&entries[0].url, "workspace"), Some("shared"));
        assert_eq!(query_param(&entries[0].url, "project"), Some("destination"));
        assert_eq!(
            query_param(&entries[0].url, "cwd"),
            Some(url_encode(destination.to_str().unwrap()).as_str())
        );
        let body: serde_json::Value = serde_json::from_str(&entries[0].body).unwrap();
        assert_eq!(body["cwd"], destination.to_string_lossy().as_ref());
    }

    #[tokio::test]
    async fn absolute_file_target_cannot_escape_a_destination_server_profile() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source");
        let destination = tmp.path().join("destination");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(
            source.join(".ai-memory.toml"),
            "workspace = \"shared\"\nproject = \"source\"\n",
        )
        .unwrap();
        std::fs::write(
            destination.join(".ai-memory.toml"),
            "server = \"unregistered\"\nworkspace = \"shared\"\nproject = \"destination\"\n",
        )
        .unwrap();
        let data_dir = tmp.path().join("data");
        let mut args = devin_hook_args("post-tool-use");
        args.agent = "claude-code".into();
        let raw = serde_json::json!({
            "session_id": "cross-profile",
            "cwd": source,
            "tool_name": "Edit",
            "tool_input": {"file_path": destination.join("public.txt")}
        });

        run_with_payload(
            Some(data_dir.clone()),
            args,
            raw.to_string(),
            &mut Vec::new(),
            |_, _| panic!("a refused destination route must not start a drainer"),
        )
        .await
        .unwrap();

        assert_eq!(
            hook_spool::spool_len(&hook_spool::spool_dir(&data_dir)),
            0,
            "the event must not fall back to the source repository's server"
        );
    }

    #[test]
    fn file_target_routing_refuses_relative_external_and_mixed_project_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source");
        let destination = tmp.path().join("destination");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(source.join(".ai-memory.toml"), "project = \"source\"\n").unwrap();
        std::fs::write(
            destination.join(".ai-memory.toml"),
            "project = \"destination\"\n",
        )
        .unwrap();
        let cwd = source.to_str().unwrap();
        let relative = serde_json::json!({
            "tool_name": "Edit",
            "tool_input": {"file_path": "../destination/file.txt"}
        });
        assert_eq!(
            tool_location_routing_cwd(AgentKind::ClaudeCode, &relative, cwd),
            None,
            "a relative path cannot independently prove a destination"
        );

        let external_dir = tmp.path().join("not-a-project");
        std::fs::create_dir_all(&external_dir).unwrap();
        let external = serde_json::json!({
            "tool_name": "Edit",
            "tool_input": {"file_path": external_dir.join("file.txt")}
        });
        assert_eq!(
            tool_location_routing_cwd(AgentKind::ClaudeCode, &external, cwd),
            None,
            "an arbitrary absolute path must not mint a project"
        );

        let mixed = serde_json::json!({
            "tool_name": "read",
            "tool_input": {"paths": [
                source.join("one.txt"),
                destination.join("two.txt")
            ]}
        });
        assert_eq!(
            tool_location_routing_cwd(AgentKind::ClaudeCode, &mixed, cwd),
            None,
            "one event cannot be attributed to two projects"
        );
    }

    /// Spool one native hook event and return what reached the spool.
    async fn spool_one(
        data_dir: &Path,
        agent: &str,
        capture_mode: Option<crate::cli::CaptureModeArg>,
        raw: &serde_json::Value,
    ) -> Vec<hook_spool::SpoolEntry> {
        let mut args = devin_hook_args("post-tool-use");
        args.agent = agent.into();
        args.capture_mode = capture_mode;
        run_with_payload(
            Some(data_dir.to_path_buf()),
            args,
            raw.to_string(),
            &mut Vec::new(),
            |_, _| panic!("a tool event below the threshold must only spool"),
        )
        .await
        .unwrap();
        let spool = hook_spool::spool_dir(data_dir);
        if spool.exists() {
            read_spooled_entries(&spool)
        } else {
            Vec::new()
        }
    }

    /// Hermes reports its own process cwd (usually `~`) on every tool event and
    /// points each call at a repository through `workdir` or `path` (#1199).
    /// Under allowlist mode the process cwd has no marker, so the tool's own
    /// absolute location must find the repository's marker.
    #[tokio::test]
    async fn hermes_tool_location_finds_the_marker_the_process_cwd_lacks() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let repo = home.join("dev").join("some-repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(
            repo.join(".ai-memory.toml"),
            "workspace = \"w\"\nproject = \"some-repo\"\n",
        )
        .unwrap();
        let allowlist = Some(crate::cli::CaptureModeArg::Allowlist);
        let event = |tool: &str, input: serde_json::Value| {
            serde_json::json!({
                "hook_event_name": "post_tool_call",
                "tool_name": tool,
                "tool_input": input,
                "session_id": "hermes-session",
                "cwd": home,
                "extra": {"tool_call_id": "call-1", "status": "ok"}
            })
        };

        for (name, raw) in [
            (
                "terminal workdir",
                event(
                    "terminal",
                    serde_json::json!({"command": "git status", "workdir": repo}),
                ),
            ),
            (
                "file path",
                event(
                    "read_file",
                    serde_json::json!({"path": repo.join("README.md")}),
                ),
            ),
            (
                "search directory",
                event(
                    "search_files",
                    serde_json::json!({"pattern": "fn", "path": repo}),
                ),
            ),
        ] {
            let data_dir = tmp.path().join(format!("data-{}", name.replace(' ', "-")));
            let entries = spool_one(&data_dir, "hermes", allowlist, &raw).await;
            assert_eq!(entries.len(), 1, "{name}");
            assert_eq!(
                query_param(&entries[0].url, "project"),
                Some("some-repo"),
                "{name}"
            );
            let body: serde_json::Value = serde_json::from_str(&entries[0].body).unwrap();
            assert_eq!(body["cwd"], repo.to_string_lossy().as_ref(), "{name}");
        }

        // Controls: a command with no location, or a relative one Hermes
        // resolves against a session cwd the payload never carries, still
        // belongs to the unmarked process cwd and is not captured.
        for (name, raw) in [
            (
                "no workdir",
                event("terminal", serde_json::json!({"command": "git status"})),
            ),
            (
                "relative workdir",
                event(
                    "terminal",
                    serde_json::json!({"command": "git status", "workdir": "dev/some-repo"}),
                ),
            ),
            (
                "relative search",
                event(
                    "search_files",
                    serde_json::json!({"pattern": "fn", "path": "."}),
                ),
            ),
        ] {
            let data_dir = tmp.path().join(format!("data-{}", name.replace(' ', "-")));
            assert!(
                spool_one(&data_dir, "hermes", allowlist, &raw)
                    .await
                    .is_empty(),
                "{name}"
            );
        }
    }

    /// A shell `workdir` reroute lands under the destination's exclusions: a
    /// command reading an ignored path there is dropped, a public one is kept.
    #[tokio::test]
    async fn workdir_reroute_applies_the_destination_capture_policy() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(
            repo.join(".ai-memory.toml"),
            "project = \"repo\"\n[capture]\nignore_paths = [\"secret/**\"]\n",
        )
        .unwrap();
        for (command, spooled) in [("cat secret/token.txt", 0), ("cat README.md", 1)] {
            let raw = serde_json::json!({
                "tool_name": "terminal",
                "tool_input": {"command": command, "workdir": repo},
                "tool_response": "SENTINEL_CONTENT",
                "session_id": "hermes-session",
                "cwd": home,
            });
            let data_dir = tmp.path().join(format!("data-{spooled}"));
            assert_eq!(
                spool_one(&data_dir, "hermes", None, &raw).await.len(),
                spooled,
                "{command}"
            );
        }
    }

    /// Adversarial: a reroute must never escape the payload cwd's own
    /// `ignore_paths`. The source excludes a path outside its checkout and a
    /// path inside it; a file tool targeting the first, or a shell command
    /// naming the second while its `workdir` points at another project, would
    /// otherwise be judged only by the destination's (inactive) policy and
    /// spooled. Controls: the same tools on public paths still reroute.
    #[tokio::test]
    async fn a_reroute_cannot_escape_the_source_capture_exclusions() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source");
        let vault = tmp.path().join("vault");
        let other = tmp.path().join("other");
        for dir in [&source, &vault, &other] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(
            source.join(".ai-memory.toml"),
            format!(
                "project = \"source\"\n[capture]\nignore_paths = [\"secret/**\", {:?}]\n",
                format!("{}/**", vault.display())
            ),
        )
        .unwrap();
        std::fs::write(vault.join(".ai-memory.toml"), "project = \"vault\"\n").unwrap();
        std::fs::write(other.join(".ai-memory.toml"), "project = \"other\"\n").unwrap();
        let bash = |command: String| {
            serde_json::json!({
                "session_id": "escape",
                "cwd": source,
                "tool_name": "Bash",
                "tool_input": {"command": command, "workdir": other},
                "tool_response": {"stdout": "SENTINEL_MUST_NOT_BE_SPOOLED"}
            })
        };
        let read = |path: PathBuf| {
            serde_json::json!({
                "session_id": "escape",
                "cwd": source,
                "tool_name": "Read",
                "tool_input": {"file_path": path},
                "tool_response": {"content": "SENTINEL_MUST_NOT_BE_SPOOLED"}
            })
        };

        for (name, raw) in [
            ("file outside the source", read(vault.join("key.md"))),
            (
                "shell naming a source file",
                bash(format!("cat {}", source.join("secret/token.txt").display())),
            ),
        ] {
            let data_dir = tmp.path().join(format!("data-{}", name.replace(' ', "-")));
            assert!(
                spool_one(&data_dir, "claude-code", None, &raw)
                    .await
                    .is_empty(),
                "{name}: the source exclusion must still drop the event"
            );
        }

        for (name, raw, project) in [
            ("public file", read(other.join("readme.md")), "other"),
            ("public shell", bash("git status".to_owned()), "other"),
        ] {
            let data_dir = tmp.path().join(format!("data-{}", name.replace(' ', "-")));
            let entries = spool_one(&data_dir, "claude-code", None, &raw).await;
            assert_eq!(entries.len(), 1, "{name}");
            assert_eq!(
                query_param(&entries[0].url, "project"),
                Some(project),
                "{name}"
            );
        }
    }

    /// Adversarial: checkout A's `ignore_paths` hold for a call made from
    /// checkout B or from an unmarked directory, by a shell argument
    /// (relative or absolute) or a file tool, whatever B's own policy says.
    /// Controls: A's public files, and B's own files, are still captured.
    #[tokio::test]
    async fn another_checkouts_exclusions_hold_for_a_call_made_elsewhere() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        let bare = tmp.path().join("unmarked");
        let broken = tmp.path().join("broken");
        for dir in [&a, &b, &bare, &broken] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(
            a.join(".ai-memory.toml"),
            "project = \"a\"\n[capture]\nignore_paths = [\"secrets.env\"]\n",
        )
        .unwrap();
        std::fs::write(b.join(".ai-memory.toml"), "project = \"b\"\n").unwrap();
        std::fs::write(broken.join(".ai-memory.toml"), "[capture\n").unwrap();
        let event = |agent_cwd: &Path, tool: &str, input: serde_json::Value| {
            serde_json::json!({
                "session_id": "cross",
                "cwd": agent_cwd,
                "tool_name": tool,
                "tool_input": input,
                "tool_response": {"stdout": "SENTINEL_MUST_NOT_BE_SPOOLED"}
            })
        };
        let secret = a.join("secrets.env");
        let cases = [
            (
                "relative shell",
                "claude-code",
                event(
                    &b,
                    "Bash",
                    serde_json::json!({"command": "cat ../a/secrets.env"}),
                ),
            ),
            (
                "absolute shell",
                "claude-code",
                event(
                    &b,
                    "Bash",
                    serde_json::json!({"command": format!("cat {}", secret.display())}),
                ),
            ),
            (
                "unmarked hermes terminal",
                "hermes",
                event(
                    &bare,
                    "terminal",
                    serde_json::json!({"command": format!("cat {}", secret.display())}),
                ),
            ),
            (
                "glob shell",
                "claude-code",
                event(&b, "Bash", serde_json::json!({"command": "cat ../a/*.env"})),
            ),
        ];
        for (name, agent, raw) in cases {
            let data_dir = tmp.path().join(format!("data-{}", name.replace(' ', "-")));
            assert!(
                spool_one(&data_dir, agent, None, &raw).await.is_empty(),
                "{name}: A's exclusion must drop the event"
            );
        }
        // A broken marker over the target fails closed: metadata-only.
        let raw = event(
            &b,
            "Bash",
            serde_json::json!({"command": "cat ../broken/x.md"}),
        );
        let entries = spool_one(&tmp.path().join("data-broken"), "claude-code", None, &raw).await;
        assert_eq!(entries.len(), 1);
        assert!(
            !entries[0].body.contains("SENTINEL_MUST_NOT_BE_SPOOLED"),
            "{}",
            entries[0].body
        );
        assert!(
            entries[0].body.contains("\"metadata-only\""),
            "{}",
            entries[0].body
        );
        // More markers than the bound is unprovable: metadata-only.
        let mut many = String::from("cat");
        for index in 0..=MAX_FOREIGN_MARKERS {
            let dir = tmp.path().join(format!("m{index}"));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(".ai-memory.toml"), "project = \"m\"\n").unwrap();
            many.push_str(&format!(" ../m{index}/x.md"));
        }
        let raw = event(&b, "Bash", serde_json::json!({"command": many}));
        let entries = spool_one(&tmp.path().join("data-many"), "claude-code", None, &raw).await;
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].body.contains("SENTINEL_MUST_NOT_BE_SPOOLED"));
        // Controls.
        for (name, raw) in [
            (
                "public shell",
                event(
                    &b,
                    "Bash",
                    serde_json::json!({"command": "cat ../a/public.md README.md"}),
                ),
            ),
            (
                "own file",
                event(
                    &b,
                    "Bash",
                    serde_json::json!({"command": "cat secrets.env"}),
                ),
            ),
            (
                "few markers",
                event(
                    &b,
                    "Bash",
                    serde_json::json!({"command": "cat ../m0/x.md ../m1/x.md"}),
                ),
            ),
        ] {
            let data_dir = tmp.path().join(format!("data-{}", name.replace(' ', "-")));
            let entries = spool_one(&data_dir, "claude-code", None, &raw).await;
            assert_eq!(entries.len(), 1, "{name}");
            assert!(
                entries[0].body.contains("SENTINEL_MUST_NOT_BE_SPOOLED"),
                "{name}"
            );
        }
    }

    /// Adversarial: checkout A's `ignore_paths` also hold for a call from a
    /// sibling checkout or an unmarked parent that reaches A through glob
    /// syntax in a directory segment, through a search/list tool's path or
    /// glob, or through an `apply_patch` header; glob syntax the lookup
    /// cannot follow, and a file tool whose target cannot be read, fail
    /// closed. Controls: public files, the event's own files and searches,
    /// and ordinary globs are still captured whole.
    #[tokio::test]
    async fn globs_searches_and_unreadable_targets_answer_to_another_checkout() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().join("work");
        let a = parent.join("a");
        let b = parent.join("b");
        for dir in [&a, &b, &b.join("src")] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(
            a.join(".ai-memory.toml"),
            "project = \"a\"\n[capture]\nignore_paths = [\"secrets.env\"]\n",
        )
        .unwrap();
        std::fs::write(b.join(".ai-memory.toml"), "project = \"b\"\n").unwrap();
        let event = |agent_cwd: &Path, tool: &str, input: serde_json::Value| {
            serde_json::json!({
                "session_id": "cross-glob",
                "cwd": agent_cwd,
                "tool_name": tool,
                "tool_input": input,
                "tool_response": {"stdout": "SENTINEL_MUST_NOT_BE_SPOOLED"}
            })
        };
        let bash = |agent_cwd: &Path, command: &str| {
            event(agent_cwd, "Bash", serde_json::json!({"command": command}))
        };
        let attacks = [
            (
                "sibling star",
                "claude-code",
                bash(&b, "cat ../*/secrets.env"),
            ),
            (
                "parent star",
                "claude-code",
                bash(&parent, "cat */secrets.env"),
            ),
            ("brace", "claude-code", bash(&b, "cat ../{a,c}/secrets.env")),
            ("bracket", "claude-code", bash(&b, "cat ../[a]/secrets.env")),
            ("globstar", "claude-code", bash(&b, "cat ../**/secrets.env")),
            (
                "spanning brace",
                "claude-code",
                bash(&b, "cat ../{a/x,c}/secrets.env"),
            ),
            (
                "grep path",
                "claude-code",
                event(
                    &b,
                    "Grep",
                    serde_json::json!({"pattern": "KEY", "path": "../a/secrets.env", "output_mode": "content"}),
                ),
            ),
            (
                "glob pattern",
                "claude-code",
                event(&b, "Glob", serde_json::json!({"pattern": "../a/*.env"})),
            ),
            (
                "grep filter from the parent",
                "claude-code",
                event(
                    &parent,
                    "Grep",
                    serde_json::json!({"pattern": "KEY", "glob": "*/secrets.env"}),
                ),
            ),
            (
                "gemini search",
                "gemini-cli",
                event(
                    &b,
                    "search_file_content",
                    serde_json::json!({"pattern": "KEY", "dir_path": "../a"}),
                ),
            ),
            (
                "patch header",
                "codex",
                event(
                    &b,
                    "apply_patch",
                    serde_json::json!({"command": "*** Begin Patch\n*** Update File: ../a/secrets.env\n+KEY\n*** End Patch"}),
                ),
            ),
            (
                "unreadable target",
                "claude-code",
                event(&parent, "Read", serde_json::json!({})),
            ),
        ];
        for (name, agent, raw) in attacks {
            let data_dir = tmp.path().join(format!("data-{}", name.replace(' ', "-")));
            let entries = spool_one(&data_dir, agent, None, &raw).await;
            assert!(
                entries
                    .iter()
                    .all(|entry| !entry.body.contains("SENTINEL_MUST_NOT_BE_SPOOLED")),
                "{name}: {entries:?}"
            );
        }
        let controls = [
            ("public glob", "claude-code", bash(&b, "cat ../*/public.md")),
            ("own glob", "claude-code", bash(&b, "ls src/*")),
            (
                "own globstar",
                "claude-code",
                bash(&b, "cat src/**/main.rs"),
            ),
            (
                "own grep",
                "claude-code",
                event(
                    &b,
                    "Grep",
                    serde_json::json!({"pattern": "KEY", "path": "src"}),
                ),
            ),
            (
                "own glob tool",
                "claude-code",
                event(&b, "Glob", serde_json::json!({"pattern": "**/*.rs"})),
            ),
            (
                "public grep",
                "claude-code",
                event(
                    &parent,
                    "Grep",
                    serde_json::json!({"pattern": "KEY", "path": "b"}),
                ),
            ),
            (
                "own patch",
                "codex",
                event(
                    &b,
                    "apply_patch",
                    serde_json::json!({"command": "*** Begin Patch\n*** Add File: src/x.rs\n+fn x() {}\n*** End Patch"}),
                ),
            ),
        ];
        for (name, agent, raw) in controls {
            let data_dir = tmp.path().join(format!("data-{}", name.replace(' ', "-")));
            let entries = spool_one(&data_dir, agent, None, &raw).await;
            assert_eq!(entries.len(), 1, "{name}");
            assert!(
                entries[0].body.contains("SENTINEL_MUST_NOT_BE_SPOOLED"),
                "{name}: {}",
                entries[0].body
            );
        }
    }

    /// Regression: a glob rooted inside the event's own checkout is not
    /// walked, so a monorepo with more matching directories than the walk's
    /// bounds keeps its ordinary commands whole, with or without a policy of
    /// its own (a search tool under an active policy is dropped by the search
    /// rule, not by the walk). The sibling-checkout attack still drops.
    #[tokio::test]
    async fn a_monorepo_glob_inside_the_own_checkout_is_not_walked() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("work");
        let mono = work.join("mono");
        let a = work.join("a");
        std::fs::create_dir_all(mono.join(".git")).unwrap();
        std::fs::create_dir_all(mono.join("log")).unwrap();
        for index in 0..300 {
            let package = mono.join("packages").join(format!("p{index}"));
            std::fs::create_dir_all(package.join("src")).unwrap();
            std::fs::write(package.join("package.json"), "{}").unwrap();
            std::fs::create_dir_all(mono.join("node_modules").join(format!("m{index}"))).unwrap();
        }
        const _: () = assert!(300 > MAX_GLOB_DIRECTORIES);
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(
            a.join(".ai-memory.toml"),
            "project = \"a\"\n[capture]\nignore_paths = [\"secrets.env\"]\n",
        )
        .unwrap();
        let event = |tool: &str, input: serde_json::Value| {
            serde_json::json!({
                "session_id": "monorepo",
                "cwd": mono,
                "tool_name": tool,
                "tool_input": input,
                "tool_response": {"stdout": "SENTINEL_MUST_NOT_BE_SPOOLED"}
            })
        };
        let bash = |command: &str| event("Bash", serde_json::json!({"command": command}));
        let shell = [
            "cat packages/*/package.json",
            "ls packages/*/src",
            "du -sh packages/*",
            "ls node_modules/*/package.json",
            "for f in packages/*/package.json; do echo $f; done",
            "tail -n 50 log/*.log",
        ];
        let searches = [
            event(
                "Glob",
                serde_json::json!({"pattern": "packages/*/package.json"}),
            ),
            event(
                "Grep",
                serde_json::json!({"pattern": "x", "path": "packages", "glob": "*/package.json"}),
            ),
        ];
        for policy in [None, Some("[capture]\nignore_paths = [\"private/**\"]\n")] {
            if let Some(text) = policy {
                std::fs::write(mono.join(".ai-memory.toml"), text).unwrap();
            }
            let label = if policy.is_some() { "active" } else { "none" };
            for (index, command) in shell.iter().enumerate() {
                let data_dir = tmp.path().join(format!("data-{label}-shell-{index}"));
                let entries = spool_one(&data_dir, "claude-code", None, &bash(command)).await;
                assert_eq!(entries.len(), 1, "{label}: {command}");
                assert!(
                    entries[0].body.contains("SENTINEL_MUST_NOT_BE_SPOOLED"),
                    "{label}: {command}: {}",
                    entries[0].body
                );
            }
            for (index, raw) in searches.iter().enumerate() {
                let data_dir = tmp.path().join(format!("data-{label}-search-{index}"));
                let entries = spool_one(&data_dir, "claude-code", None, raw).await;
                if policy.is_some() {
                    assert!(entries.is_empty(), "{label}: {raw}");
                } else {
                    assert_eq!(entries.len(), 1, "{label}: {raw}");
                    assert!(
                        entries[0].body.contains("SENTINEL_MUST_NOT_BE_SPOOLED"),
                        "{label}: {raw}: {}",
                        entries[0].body
                    );
                }
            }
            for (index, command) in ["cat ../*/secrets.env", "cat ../a/*.env"]
                .iter()
                .enumerate()
            {
                let data_dir = tmp.path().join(format!("data-{label}-attack-{index}"));
                let entries = spool_one(&data_dir, "claude-code", None, &bash(command)).await;
                assert!(
                    entries
                        .iter()
                        .all(|entry| !entry.body.contains("SENTINEL_MUST_NOT_BE_SPOOLED")),
                    "{label}: {command}: {entries:?}"
                );
            }
        }
    }

    /// A walk outside the event's own checkout stops, unprovable, past its
    /// directory bound (counted while a `**` lists, not after) or its time
    /// budget; under both it still finds a marker it reaches in time.
    #[test]
    fn a_glob_walk_outside_the_checkout_stops_at_its_bounds() {
        let tmp = tempfile::tempdir().unwrap();
        let wide = tmp.path().join("wide");
        for index in 0..=MAX_GLOB_DIRECTORIES {
            std::fs::create_dir_all(wide.join(format!("d{index}"))).unwrap();
        }
        let narrow = tmp.path().join("narrow");
        std::fs::create_dir_all(narrow.join("x").join("y")).unwrap();
        std::fs::write(narrow.join("x").join(".ai-memory.toml"), "").unwrap();
        let fast = || GlobBudget::with_clock(MAX_GLOB_TIME, Box::new(|| Duration::ZERO));
        assert_eq!(
            fast().markers_below(&wide, &[GlobStep::AnyDepth], None),
            None
        );
        // The bound stops a deep tree's listing early, not after all of it.
        let deep = tmp.path().join("deep");
        for outer in 0..64 {
            for inner in 0..64 {
                std::fs::create_dir_all(deep.join(format!("d{outer}/e{inner}"))).unwrap();
            }
        }
        let mut budget = fast();
        assert_eq!(
            budget.markers_below(&deep, &[GlobStep::AnyDepth], None),
            None
        );
        assert!(budget.entries < 1_024, "{}", budget.entries);
        assert_eq!(
            fast().markers_below(&narrow, &[GlobStep::AnyDepth], None),
            Some(vec![narrow.join("x").join(".ai-memory.toml")])
        );
        // Inside the event's own checkout nothing is walked at all.
        assert_eq!(
            fast().markers_below(&wide, &[GlobStep::AnyDepth], Some(tmp.path())),
            Some(Vec::new())
        );
        // A filesystem slower than the budget fails closed.
        let mut calls = 0;
        let mut slow = GlobBudget::with_clock(
            MAX_GLOB_TIME,
            Box::new(move || {
                calls += 1;
                MAX_GLOB_TIME * calls
            }),
        );
        assert_eq!(
            slow.markers_below(&narrow, &[GlobStep::AnyDepth], None),
            None
        );
    }

    /// The payload of a Bash call made from `cwd`.
    fn bash_call(cwd: &Path, command: &str) -> serde_json::Value {
        serde_json::json!({
            "session_id": "lookup",
            "cwd": cwd,
            "tool_name": "Bash",
            "tool_input": {"command": command},
            "tool_response": {"stdout": "x"}
        })
    }

    /// The disposition [`foreign_decision_within`] gives a call, `None` when no
    /// other marker governs it.
    fn foreign_disposition(
        cwd: &Path,
        command: &str,
        own_marker: Option<&Path>,
        home: Option<&Path>,
        budget: impl FnOnce() -> GlobBudget,
    ) -> Option<CaptureDisposition> {
        let raw = bash_call(cwd, command);
        foreign_decision_within(
            AgentKind::ClaudeCode,
            &raw,
            &lexical_capture_cwd(&cwd.to_string_lossy()),
            own_marker,
            home,
            budget,
        )
        .map(|decision| decision.protocol().disposition())
    }

    /// Regression (the docs promised it; v2.6.3 kept the call): a `**` that
    /// starts above the event's checkout skips the checkout's own subtree, so
    /// a checkout with more directories than the walk's bound keeps
    /// `ls ../**/README.md`. Adversarial: the sibling checkout's policy still
    /// drops `cat ../**/secrets.env`.
    #[test]
    fn a_globstar_above_the_checkout_skips_the_own_subtree() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("work");
        let own = work.join("own");
        let a = work.join("a");
        std::fs::create_dir_all(own.join(".git")).unwrap();
        for index in 0..300 {
            std::fs::create_dir_all(own.join(format!("d{index}"))).unwrap();
        }
        const _: () = assert!(300 > MAX_GLOB_DIRECTORIES);
        std::fs::create_dir_all(&a).unwrap();
        let fast = || GlobBudget::with_clock(MAX_GLOB_TIME, Box::new(|| Duration::ZERO));
        assert_eq!(
            fast().markers_below(&work, &[GlobStep::AnyDepth], Some(&own)),
            Some(Vec::new())
        );
        assert_eq!(
            fast().markers_below(&work, &[GlobStep::AnyDepth], None),
            None,
            "without the skip the own subtree exceeds the bound"
        );
        assert_eq!(
            foreign_disposition(&own, "ls ../**/README.md", None, None, fast),
            None
        );
        std::fs::write(
            a.join(".ai-memory.toml"),
            "[capture]\nignore_paths = [\"secrets.env\"]\n",
        )
        .unwrap();
        assert_eq!(
            foreign_disposition(&own, "cat ../**/secrets.env", None, None, fast),
            Some(CaptureDisposition::Drop)
        );
    }

    /// Regression (v2.6.3 answered in milliseconds): many paths inside a deep
    /// tree look each directory's marker up once, not once per path and
    /// level, and the lookup shares the walk's budget. Running out of it
    /// inside the own checkout keeps the call (the own policy governs there);
    /// outside it the call is unprovable. Adversarial: a location outside
    /// the checkout is looked up first, so a long list inside it cannot spend
    /// the budget before another checkout's policy is found, and inside it a
    /// shallow nested marker is found before a deep list.
    #[test]
    fn marker_lookups_in_a_deep_tree_cost_one_probe_per_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("work");
        let own = work.join("own");
        let a = work.join("a");
        let depth = 300;
        let deep = (0..depth).fold(own.clone(), |dir, _| dir.join("d"));
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::create_dir_all(own.join(".git")).unwrap();
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(
            a.join(".ai-memory.toml"),
            "[capture]\nignore_paths = [\"secrets.env\"]\n",
        )
        .unwrap();
        let spread: Vec<String> = (1..=depth)
            .map(|level| format!("{}f", "d/".repeat(level)))
            .collect();
        let inside = format!("cat {}", spread.join(" "));
        // A clock that counts its readings: one per probe or listing.
        let counted = |readings: std::rc::Rc<std::cell::Cell<usize>>, expire_after: usize| {
            move || {
                GlobBudget::with_clock(
                    MAX_GLOB_TIME,
                    Box::new(move || {
                        readings.set(readings.get() + 1);
                        if readings.get() > expire_after {
                            MAX_GLOB_TIME * 2
                        } else {
                            Duration::ZERO
                        }
                    }),
                )
            }
        };
        let readings = std::rc::Rc::new(std::cell::Cell::new(0));
        assert_eq!(
            foreign_disposition(
                &own,
                &inside,
                None,
                None,
                counted(readings.clone(), usize::MAX)
            ),
            None
        );
        assert!(
            readings.get() < 5 * depth,
            "{} probes for {depth} levels",
            readings.get()
        );
        // Out of budget inside the own checkout: kept.
        let readings = std::rc::Rc::new(std::cell::Cell::new(0));
        assert_eq!(
            foreign_disposition(&own, &inside, None, None, counted(readings, 10)),
            None
        );
        // Out of budget outside it: unprovable.
        let outside = (0..depth).fold(work.join("elsewhere"), |dir, _| dir.join("d"));
        std::fs::create_dir_all(&outside).unwrap();
        let readings = std::rc::Rc::new(std::cell::Cell::new(0));
        assert_eq!(
            foreign_disposition(
                &own,
                &format!("cat {}/f", outside.display()),
                None,
                None,
                counted(readings, 10)
            ),
            Some(CaptureDisposition::MetadataOnly)
        );
        // The other checkout's location comes first, whatever the order.
        let attack = format!("{inside} ../a/secrets.env");
        let readings = std::rc::Rc::new(std::cell::Cell::new(0));
        assert_eq!(
            foreign_disposition(&own, &attack, None, None, counted(readings, 10)),
            Some(CaptureDisposition::Drop)
        );
        // Inside the checkout the shallowest locations come first, so a
        // marker nested near the top is found before a deep list spends the
        // budget.
        std::fs::create_dir_all(own.join("vendor")).unwrap();
        std::fs::write(
            own.join("vendor").join(".ai-memory.toml"),
            "[capture]\nignore_paths = [\"secrets.env\"]\n",
        )
        .unwrap();
        let nested = format!("{inside} vendor/secrets.env");
        let readings = std::rc::Rc::new(std::cell::Cell::new(0));
        assert_eq!(
            foreign_disposition(&own, &nested, None, None, counted(readings, 10)),
            Some(CaptureDisposition::Drop)
        );
    }

    /// Adversarial: a `.git` at the home directory (a dotfiles repository)
    /// does not make every checkout under home the event's own, so a glob
    /// from `~/Projects` into a sibling checkout is still walked and that
    /// checkout's policy drops the call. Control: a harmless glob is kept.
    #[test]
    fn a_dotfiles_checkout_at_home_is_not_the_own_checkout() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let projects = home.join("Projects");
        let a = projects.join("a");
        std::fs::create_dir_all(home.join(".git")).unwrap();
        std::fs::create_dir_all(projects.join("b")).unwrap();
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(
            a.join(".ai-memory.toml"),
            "[capture]\nignore_paths = [\"secrets.env\"]\n",
        )
        .unwrap();
        let fast = || GlobBudget::with_clock(MAX_GLOB_TIME, Box::new(|| Duration::ZERO));
        for command in [
            "cat */secrets.env".to_owned(),
            format!("cat {}/*/secrets.env", projects.display()),
        ] {
            assert_eq!(
                foreign_disposition(&projects, &command, None, Some(&home), fast),
                Some(CaptureDisposition::Drop),
                "{command}"
            );
        }
        assert_eq!(
            foreign_disposition(&projects, "cat */README.md", None, Some(&home), fast),
            Some(CaptureDisposition::Keep)
        );
        assert!(!own_checkout(&home, Some(&home)));
        assert!(!own_checkout(tmp.path(), Some(&home)));
        assert!(!own_checkout(Path::new("/"), None));
        assert!(own_checkout(&a, Some(&home)));
    }

    /// Adversarial: syntax that builds a step out of the event's checkout
    /// reaches checkout A's policy: a `..` after a `**` (which can match no
    /// directory), a brace that builds `..`, a zsh glob group, an ANSI-C
    /// numeric escape, an indented patch header, and a Hermes `file_glob`.
    /// Controls: the same shapes that stay inside the checkout are kept.
    #[tokio::test]
    async fn constructed_parent_steps_answer_to_another_checkout() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("work");
        let a = work.join("a");
        let b = work.join("b");
        for dir in [&a, &b.join(".git"), &b.join("sub").join("x")] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(
            a.join(".ai-memory.toml"),
            "project = \"a\"\n[capture]\nignore_paths = [\"secrets.env\"]\n",
        )
        .unwrap();
        let event = |tool: &str, input: serde_json::Value| {
            serde_json::json!({
                "session_id": "constructed",
                "cwd": b,
                "tool_name": tool,
                "tool_input": input,
                "tool_response": {"stdout": "SENTINEL_MUST_NOT_BE_SPOOLED"}
            })
        };
        let bash = |command: &str| event("Bash", serde_json::json!({"command": command}));
        let attacks = [
            (
                "globstar parent",
                "claude-code",
                bash("cat ./**/../a/secrets.env"),
            ),
            (
                "globstar parent glob tool",
                "claude-code",
                event(
                    "Glob",
                    serde_json::json!({"pattern": "./**/../a/secrets.env"}),
                ),
            ),
            (
                "globstar parent grep filter",
                "claude-code",
                event(
                    "Grep",
                    serde_json::json!({"pattern": "KEY", "glob": "**/../a/secrets.env"}),
                ),
            ),
            ("brace dot", "claude-code", bash("cat .{.,x}/a/secrets.env")),
            (
                "brace empty",
                "claude-code",
                bash("cat {.,}./a/secrets.env"),
            ),
            (
                "brace twice",
                "claude-code",
                bash("cat .{.,.}/a/secrets.env"),
            ),
            (
                "brace sequence",
                "claude-code",
                bash("cat .{-..0}/a/secrets.env"),
            ),
            ("zsh group", "claude-code", bash("cat ../(a)/secrets.env")),
            (
                "zsh alternation",
                "claude-code",
                bash("cat ../(a|c)/secrets.env"),
            ),
            (
                "ansi-c hex",
                "claude-code",
                bash("cat ..$'\\x2f'a/secrets.env"),
            ),
            (
                "ansi-c octal",
                "claude-code",
                bash("cat $'\\056\\056'/a/secrets.env"),
            ),
            ("dot star", "claude-code", bash("cat .*/a/secrets.env")),
            (
                "dot question",
                "claude-code",
                bash("cat ./.?/a/secrets.env"),
            ),
            (
                "indented patch header",
                "codex",
                event(
                    "apply_patch",
                    serde_json::json!({"command": "*** Begin Patch\n*** Add File: sub/y.rs\n+y\n  *** Update File: ../a/secrets.env\n+KEY\n*** End Patch"}),
                ),
            ),
            (
                "hermes file glob",
                "hermes",
                event(
                    "search_files",
                    serde_json::json!({"pattern": "KEY", "path": "..", "file_glob": "a/*.env"}),
                ),
            ),
            (
                "ansi-c in a double-quoted script",
                "claude-code",
                bash("bash -c \"cat \\$'\\\\x2e\\\\x2e'/a/secrets.env\""),
            ),
            (
                "ansi-c in a double-quoted eval",
                "claude-code",
                bash("eval \"cat \\$'\\\\x2e\\\\x2e'/a/secrets.env\""),
            ),
            (
                "posix class dot glob",
                "claude-code",
                bash("cat .[[:punct:]]/a/secrets.env"),
            ),
            ("extglob at", "claude-code", bash("cat .@(.)/a/secrets.env")),
            (
                "extglob optional",
                "claude-code",
                bash("cat .?(.)/a/secrets.env"),
            ),
            (
                "extglob star",
                "claude-code",
                bash("cat .*(.)/a/secrets.env"),
            ),
            (
                "extglob plus",
                "claude-code",
                bash("cat .+(.)/a/secrets.env"),
            ),
            (
                "brace dot glob",
                "claude-code",
                bash("cat .{*,x}/a/secrets.env"),
            ),
            (
                "oversized brace sequence",
                "claude-code",
                bash("cat .{-..~}/a/secrets.env"),
            ),
        ];
        for (name, agent, raw) in attacks {
            let data_dir = tmp.path().join(format!("data-{}", name.replace(' ', "-")));
            let entries = spool_one(&data_dir, agent, None, &raw).await;
            assert!(
                entries
                    .iter()
                    .all(|entry| !entry.body.contains("SENTINEL_MUST_NOT_BE_SPOOLED")),
                "{name}: {entries:?}"
            );
        }
        let controls = [
            (
                "own globstar parent",
                "claude-code",
                bash("cat sub/**/../README.md"),
            ),
            ("own brace", "claude-code", bash("cat {sub,lib}/README.md")),
            ("own sequence", "claude-code", bash("cat v{1..3}/README.md")),
            ("subshell", "claude-code", bash("(cd sub && ls)")),
            ("dot list", "claude-code", bash("ls .*")),
            ("dot directory", "claude-code", bash("cat .config/x")),
            ("dot glob", "claude-code", bash("cat .github/*.yml")),
            (
                "ansi-c own",
                "claude-code",
                bash("cat sub$'\\x2f'x/README.md"),
            ),
            (
                "indented own patch",
                "codex",
                event(
                    "apply_patch",
                    serde_json::json!({"command": "*** Begin Patch\n  *** Add File: sub/x.rs\n+fn x() {}\n*** End Patch"}),
                ),
            ),
            (
                "hermes own file glob",
                "hermes",
                event(
                    "search_files",
                    serde_json::json!({"pattern": "KEY", "path": "sub", "file_glob": "x/*.rs"}),
                ),
            ),
            (
                "double-quoted script",
                "claude-code",
                bash("bash -c \"echo \\$HOME && cat ../a/README.md\""),
            ),
            ("posix class own", "claude-code", bash("ls .[[:alpha:]]*")),
            (
                "posix class own directory",
                "claude-code",
                bash("cat .[[:alpha:]]x/README.md"),
            ),
            // Regression (v2.6.3 kept these): an expansion too large to list
            // that cannot leave the checkout.
            (
                "oversized brace",
                "claude-code",
                bash("touch test/file{1..200}.txt"),
            ),
            (
                "oversized directory brace",
                "claude-code",
                bash("mkdir -p build/{1..100}/out"),
            ),
            (
                "oversized dotted brace",
                "claude-code",
                bash("rm -f logs/app.{1..99}.log"),
            ),
            (
                "oversized product",
                "claude-code",
                bash("cat data/{a..h}{1..9}.csv"),
            ),
        ];
        for (name, agent, raw) in controls {
            let data_dir = tmp.path().join(format!("data-{}", name.replace(' ', "-")));
            let entries = spool_one(&data_dir, agent, None, &raw).await;
            assert_eq!(entries.len(), 1, "{name}");
            assert!(
                entries[0].body.contains("SENTINEL_MUST_NOT_BE_SPOOLED"),
                "{name}: {}",
                entries[0].body
            );
        }
    }

    /// Under the default `basename` strategy the server files two
    /// subdirectories of one unmarked repository under two projects, so an
    /// import from one must not take the other's events. The same directory
    /// still agrees, a subdirectory joins a project rooted at the repository
    /// root, and a `repo-root` marker keeps the whole repository together.
    #[test]
    fn subdirectories_of_one_repository_are_one_project_only_under_repo_root() {
        let tmp = tempfile::tempdir().unwrap();
        let (basename, repo_root) = (tmp.path().join("rr"), tmp.path().join("rt"));
        for repo in [&basename, &repo_root] {
            for sub in ["sub1", "sub2"] {
                std::fs::create_dir_all(repo.join(sub)).unwrap();
            }
            let init = std::process::Command::new("git")
                .args(["init", "-q"])
                .arg(repo)
                .status()
                .unwrap();
            assert!(init.success());
        }
        std::fs::write(
            repo_root.join(".ai-memory.toml"),
            "project_strategy = \"repo-root\"\n",
        )
        .unwrap();
        let path = |dir: &Path| dir.to_string_lossy().into_owned();
        // An empty home keeps a developer's own `~/.ai-memory.toml` (which
        // applies to every cwd) out of the routing decision.
        let home = tempfile::tempdir().unwrap();
        let routes_to_same_project = |source: &str, destination: &str| {
            routes_to_same_project_with(source, destination, |cwd| {
                crate::commands::hook_capture::hook_scope_with_home(cwd, None, Some(home.path()))
            })
        };
        assert!(!routes_to_same_project(
            &path(&basename.join("sub1")),
            &path(&basename.join("sub2"))
        ));
        assert!(!routes_to_same_project(
            &path(&basename.join("sub1")),
            &path(&basename)
        ));
        assert!(routes_to_same_project(
            &path(&basename),
            &path(&basename.join("sub1"))
        ));
        assert!(routes_to_same_project(
            &path(&basename.join("sub1")),
            &path(&basename.join("sub1").join("."))
        ));
        assert!(routes_to_same_project(
            &path(&repo_root.join("sub1")),
            &path(&repo_root.join("sub2"))
        ));
    }

    #[tokio::test]
    async fn shell_command_reading_an_ignored_path_is_dropped_before_spool() {
        for (command, spooled) in [("cat ./secret/*.md | head", 0), ("cat public/readme.md", 1)] {
            for event in ["pre-tool-use", "post-tool-use"] {
                let tmp = tempfile::tempdir().unwrap();
                std::fs::write(
                    tmp.path().join(".ai-memory.toml"),
                    "[capture]\nignore_paths = [\"secret/**\"]\n",
                )
                .unwrap();
                let data_dir = tmp.path().join("data");
                let mut args = devin_hook_args(event);
                args.agent = "claude-code".into();
                let raw = serde_json::json!({
                    "session_id": "shell", "cwd": tmp.path(),
                    "tool_name": "Bash", "tool_input": {"command": command},
                    "tool_response": {"stdout": "SENTINEL_CONTENT"},
                });
                let mut stdout = Vec::new();
                run_with_payload(
                    Some(data_dir.clone()),
                    args,
                    raw.to_string(),
                    &mut stdout,
                    |_, _| panic!("tool events below the threshold must only spool"),
                )
                .await
                .unwrap();
                assert_eq!(
                    hook_spool::spool_len(&hook_spool::spool_dir(&data_dir)),
                    spooled,
                    "{event}: {command}"
                );
            }
        }
    }

    /// Gemini CLI's `run_shell_command` and `read_many_files` were unknown
    /// tools, so the native hook spooled their raw output even when they read
    /// an ignored path. Both events of each call are now dropped before the
    /// spool; public calls are still spooled with their family recorded.
    #[tokio::test]
    async fn gemini_cli_shell_and_read_many_files_exclusions_drop_before_spool() {
        let cases = [
            (
                "run_shell_command",
                serde_json::json!({"command": "cat secret/token.txt"}),
                0,
            ),
            (
                "run_shell_command",
                serde_json::json!({"command": "cat token.txt", "dir_path": "secret"}),
                0,
            ),
            (
                "read_many_files",
                serde_json::json!({"include": ["secret/token.txt"]}),
                0,
            ),
            (
                "read_many_files",
                serde_json::json!({"include": ["README.md", "secret/token.txt"]}),
                0,
            ),
            (
                "read_many_files",
                serde_json::json!({"include": ["**/*.txt"]}),
                0,
            ),
            (
                "run_shell_command",
                serde_json::json!({"command": "cat README.md"}),
                1,
            ),
            (
                "read_many_files",
                serde_json::json!({"include": ["README.md", "src/**/*.rs"]}),
                1,
            ),
        ];
        for (tool, input, spooled) in cases {
            for event in ["pre-tool-use", "post-tool-use"] {
                let tmp = tempfile::tempdir().unwrap();
                std::fs::write(
                    tmp.path().join(".ai-memory.toml"),
                    "[capture]\nignore_paths = [\"secret/**\"]\n",
                )
                .unwrap();
                let data_dir = tmp.path().join("data");
                let mut args = devin_hook_args(event);
                args.agent = "gemini-cli".into();
                let raw = serde_json::json!({
                    "session_id": "gemini", "cwd": tmp.path(),
                    "tool_name": tool, "tool_input": input,
                    "tool_response": {"llmContent": "SENTINEL_CONTENT"},
                });
                run_with_payload(
                    Some(data_dir.clone()),
                    args,
                    raw.to_string(),
                    &mut Vec::new(),
                    |_, _| panic!("tool events below the threshold must only spool"),
                )
                .await
                .unwrap();
                let spool = hook_spool::spool_dir(&data_dir);
                let entries = if spool.exists() {
                    read_spooled_entries(&spool)
                } else {
                    Vec::new()
                };
                assert_eq!(entries.len(), spooled, "{event}: {tool} {input}");
                for entry in &entries {
                    let body: serde_json::Value = serde_json::from_str(&entry.body).unwrap();
                    let family = if tool == "read_many_files" {
                        "file"
                    } else {
                        "non-file"
                    };
                    assert_eq!(
                        body["_ai_memory_capture"]["tool_family"], family,
                        "{event}: {tool}"
                    );
                    assert_eq!(
                        body["_ai_memory_capture"]["disposition"], "keep",
                        "{event}: {tool}"
                    );
                }
            }
        }
    }

    /// Calls that used to carry an excluded file's content into the spool: a
    /// Gemini `read_many_files` directory entry (read as `entry/**`), Copilot
    /// CLI's runtime `view`/`create`, tools reading back an earlier command's
    /// output, and a shell word with brace expansion or a bracket class. Each
    /// attempt is dropped or stripped to metadata before the spool; the
    /// public controls still spool with their content.
    #[tokio::test]
    async fn excluded_content_cannot_reach_the_spool_through_unevaluated_tool_shapes() {
        let cases = [
            (
                "gemini-cli",
                "read_many_files",
                serde_json::json!({"include": ["docs"]}),
                None,
            ),
            (
                "gemini-cli",
                "read_many_files",
                serde_json::json!({"include": ["."]}),
                None,
            ),
            (
                "gemini-cli",
                "read_many_files",
                serde_json::json!({"include": ["src"]}),
                Some("keep"),
            ),
            (
                "copilot-cli",
                "view",
                serde_json::json!({"path": "docs/adr/0001.md"}),
                None,
            ),
            (
                "copilot-cli",
                "create",
                serde_json::json!({"path": "docs/adr/0002.md", "file_text": "x"}),
                None,
            ),
            (
                "copilot-cli",
                "view",
                serde_json::json!({"path": "src/lib.rs"}),
                Some("keep"),
            ),
            (
                "copilot-cli",
                "read_bash",
                serde_json::json!({"shellId": "s1"}),
                Some("metadata-only"),
            ),
            (
                "claude-code",
                "BashOutput",
                serde_json::json!({"bash_id": "b1"}),
                Some("metadata-only"),
            ),
            (
                "claude-code",
                "TaskOutput",
                serde_json::json!({"task_id": "b1"}),
                Some("metadata-only"),
            ),
            (
                "claude-code",
                "Bash",
                serde_json::json!({"command": "cat docs/{adr,x}/0001.md"}),
                Some("metadata-only"),
            ),
            (
                "claude-code",
                "Bash",
                serde_json::json!({"command": "cat docs/ad[r]/0001.md"}),
                Some("metadata-only"),
            ),
            (
                "claude-code",
                "Bash",
                serde_json::json!({"command": "cat 'docs/{adr,x}/0001.md'"}),
                Some("keep"),
            ),
        ];
        for (agent, tool, input, expected) in cases {
            let tmp = tempfile::tempdir().unwrap();
            std::fs::write(
                tmp.path().join(".ai-memory.toml"),
                "[capture]\nignore_paths = [\"docs/adr/**\"]\n",
            )
            .unwrap();
            let data_dir = tmp.path().join("data");
            let raw = serde_json::json!({
                "session_id": "gaps", "cwd": tmp.path(),
                "tool_name": tool, "tool_input": input,
                "tool_response": {"content": "SENTINEL_CONTENT"},
                "tool_result": {"result_type": "success", "text_result_for_llm": "SENTINEL_CONTENT"},
            });
            let entries = spool_one(&data_dir, agent, None, &raw).await;
            let label = format!("{agent} {tool} {input}");
            match expected {
                None => assert!(entries.is_empty(), "{label}: must not spool"),
                Some(disposition) => {
                    assert_eq!(entries.len(), 1, "{label}");
                    let body: serde_json::Value = serde_json::from_str(&entries[0].body).unwrap();
                    assert_eq!(
                        body["_ai_memory_capture"]["disposition"], disposition,
                        "{label}"
                    );
                    assert_eq!(
                        entries[0].body.contains("SENTINEL_CONTENT"),
                        disposition == "keep",
                        "{label}"
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn codex_native_capture_policy_runs_before_spool_and_preserves_identity() {
        for (tool, input, disposition) in [
            (
                "read_file",
                serde_json::json!({"path": "secret/private.txt"}),
                CaptureDisposition::Drop,
            ),
            (
                "apply_patch",
                serde_json::json!({"command": "*** Begin Patch\n*** Add File: secret/private.txt\n+PRIVATE_CONTENT\n*** End Patch"}),
                CaptureDisposition::MetadataOnly,
            ),
            (
                "apply_patch",
                serde_json::json!(null),
                CaptureDisposition::MetadataOnly,
            ),
        ] {
            for event in ["pre-tool-use", "post-tool-use"] {
                let tmp = tempfile::tempdir().unwrap();
                std::fs::write(
                    tmp.path().join(".ai-memory.toml"),
                    "workspace = \"native\"\nproject = \"codex\"\n[capture]\nignore_paths = [\"secret/**\"]\n",
                ).unwrap();
                let data_dir = tmp.path().join("data");
                let mut args = devin_hook_args(event);
                args.agent = "codex".into();
                let raw = serde_json::json!({
                    "session_id": "native-codex", "cwd": tmp.path(), "turn_id": "turn-1",
                    "hook_event_name": if event == "pre-tool-use" { "PreToolUse" } else { "PostToolUse" },
                    "tool_name": tool, "tool_input": input, "tool_use_id": "call-native-1",
                    "tool_response": {"content": [{"type": "text", "text": "PRIVATE_CONTENT"}]},
                });
                let mut stdout = Vec::new();
                run_with_payload(
                    Some(data_dir.clone()),
                    args,
                    raw.to_string(),
                    &mut stdout,
                    |_, _| {
                        panic!("tool events below the threshold must only spool");
                    },
                )
                .await
                .unwrap();
                assert_eq!(stdout, b"{}\n");
                let spool = hook_spool::spool_dir(&data_dir);
                if disposition == CaptureDisposition::Drop {
                    assert!(!spool.exists());
                } else {
                    let entries = read_spooled_entries(&spool);
                    assert_eq!(entries.len(), 1);
                    let entry = &entries[0];
                    assert_eq!(query_param(&entry.url, "agent"), Some("codex"));
                    assert_eq!(query_param(&entry.url, "workspace"), Some("native"));
                    assert_eq!(query_param(&entry.url, "project"), Some("codex"));
                    assert!(query_param(&entry.url, "ingest_key").is_some());
                    assert!(!entry.body.contains("PRIVATE_CONTENT"));
                    assert!(!entry.body.contains("private.txt"));
                    let body: serde_json::Value = serde_json::from_str(&entry.body).unwrap();
                    assert_eq!(body["session_id"], "native-codex");
                    assert_eq!(body["tool_call_id"], "call-native-1");
                    assert_eq!(body["_ai_memory_capture"]["disposition"], "metadata-only");
                    assert_eq!(
                        body["_ai_memory_capture"]["extraction_state"],
                        "missing-or-malformed"
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn hermes_file_exclusion_drops_before_spool_or_drain() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(".ai-memory.toml"),
            "[capture]\nignore_paths = [\"secret/**\"]\n",
        )
        .unwrap();
        let data_dir = tmp.path().join("data");
        let mut stdout = Vec::new();
        let called = std::cell::Cell::new(false);
        let mut args = devin_hook_args("post-tool-use");
        args.agent = "hermes".into();
        let raw = serde_json::json!({
            "hook_event_name": "post_tool_call",
            "tool_name": "write_file",
            "tool_input": {
                "path": "secret/token.txt",
                "content": "SENTINEL_MUST_NOT_BE_SPOOLED"
            },
            "session_id": "hermes-session",
            "cwd": tmp.path(),
            "extra": {"tool_call_id": "call-42", "status": "ok"}
        });
        run_with_payload(
            Some(data_dir.clone()),
            args,
            raw.to_string(),
            &mut stdout,
            |_, _| {
                called.set(true);
                Ok(())
            },
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"{}\n");
        assert!(!called.get());
        assert_eq!(hook_spool::spool_len(&hook_spool::spool_dir(&data_dir)), 0);
    }

    #[tokio::test]
    async fn pool_file_exclusion_drops_before_spool_or_drain() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(".ai-memory.toml"),
            "[capture]\nignore_paths = [\"secret/**\"]\n",
        )
        .unwrap();
        let data_dir = tmp.path().join("data");
        let mut stdout = Vec::new();
        let called = std::cell::Cell::new(false);
        let mut args = devin_hook_args("post-tool-use");
        args.agent = "pool".into();
        let raw = serde_json::json!({
            "hook_event_name": "PostToolUse",
            "tool_name": "write",
            "tool_input": {
                "path": "secret/token.txt",
                "content": "SENTINEL_MUST_NOT_BE_SPOOLED"
            },
            "session_id": "pool-session",
            "cwd": tmp.path()
        });
        run_with_payload(
            Some(data_dir.clone()),
            args,
            raw.to_string(),
            &mut stdout,
            |_, _| {
                called.set(true);
                Ok(())
            },
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"{}\n");
        assert!(!called.get());
        assert_eq!(hook_spool::spool_len(&hook_spool::spool_dir(&data_dir)), 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn capture_drop_handles_symlinked_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(
            project.join(".ai-memory.toml"),
            "[capture]\nignore_paths = [\"secret/**\"]\n",
        )
        .unwrap();
        let alias = tmp.path().join("project-alias");
        std::os::unix::fs::symlink(&project, &alias).unwrap();

        let data_dir = tmp.path().join("data");
        let mut stdout = Vec::new();
        let called = std::cell::Cell::new(false);
        run_with_payload(
            Some(data_dir.clone()),
            devin_hook_args("post-tool-use"),
            serde_json::json!({
                "cwd": alias,
                "tool_name": "Edit",
                "tool_input": {"path": "secret/SENTINEL"}
            })
            .to_string(),
            &mut stdout,
            |_, _| {
                called.set(true);
                Ok(())
            },
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"{}\n");
        assert!(!called.get());
        assert_eq!(hook_spool::spool_len(&hook_spool::spool_dir(&data_dir)), 0);
    }

    #[tokio::test]
    async fn invalid_capture_marker_spools_only_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(".ai-memory.toml"),
            "[capture]\nunknown = 1\n",
        )
        .unwrap();
        let data_dir = tmp.path().join("data");
        let mut stdout = Vec::new();
        run_with_payload(Some(data_dir.clone()), devin_hook_args("post-tool-use"), serde_json::json!({"cwd":tmp.path(),"tool_name":"Edit","tool_input":{"path":"SENTINEL_PATH","args":"SENTINEL_ARGS"},"output":"SENTINEL_OUTPUT","error":"SENTINEL_ERROR","nested":{"raw":"SENTINEL_NESTED"}}).to_string(), &mut stdout, |_, _| Ok(())).await.unwrap();
        let entry = read_spooled_entries(&hook_spool::spool_dir(&data_dir))
            .pop()
            .unwrap();
        for sentinel in [
            "SENTINEL_PATH",
            "SENTINEL_ARGS",
            "SENTINEL_OUTPUT",
            "SENTINEL_ERROR",
            "SENTINEL_NESTED",
        ] {
            assert!(!entry.body.contains(sentinel));
        }
        assert!(entry.body.contains("_ai_memory_capture"));
    }

    #[tokio::test]
    async fn check_capture_has_no_spool_side_effects() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let mut args = devin_hook_args("post-tool-use");
        args.check_capture = true;
        let mut stdout = Vec::new();
        run_with_payload(Some(data_dir.clone()), args, serde_json::json!({"cwd":tmp.path(),"tool_name":"Edit","tool_input":{"path":"SENTINEL"}}).to_string(), &mut stdout, |_, _| Err(std::io::Error::other("must not spawn"))).await.unwrap();
        let output: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
        // Pin the exact key set, not just its size: `--check-capture` is how an
        // operator verifies an opt-out, so a field silently appearing or
        // vanishing here is a defect in its own right.
        let mut keys: Vec<&str> = output
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "admits_capture",
                "capture_mode",
                "disposition",
                "event_admits_capture",
                "extraction_state",
                "marker_present",
                "path_count",
                "policy_admits_capture",
                "policy_state",
                "scope",
                "scope_resolution",
                "server_profile",
                "server_resolution",
                "tool_family",
                "version",
            ]
        );
        assert_eq!(hook_spool::spool_len(&hook_spool::spool_dir(&data_dir)), 0);
        assert!(!String::from_utf8(stdout).unwrap().contains("SENTINEL"));
    }

    #[tokio::test]
    async fn check_capture_refuses_partial_scope_and_excluded_content() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let marker = tmp.path().join(".ai-memory.toml");
        for (declaration, path, admits, resolution) in [
            ("workspace = \"team\"\n", "public.txt", false, "partial"),
            (
                "workspace = \"team\"\nproject = \"app\"\n",
                "secret/token.txt",
                false,
                "explicit",
            ),
            (
                "workspace = \"team\"\nproject = \"app\"\n",
                "public.txt",
                true,
                "explicit",
            ),
        ] {
            std::fs::write(
                &marker,
                format!("{declaration}[capture]\nignore_paths = [\"secret/**\"]\n"),
            )
            .unwrap();
            let mut args = devin_hook_args("post-tool-use");
            args.check_capture = true;
            let mut stdout = Vec::new();
            run_with_payload(
                Some(data_dir.clone()), args,
                serde_json::json!({"cwd":tmp.path(), "tool_name":"Edit", "tool_input":{"path":path,"content":"PRIVATE_CONTENT_SENTINEL"}}).to_string(),
                &mut stdout,
                |_, _| Err(std::io::Error::other("inspection must not spawn")),
            ).await.unwrap();
            let report: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
            assert_eq!(report["policy_admits_capture"], admits, "{report}");
            assert_eq!(report["scope_resolution"], resolution);
            assert_eq!(report["scope"]["workspace"], "team");
            let printed = String::from_utf8(stdout).unwrap();
            assert!(!printed.contains("PRIVATE_CONTENT_SENTINEL"));
            assert!(!printed.contains("token.txt"));
            assert!(!data_dir.exists());
        }
    }

    /// `--check-capture` is how an operator verifies what the native hook will
    /// do, so its report must agree with what the same payload actually leaves
    /// in the spool. Each marker variant runs through both paths with the same
    /// payload cwd and capture mode: the event reaches the spool exactly when
    /// `admits_capture` holds and the disposition is not `drop`, and a
    /// `metadata-only` report means the spooled body is metadata only.
    #[tokio::test]
    async fn check_capture_report_matches_the_native_spool_decision() {
        let tmp = tempfile::tempdir().unwrap();
        let allowlist = Some(crate::cli::CaptureModeArg::Allowlist);
        // (name, marker, tool path, admits_capture, policy_admits_capture,
        //  scope_resolution, disposition)
        for (name, marker, path, admits, policy_admits, resolution, disposition) in [
            (
                "project-only",
                Some("project = \"app\"\n"),
                "public.txt",
                true,
                false,
                "partial",
                "keep",
            ),
            (
                "workspace-only",
                Some("workspace = \"team\"\n"),
                "public.txt",
                true,
                false,
                "partial",
                "keep",
            ),
            (
                "both",
                Some("workspace = \"team\"\nproject = \"app\"\n"),
                "public.txt",
                true,
                true,
                "explicit",
                "keep",
            ),
            // Names outside the recommended lowercase convention are forwarded
            // as given; the hook does not judge them.
            (
                "unconventional-names",
                Some("workspace = \"../evil\"\nproject = \"Bad Name!\"\n"),
                "public.txt",
                true,
                true,
                "explicit",
                "keep",
            ),
            (
                "empty-project",
                Some("workspace = \"team\"\nproject = \"\"\n"),
                "public.txt",
                true,
                false,
                "partial",
                "keep",
            ),
            (
                "invalid-toml",
                Some("workspace = \"team\nproject = [\n"),
                "public.txt",
                true,
                true,
                "server-derived",
                "metadata-only",
            ),
            (
                "capture-exclusion",
                Some(
                    "workspace = \"team\"\nproject = \"app\"\n\
                     [capture]\nignore_paths = [\"secret/**\"]\n",
                ),
                "secret/token.txt",
                true,
                false,
                "explicit",
                "drop",
            ),
            (
                "no-marker",
                None,
                "public.txt",
                false,
                false,
                "server-derived",
                "keep",
            ),
        ] {
            let repo = tmp.path().join(name);
            std::fs::create_dir_all(&repo).unwrap();
            if let Some(marker) = marker {
                std::fs::write(repo.join(".ai-memory.toml"), marker).unwrap();
            }
            let raw = serde_json::json!({
                "cwd": repo,
                "tool_name": "Edit",
                "tool_input": {"path": path, "content": "PRIVATE_CONTENT_SENTINEL"}
            });

            let check_data = tmp.path().join(format!("check-{name}"));
            let mut args = devin_hook_args("post-tool-use");
            args.check_capture = true;
            args.capture_mode = allowlist;
            let mut stdout = Vec::new();
            run_with_payload(
                Some(check_data.clone()),
                args,
                raw.to_string(),
                &mut stdout,
                |_, _| Err(std::io::Error::other("inspection must not spawn")),
            )
            .await
            .unwrap();
            let report: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
            assert!(!check_data.exists(), "{name}: inspection wrote state");
            assert_eq!(report["admits_capture"], admits, "{name}: {report}");
            assert_eq!(
                report["policy_admits_capture"], policy_admits,
                "{name}: {report}"
            );
            assert_eq!(report["scope_resolution"], resolution, "{name}: {report}");
            assert_eq!(report["disposition"], disposition, "{name}: {report}");

            let entries = spool_one(
                &tmp.path().join(format!("spool-{name}")),
                "devin",
                allowlist,
                &raw,
            )
            .await;
            let reported_spool =
                report["admits_capture"] == true && report["disposition"] != "drop";
            assert_eq!(
                entries.len(),
                usize::from(reported_spool),
                "{name}: check-capture reported {report} but the native hook spooled {}",
                entries.len()
            );
            if let Some(entry) = entries.first() {
                let metadata_only = entry.body.contains("\"disposition\":\"metadata-only\"");
                assert_eq!(
                    metadata_only,
                    report["disposition"] == "metadata-only",
                    "{name}: {}",
                    entry.body
                );
                assert_eq!(
                    entry.body.contains("PRIVATE_CONTENT_SENTINEL"),
                    !metadata_only,
                    "{name}: {}",
                    entry.body
                );
            }
        }
    }

    #[tokio::test]
    async fn check_capture_bounds_marker_hints_and_refuses_oversized_scope() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        for (workspace, identity, admits) in [
            ("x".repeat(513), "app".to_owned(), false),
            ("team".to_owned(), "y".repeat(513), false),
            ("team".to_owned(), "y".repeat(512), true),
        ] {
            std::fs::write(
                tmp.path().join(".ai-memory.toml"),
                format!(
                    "workspace = \"{workspace}\"\nproject = \"app\"\nidentity = \"{identity}\"\n"
                ),
            )
            .unwrap();
            let mut args = devin_hook_args("post-tool-use");
            args.check_capture = true;
            let mut stdout = Vec::new();
            run_with_payload(
                Some(data_dir.clone()), args,
                serde_json::json!({"cwd":tmp.path(), "tool_name":"Edit", "tool_input":{"path":"public.txt"}}).to_string(),
                &mut stdout,
                |_, _| Err(std::io::Error::other("inspection must not spawn")),
            ).await.unwrap();
            let report: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
            assert_eq!(report["policy_admits_capture"], admits, "{report}");
            assert_eq!(
                report["scope_resolution"],
                if admits { "explicit" } else { "unavailable" }
            );
            assert_eq!(report["scope"]["project"], "app");
            let printed = String::from_utf8(stdout).unwrap();
            for (field, value) in [("workspace", &workspace), ("identity", &identity)] {
                if value.len() > 512 {
                    assert!(report["scope"][field].is_null(), "{report}");
                    assert!(!printed.contains(value));
                } else {
                    assert_eq!(report["scope"][field], value.as_str());
                }
            }
            assert!(!data_dir.exists());
            // Inspection bounds do not change the native routing contract.
            let suffix = marker_query_suffix(tmp.path().to_str().unwrap(), None);
            assert!(suffix.contains(&workspace));
            assert!(suffix.contains(&format!("&identity={identity}")));
        }
    }

    #[tokio::test]
    async fn check_capture_reports_rejected_lifecycle_without_delivery() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let mut args = devin_hook_args("session-start");
        args.agent = "antigravity-cli".into();
        args.check_capture = true;
        let mut stdout = Vec::new();
        run_with_payload(
            Some(data_dir.clone()),
            args,
            serde_json::json!({"cwd":tmp.path(),"invocationNum":4}).to_string(),
            &mut stdout,
            |_, _| Err(std::io::Error::other("inspection must not spawn")),
        )
        .await
        .unwrap();
        let report: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
        assert_eq!(report["event_admits_capture"], false);
        assert_eq!(report["policy_admits_capture"], false);
        assert!(!data_dir.exists());
    }

    #[tokio::test]
    async fn inactive_preserves_bytes_and_active_keep_adds_protocol() {
        let tmp = tempfile::tempdir().unwrap();
        let inactive_data = tmp.path().join("inactive-data");
        let inactive_payload =
            serde_json::json!({"cwd":tmp.path(),"tool_name":"Edit","tool_input":{"path":"public"}})
                .to_string();
        let mut stdout = Vec::new();
        run_with_payload(
            Some(inactive_data.clone()),
            devin_hook_args("post-tool-use"),
            inactive_payload.clone(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(
            read_spooled_entries(&hook_spool::spool_dir(&inactive_data))[0].body,
            inactive_payload
        );

        std::fs::write(
            tmp.path().join(".ai-memory.toml"),
            "[capture]\nignore_paths = [\"secret/**\"]\n",
        )
        .unwrap();
        let active_data = tmp.path().join("active-data");
        run_with_payload(
            Some(active_data.clone()),
            devin_hook_args("post-tool-use"),
            serde_json::json!({"cwd":tmp.path(),"tool_name":"Edit","tool_input":{"path":"public"}})
                .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        let body: serde_json::Value = serde_json::from_str(
            &read_spooled_entries(&hook_spool::spool_dir(&active_data))[0].body,
        )
        .unwrap();
        assert_eq!(body["_ai_memory_capture"]["disposition"], "keep");
        assert_eq!(body["_ai_memory_capture"]["policy_state"], "active");
    }

    #[tokio::test]
    async fn antigravity_pre_tool_capture_drop_still_allows_the_tool() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(".ai-memory.toml"),
            "workspace = \"canonical\"\n[capture]\nignore_paths = [\"secret/**\"]\n",
        )
        .unwrap();
        let data_dir = tmp.path().join("data");
        let mut args = devin_hook_args("pre-tool-use");
        args.agent = "antigravity-cli".into();
        let mut stdout = Vec::new();
        let raw = serde_json::json!({"workspacePaths":[tmp.path()],"toolCall":{"name":"Edit","args":{"path":"secret/a"}}});
        assert!(cwd_query_suffix("antigravity-cli", &raw, None).contains("workspace=canonical"));
        run_with_payload(
            Some(data_dir.clone()),
            args,
            raw.to_string(),
            &mut stdout,
            |_, _| Err(std::io::Error::other("must not spawn")),
        )
        .await
        .unwrap();
        assert_eq!(stdout, b"{\"decision\": \"allow\"}\n");
        assert_eq!(hook_spool::spool_len(&hook_spool::spool_dir(&data_dir)), 0);
    }

    #[tokio::test]
    async fn metadata_only_canonicalizes_supported_session_aliases() {
        for (key, value) in [
            ("session_id", serde_json::json!("one")),
            ("sessionId", serde_json::json!("two")),
            ("sessionID", serde_json::json!("three")),
            ("conversationId", serde_json::json!("four")),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            std::fs::write(
                tmp.path().join(".ai-memory.toml"),
                "[capture]\nunknown = true\n",
            )
            .unwrap();
            let data_dir = tmp.path().join("data");
            let mut raw = serde_json::json!({"cwd":tmp.path(),"tool_name":"Edit","tool_input":{"path":"secret"}});
            raw.as_object_mut()
                .unwrap()
                .insert(key.into(), value.clone());
            let mut stdout = Vec::new();
            run_with_payload(
                Some(data_dir.clone()),
                devin_hook_args("post-tool-use"),
                raw.to_string(),
                &mut stdout,
                |_, _| Ok(()),
            )
            .await
            .unwrap();
            let body: serde_json::Value = serde_json::from_str(
                &read_spooled_entries(&hook_spool::spool_dir(&data_dir))[0].body,
            )
            .unwrap();
            assert_eq!(body["session_id"], value, "{key}");
        }
    }

    fn grok_hook_args(event: &str, server_url: &str) -> HookArgs {
        HookArgs {
            event: event.into(),
            agent: "grok".into(),
            server_url: server_url.into(),
            auth_token: None,
            project_strategy: None,
            check_capture: false,
            capture_assistant: false,
            capture_mode: None,
        }
    }

    #[tokio::test]
    async fn antigravity_post_tool_use_spools_enriched_output() {
        let tmp = tempfile::tempdir().unwrap();
        let artifact_dir = tmp.path().join("brain").join("conv-123");
        let step_dir = artifact_dir
            .join(".system_generated")
            .join("steps")
            .join("7");
        std::fs::create_dir_all(&step_dir).unwrap();
        std::fs::write(
            step_dir.join("output.txt"),
            "npm test passed with 0 errors\n",
        )
        .unwrap();

        let data_dir = tmp.path().join("data");
        let raw = serde_json::json!({
            "conversationId": "conv-123",
            "workspacePaths": [tmp.path().to_str().unwrap()],
            "toolCall": {
                "name": "run_command",
                "args": {
                    "CommandLine": "npm test"
                }
            },
            "stepIdx": 7,
            "artifactDirectoryPath": artifact_dir.to_str().unwrap()
        });

        let mut stdout = Vec::new();
        let args = HookArgs {
            event: "post-tool-use".into(),
            agent: "antigravity-cli".into(),
            server_url: "http://127.0.0.1:41399".into(),
            auth_token: None,
            project_strategy: None,
            check_capture: false,
            capture_assistant: false,
            capture_mode: None,
        };

        run_with_payload(
            Some(data_dir.clone()),
            args,
            raw.to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        let spooled = read_spooled_entries(&hook_spool::spool_dir(&data_dir));
        assert_eq!(spooled.len(), 1);
        let body: serde_json::Value = serde_json::from_str(&spooled[0].body).unwrap();
        assert_eq!(
            body.get("tool_response")
                .and_then(serde_json::Value::as_str),
            Some("npm test passed with 0 errors")
        );
    }

    fn kimi_hook_args(event: &str, server_url: &str) -> HookArgs {
        HookArgs {
            event: event.into(),
            agent: "kimi-code".into(),
            server_url: server_url.into(),
            auth_token: None,
            project_strategy: None,
            check_capture: false,
            capture_assistant: false,
            capture_mode: None,
        }
    }

    fn kiro_hook_args(event: &str, server_url: &str) -> HookArgs {
        HookArgs {
            event: event.into(),
            agent: "kiro-cli".into(),
            server_url: server_url.into(),
            auth_token: None,
            project_strategy: None,
            check_capture: false,
            capture_assistant: false,
            capture_mode: None,
        }
    }

    fn copilot_cli_hook_args(event: &str, server_url: &str) -> HookArgs {
        HookArgs {
            event: event.into(),
            agent: "copilot-cli".into(),
            server_url: server_url.into(),
            auth_token: None,
            project_strategy: None,
            check_capture: false,
            capture_assistant: false,
            capture_mode: None,
        }
    }

    fn antigravity_hook_args(event: &str, server_url: &str) -> HookArgs {
        HookArgs {
            event: event.into(),
            agent: "antigravity-cli".into(),
            server_url: server_url.into(),
            auth_token: None,
            project_strategy: None,
            check_capture: false,
            capture_assistant: false,
            capture_mode: None,
        }
    }

    /// Recording HTTP stub: replies to every request with `status`/`body` and
    /// streams each request head back so tests can assert which endpoints the
    /// hook touched (session-start also drains the spool, so POSTs to `/hook`
    /// are legitimate traffic here — only `GET /handoff` is interesting).
    async fn serve_requests(
        status: &'static str,
        body: &'static str,
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = [0_u8; 8192];
                let read = stream.read(&mut buf).await.unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..read]).into_owned());
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (format!("http://{addr}"), rx)
    }

    /// Wait briefly for the first recorded request (if any).
    async fn first_request(
        requests: &mut tokio::sync::mpsc::UnboundedReceiver<String>,
    ) -> Option<String> {
        tokio::time::timeout(Duration::from_millis(500), requests.recv())
            .await
            .ok()
            .flatten()
    }

    #[tokio::test]
    async fn antigravity_initial_invocation_fetches_with_native_output_contract() {
        let tmp = tempfile::tempdir().unwrap();
        let (base, mut requests) = serve_requests("200 OK", "AGY-HANDOFF").await;
        let mut stdout = Vec::new();
        run_with_payload(
            Some(tmp.path().join("data")),
            antigravity_hook_args("session-start", &base),
            serde_json::json!({
                "invocationNum": 0,
                "initialNumSteps": 0,
                "conversationId": "agy-conversation",
                "workspacePaths": [tmp.path()]
            })
            .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        let output: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
        assert_eq!(
            output,
            serde_json::json!({
                "injectSteps": [{"ephemeralMessage": "AGY-HANDOFF"}]
            })
        );
        let mut recorded = Vec::new();
        while let Some(request) = first_request(&mut requests).await {
            recorded.push(request);
        }
        assert!(
            recorded
                .iter()
                .any(|request| request.starts_with("POST /hook")),
            "{recorded:?}"
        );
        assert!(
            recorded.iter().any(|request| {
                request.starts_with("GET /handoff?")
                    && request.contains("session_id=agy-conversation")
            }),
            "{recorded:?}"
        );
    }

    #[tokio::test]
    async fn antigravity_later_invocation_has_no_capture_or_handoff_side_effects() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let (base, mut requests) = serve_requests("200 OK", "MUST-NOT-BE-CONSUMED").await;
        let mut stdout = Vec::new();
        run_with_payload(
            Some(data_dir.clone()),
            antigravity_hook_args("session-start", &base),
            serde_json::json!({
                "invocationNum": 4,
                "initialNumSteps": 12,
                "conversationId": "agy-conversation",
                "workspacePaths": [tmp.path()]
            })
            .to_string(),
            &mut stdout,
            |_, _| Err(std::io::Error::other("must not spawn")),
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"{}\n");
        assert!(first_request(&mut requests).await.is_none());
        assert_eq!(hook_spool::spool_len(&hook_spool::spool_dir(&data_dir)), 0);
    }

    #[tokio::test]
    async fn kiro_session_start_prints_handoff_verbatim() {
        let tmp = tempfile::tempdir().unwrap();
        let (base, mut requests) = serve_requests("200 OK", "KIRO-HANDOFF").await;
        let mut stdout = Vec::new();
        run_with_payload(
            Some(tmp.path().join("data")),
            kiro_hook_args("session-start", &base),
            serde_json::json!({
                "session_id": "kiro-session",
                "cwd": tmp.path()
            })
            .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"KIRO-HANDOFF\n");
        let mut recorded = Vec::new();
        while let Some(request) = first_request(&mut requests).await {
            recorded.push(request);
        }
        assert!(
            recorded.iter().any(|request| {
                request.starts_with("GET /handoff?")
                    && request.contains("agent=kiro-cli")
                    && request.contains("session_id=kiro-session")
            }),
            "{recorded:?}"
        );
    }

    #[tokio::test]
    async fn copilot_cli_session_start_prints_top_level_handoff_envelope() {
        let tmp = tempfile::tempdir().unwrap();
        let (base, mut requests) = serve_requests("200 OK", "COPILOT-HANDOFF").await;
        let mut stdout = Vec::new();
        run_with_payload(
            Some(tmp.path().join("data")),
            copilot_cli_hook_args("session-start", &base),
            serde_json::json!({
                "session_id": "copilot-session",
                "cwd": tmp.path()
            })
            .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        let envelope: serde_json::Value = serde_json::from_slice(stdout.trim_ascii()).unwrap();
        assert_eq!(
            envelope,
            serde_json::json!({"additionalContext": "COPILOT-HANDOFF"})
        );
        assert!(
            envelope.get("hookSpecificOutput").is_none(),
            "Copilot reads the top-level SessionStart envelope"
        );
        let mut recorded = Vec::new();
        while let Some(request) = first_request(&mut requests).await {
            recorded.push(request);
        }
        assert!(
            recorded.iter().any(|request| {
                request.starts_with("GET /handoff?")
                    && request.contains("agent=copilot-cli")
                    && request.contains("session_id=copilot-session")
            }),
            "{recorded:?}"
        );
    }

    /// Droid documents SessionStart stdout as context and parses a JSON
    /// stdout's `hookSpecificOutput.additionalContext`, so `--agent droid`
    /// fetches the handoff and prints Claude Code's envelope (#1240).
    #[tokio::test]
    async fn droid_session_start_prints_hook_specific_handoff_envelope() {
        let tmp = tempfile::tempdir().unwrap();
        let (base, mut requests) = serve_requests("200 OK", "DROID-HANDOFF").await;
        let mut stdout = Vec::new();
        run_with_payload(
            Some(tmp.path().join("data")),
            HookArgs {
                agent: "droid".into(),
                ..copilot_cli_hook_args("session-start", &base)
            },
            serde_json::json!({
                "session_id": "droid-session",
                "transcript_path": tmp.path().join("s.jsonl"),
                "cwd": tmp.path(),
                "permission_mode": "auto-low",
                "hook_event_name": "SessionStart",
                "source": "startup"
            })
            .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        let envelope: serde_json::Value = serde_json::from_slice(stdout.trim_ascii()).unwrap();
        assert_eq!(
            envelope,
            serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": "DROID-HANDOFF",
                }
            })
        );
        let mut recorded = Vec::new();
        while let Some(request) = first_request(&mut requests).await {
            recorded.push(request);
        }
        assert!(
            recorded.iter().any(|request| {
                request.starts_with("GET /handoff?")
                    && request.contains("agent=droid")
                    && request.contains("session_id=droid-session")
            }),
            "{recorded:?}"
        );
    }

    /// Muse injects SessionStart's `hookSpecificOutput.additionalContext` as
    /// developer context (verified offline on Muse Code 1.4.7), so `--agent
    /// muse` fetches the handoff for the payload's UUIDv7 session id and
    /// prints Claude Code's envelope.
    #[tokio::test]
    async fn muse_session_start_prints_hook_specific_handoff_envelope() {
        let tmp = tempfile::tempdir().unwrap();
        let (base, mut requests) = serve_requests("200 OK", "MUSE-HANDOFF").await;
        let mut stdout = Vec::new();
        run_with_payload(
            Some(tmp.path().join("data")),
            HookArgs {
                agent: "muse".into(),
                ..copilot_cli_hook_args("session-start", &base)
            },
            serde_json::json!({
                "cwd": tmp.path(),
                "hook_event_name": "SessionStart",
                "model": "muse-wonder-1.0",
                "model_provider": "meta",
                "permission_mode": "bypassPermissions",
                "session_id": "01a13669-dc61-7a72-b5ec-ad2f300ffd26",
                "source": "startup",
                "transcript_path": null
            })
            .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        let envelope: serde_json::Value = serde_json::from_slice(stdout.trim_ascii()).unwrap();
        assert_eq!(
            envelope,
            serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": "MUSE-HANDOFF",
                }
            })
        );
        let mut recorded = Vec::new();
        while let Some(request) = first_request(&mut requests).await {
            recorded.push(request);
        }
        assert!(
            recorded.iter().any(|request| {
                request.starts_with("GET /handoff?")
                    && request.contains("agent=muse")
                    && request.contains("session_id=01a13669-dc61-7a72-b5ec-ad2f300ffd26")
            }),
            "{recorded:?}"
        );
    }

    /// Muse adds SessionStart and UserPromptSubmit stdout to the turn as
    /// developer context, so with no handoff to deliver the hook prints
    /// nothing there, never `{}`. Control: its Stop still replies `{}`, and
    /// Droid's prompt hook still prints `{}`.
    #[tokio::test]
    async fn muse_context_events_print_nothing_without_a_handoff() {
        let run = |agent: &'static str, event: &'static str| async move {
            let tmp = tempfile::tempdir().unwrap();
            let (base, _requests) = serve_requests("404 Not Found", "").await;
            let mut stdout = Vec::new();
            run_with_payload(
                Some(tmp.path().join("data")),
                HookArgs {
                    agent: agent.into(),
                    ..copilot_cli_hook_args(event, &base)
                },
                serde_json::json!({
                    "cwd": tmp.path(),
                    "hook_event_name": "UserPromptSubmit",
                    "prompt": "Please do the file steps.",
                    "session_id": "01a13669-dc61-7a72-b5ec-ad2f300ffd26",
                    "transcript_path": null,
                    "turn_id": "ccfe4a87-c654-49f5-b5e9-473015c7a90b"
                })
                .to_string(),
                &mut stdout,
                |_, _| Ok(()),
            )
            .await
            .unwrap();
            String::from_utf8(stdout).unwrap()
        };
        assert_eq!(run("muse", "user-prompt-submit").await, "");
        assert_eq!(run("muse", "session-start").await, "");
        assert_eq!(run("muse", "stop").await.trim(), "{}");
        assert_eq!(run("droid", "user-prompt-submit").await.trim(), "{}");
    }

    // ── #992: per-repository server profiles ─────────────────────────────

    /// Register `name` in `data_dir` with a token and the given roots.
    fn register_profile(
        data_dir: &Path,
        name: &str,
        url: &str,
        roots: &[&Path],
        token: Option<&str>,
    ) {
        let roots: Vec<String> = roots
            .iter()
            .map(|r| r.to_string_lossy().into_owned())
            .collect();
        crate::server_profiles::add(
            data_dir,
            &ProfileName::parse(name).unwrap(),
            url,
            &roots,
            token,
        )
        .unwrap();
    }

    fn repo_with_marker(parent: &Path, name: &str, marker: &str) -> PathBuf {
        let repo = parent.join(name);
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(repo.join(".ai-memory.toml"), marker).unwrap();
        repo
    }

    fn claude_args(event: &str, server_url: &str) -> HookArgs {
        let mut args = devin_hook_args(event);
        args.agent = "claude-code".into();
        args.server_url = server_url.into();
        args
    }

    async fn run_prompt(data_dir: &Path, args: HookArgs, cwd: &Path) -> Vec<u8> {
        let mut stdout = Vec::new();
        run_with_payload(
            Some(data_dir.to_path_buf()),
            args,
            serde_json::json!({"session_id": "s", "cwd": cwd, "prompt": "hello"}).to_string(),
            &mut stdout,
            |_, _| panic!("a prompt must only spool"),
        )
        .await
        .unwrap();
        stdout
    }

    /// The Claude Code plugin passes an unset `server_url` option as "": the
    /// event must go to the install's configured server, never to a bare
    /// `/hook` path. A real flag value still wins.
    #[tokio::test]
    async fn empty_server_url_spools_to_the_configured_server() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let work = tmp.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(
            data_dir.join("config.toml"),
            "server_url = \"http://configured.example:4321\"\n",
        )
        .unwrap();
        // A process-level override outranks the file, exactly as in production.
        let expected = std::env::var("AI_MEMORY_SERVER_URL")
            .ok()
            .filter(|url| !url.trim().is_empty())
            .unwrap_or_else(|| "http://configured.example:4321".to_owned());

        run_prompt(&data_dir, claude_args("user-prompt-submit", ""), &work).await;
        run_prompt(
            &data_dir,
            claude_args("user-prompt-submit", "https://flag.example"),
            &work,
        )
        .await;

        let mut urls: Vec<String> = read_spooled_entries(&hook_spool::spool_dir(&data_dir))
            .into_iter()
            .map(|entry| entry.url)
            .collect();
        urls.sort();
        assert_eq!(urls.len(), 2, "{urls:?}");
        assert!(
            urls.iter()
                .any(|url| url.starts_with(&format!("{}/hook?", expected.trim_end_matches('/')))),
            "{urls:?}"
        );
        assert!(
            urls.iter()
                .any(|url| url.starts_with("https://flag.example/hook?")),
            "{urls:?}"
        );
    }

    /// The origin check reads the plugin marker and the settings files only
    /// through the injected lookup, so it is testable without process env.
    /// Adversarial: a plugin event with a settings hook for the same event is
    /// dropped; the same event without the origin (a settings-launched copy)
    /// is never dropped.
    #[test]
    fn plugin_copy_is_dropped_only_with_the_plugin_origin() {
        let tmp = tempfile::tempdir().unwrap();
        let claude = tmp.path().join("claude");
        std::fs::create_dir_all(&claude).unwrap();
        std::fs::write(
            claude.join("settings.json"),
            r#"{"hooks":{"UserPromptSubmit":[{"matcher":"","hooks":[{"type":"command","command":"/bin/ai-memory hook --event user-prompt-submit --agent claude-code --server-url http://h"}]}]}}"#,
        )
        .unwrap();
        let work = tmp.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        let raw = serde_json::json!({"session_id": "s", "cwd": work, "prompt": "p"});
        let args = claude_args("user-prompt-submit", "http://h");
        let config_dir = claude.to_string_lossy().into_owned();
        let env = |origin: Option<&'static str>| {
            let config_dir = config_dir.clone();
            move |name: &str| match name {
                "CLAUDE_CONFIG_DIR" => Some(config_dir.clone()),
                super::super::plugin_origin::HOOK_ORIGIN_ENV => origin.map(str::to_owned),
                _ => None,
            }
        };

        assert!(is_dropped_plugin_copy(
            &args,
            &raw,
            env(Some("claude-code-plugin"))
        ));
        assert!(!is_dropped_plugin_copy(&args, &raw, env(None)));
        assert!(
            !is_dropped_plugin_copy(
                &claude_args("stop", "http://h"),
                &raw,
                env(Some("claude-code-plugin"))
            ),
            "no settings hook for stop: the plugin delivers it"
        );
    }

    /// Two repositories on one install deliver to two servers, each with its
    /// own token, and neither with the install's persisted one.
    #[tokio::test]
    async fn each_repository_spools_to_its_own_profile_with_its_own_token() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let work = tmp.path().join("work");
        let repo_a = repo_with_marker(&work, "a", "server = \"team-a\"\n");
        let repo_b = repo_with_marker(&work, "b", "workspace = \"b\"\nserver = \"team-b\"\n");
        register_profile(
            &data_dir,
            "team-a",
            "https://a.example",
            &[&repo_a],
            Some("tok-a"),
        );
        register_profile(
            &data_dir,
            "team-b",
            "https://b.example/",
            &[&repo_b],
            Some("tok-b"),
        );
        crate::config::store_hook_auth_token(&data_dir, "INSTALL-TOKEN").unwrap();

        run_prompt(
            &data_dir,
            claude_args("user-prompt-submit", "https://default.example"),
            &repo_a,
        )
        .await;
        run_prompt(
            &data_dir,
            claude_args("user-prompt-submit", "https://default.example"),
            &repo_b,
        )
        .await;

        let entries = read_spooled_entries(&hook_spool::spool_dir(&data_dir));
        assert_eq!(entries.len(), 2);
        assert!(
            entries[0].url.starts_with("https://a.example/hook?"),
            "{}",
            entries[0].url
        );
        assert_eq!(entries[0].token.as_deref(), Some("tok-a"));
        assert_eq!(entries[0].profile.as_deref(), Some("team-a"));
        assert!(
            entries[1].url.starts_with("https://b.example/hook?"),
            "{}",
            entries[1].url
        );
        assert_eq!(entries[1].token.as_deref(), Some("tok-b"));
        assert_eq!(entries[1].profile.as_deref(), Some("team-b"));
    }

    /// Front door for Meta Muse Code's settings.json hooks (adversarial),
    /// with Muse Code 1.4.7 payload shapes: a prompt from a marked checkout
    /// is scoped by its marker, routed to the marker's server profile with
    /// the profile's token (never the install's), and keyed by the payload's
    /// UUIDv7 session id; a `read_file` of an ignored relative path from that
    /// checkout is dropped before the spool while a control path is kept;
    /// allowlist mode emits nothing from an unmarked checkout (printing
    /// nothing either), and the same prompt without allowlist is captured.
    #[tokio::test]
    async fn muse_hooks_honour_marker_scope_profiles_exclusions_and_allowlist() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let repo = repo_with_marker(
            tmp.path(),
            "repo",
            "workspace = \"mw\"\nproject = \"mp\"\nserver = \"team-a\"\n[capture]\nignore_paths = [\"secret/**\"]\n",
        );
        register_profile(
            &data_dir,
            "team-a",
            "https://a.example",
            &[&repo],
            Some("tok-a"),
        );
        crate::config::store_hook_auth_token(&data_dir, "INSTALL-TOKEN").unwrap();
        let session = "01a13669-dc61-7a72-b5ec-ad2f300ffd26";
        let muse = |event: &str| {
            let mut args = claude_args(event, "https://default.example");
            args.agent = "muse".into();
            args
        };
        let run = |args: HookArgs, payload: serde_json::Value| {
            let data_dir = data_dir.clone();
            async move {
                let mut stdout = Vec::new();
                run_with_payload(
                    Some(data_dir),
                    args,
                    payload.to_string(),
                    &mut stdout,
                    |_, _| panic!("a Muse event must only spool"),
                )
                .await
                .unwrap();
                stdout
            }
        };
        let prompt = |cwd: &Path| {
            serde_json::json!({
                "cwd": cwd,
                "hook_event_name": "UserPromptSubmit",
                "model": "muse-wonder-1.0",
                "model_provider": "meta",
                "permission_mode": "bypassPermissions",
                "prompt": "Please do the file steps.",
                "session_id": session,
                "transcript_path": null,
                "turn_id": "ccfe4a87-c654-49f5-b5e9-473015c7a90b"
            })
        };
        let read = |path: &str| {
            serde_json::json!({
                "cwd": repo,
                "hook_event_name": "PostToolUse",
                "session_id": session,
                "tool_input": {"path": path},
                "tool_name": "read_file",
                "tool_response": format!("Read text file `{path}`.\n1|SECRET-BODY"),
                "tool_use_id": "call_bc48188330cd",
                "transcript_path": null
            })
        };

        run(muse("user-prompt-submit"), prompt(&repo)).await;
        let spool = hook_spool::spool_dir(&data_dir);
        let entries = read_spooled_entries(&spool);
        assert_eq!(entries.len(), 1);
        let url = &entries[0].url;
        assert!(url.starts_with("https://a.example/hook?"), "{url}");
        assert_eq!(entries[0].token.as_deref(), Some("tok-a"));
        assert_eq!(query_param(url, "agent"), Some("muse"));
        assert_eq!(query_param(url, "workspace"), Some("mw"));
        assert_eq!(query_param(url, "project"), Some("mp"));
        let body: serde_json::Value = serde_json::from_str(&entries[0].body).unwrap();
        assert_eq!(body["session_id"], session);

        run(muse("post-tool-use"), read("secret/a.txt")).await;
        assert_eq!(
            read_spooled_entries(&spool).len(),
            1,
            "an ignored relative path is dropped before the spool"
        );
        run(muse("post-tool-use"), read("src/lib.rs")).await;
        assert_eq!(read_spooled_entries(&spool).len(), 2, "control path kept");

        let unmarked = tmp.path().join("unmarked");
        std::fs::create_dir_all(&unmarked).unwrap();
        let mut allowlist = muse("user-prompt-submit");
        allowlist.capture_mode = Some(crate::cli::CaptureModeArg::Allowlist);
        let stdout = run(allowlist, prompt(&unmarked)).await;
        assert!(stdout.is_empty(), "{:?}", String::from_utf8_lossy(&stdout));
        assert_eq!(read_spooled_entries(&spool).len(), 2, "allowlist drop");
        run(muse("user-prompt-submit"), prompt(&unmarked)).await;
        let entries = read_spooled_entries(&spool);
        assert_eq!(entries.len(), 3, "control: denylist captures it");
        assert!(
            entries[2].url.starts_with("https://default.example/hook?"),
            "{}",
            entries[2].url
        );
    }

    /// Backward compatibility: without a `server` key the install default is
    /// used exactly as before, and the spooled entry carries no profile.
    #[tokio::test]
    async fn a_repository_without_a_server_key_keeps_the_install_default() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let repo = repo_with_marker(tmp.path(), "repo", "workspace = \"w\"\n");
        register_profile(&data_dir, "team-a", "https://a.example", &[], Some("tok-a"));
        crate::config::store_hook_auth_token(&data_dir, "INSTALL-TOKEN").unwrap();

        run_prompt(
            &data_dir,
            claude_args("user-prompt-submit", "https://default.example"),
            &repo,
        )
        .await;

        let spool = hook_spool::spool_dir(&data_dir);
        let entries = read_spooled_entries(&spool);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].url.starts_with("https://default.example/hook?"));
        assert_eq!(entries[0].token.as_deref(), Some("INSTALL-TOKEN"));
        let raw = std::fs::read_dir(&spool)
            .unwrap()
            .map(|e| std::fs::read_to_string(e.unwrap().path()).unwrap())
            .next()
            .unwrap();
        assert!(!raw.contains("\"profile\""), "{raw}");
    }

    /// Every refusal emits nothing — no spool entry, no drainer — and
    /// `--check-capture` names the reason without a URL, path, or token.
    #[tokio::test]
    async fn a_selection_that_does_not_resolve_emits_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let inside = repo_with_marker(tmp.path(), "inside", "server = \"rooted\"\n");
        let outside = repo_with_marker(tmp.path(), "outside", "server = \"rooted\"\n");
        let unknown = repo_with_marker(tmp.path(), "unknown", "server = \"nobody\"\n");
        let tokenless = repo_with_marker(tmp.path(), "tokenless", "server = \"tokenless\"\n");
        let unrooted = repo_with_marker(tmp.path(), "unrooted", "server = \"unrooted\"\n");
        let bare = repo_with_marker(tmp.path(), "bare", "server = Bad/Name\n");
        register_profile(
            &data_dir,
            "rooted",
            "https://r.example",
            &[&inside],
            Some("tok-r"),
        );
        register_profile(
            &data_dir,
            "tokenless",
            "https://t.example",
            &[&tokenless],
            None,
        );
        register_profile(
            &data_dir,
            "unrooted",
            "https://u.example",
            &[],
            Some("tok-u"),
        );
        crate::config::store_hook_auth_token(&data_dir, "INSTALL-TOKEN").unwrap();

        for (cwd, resolution) in [
            (&outside, "rejected-outside-roots"),
            (&unknown, "rejected-unknown-profile"),
            (&tokenless, "rejected-no-token"),
            (&unrooted, "rejected-roots-required"),
            (&bare, "rejected-invalid-profile-name"),
            (&inside, "marker"),
        ] {
            let mut args = claude_args("user-prompt-submit", "https://default.example");
            args.check_capture = true;
            let stdout = run_prompt(&data_dir, args, cwd).await;
            let output: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
            assert_eq!(output["server_resolution"], resolution, "{}", cwd.display());
            assert_eq!(output["policy_admits_capture"], resolution == "marker");
            let printed = String::from_utf8(stdout).unwrap();
            for secret in ["tok-", "https://", &*tmp.path().to_string_lossy()] {
                assert!(!printed.contains(secret), "{printed}");
            }

            let spool = hook_spool::spool_dir(&data_dir);
            let before = hook_spool::spool_len(&spool);
            let mut stdout = Vec::new();
            run_with_payload(
                Some(data_dir.clone()),
                claude_args("session-end", "https://default.example"),
                serde_json::json!({"session_id": "s", "cwd": cwd}).to_string(),
                &mut stdout,
                |_, token| {
                    assert!(
                        resolution == "marker",
                        "a refused route must not spawn a drainer"
                    );
                    assert_eq!(
                        token,
                        Some("INSTALL-TOKEN"),
                        "the drain gets the install token for install-default retries, \
                         never the profile's"
                    );
                    Ok(())
                },
            )
            .await
            .unwrap();
            let spooled = hook_spool::spool_len(&spool) - before;
            assert_eq!(spooled, usize::from(resolution == "marker"), "{resolution}");
        }
    }

    /// An event whose payload has no cwd is routed by the hook process's own
    /// cwd, so a harness omitting the field cannot escape a routed tree.
    #[test]
    fn an_event_without_a_payload_cwd_routes_by_the_process_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let repo = repo_with_marker(tmp.path(), "repo", "server = \"team-b\"\n");
        register_profile(
            &data_dir,
            "team-b",
            "https://b.example",
            &[&repo],
            Some("tok-b"),
        );

        let routed = resolve_hook_route(&data_dir, None, || Some(repo.clone()));
        assert!(matches!(routed, HookRoute::Profile(ref p) if p.url == "https://b.example"));
        let refused = resolve_hook_route(&data_dir, None, || Some(repo.join("..")));
        assert!(matches!(refused, HookRoute::InstallDefault), "{refused:?}");
        let unknown = resolve_hook_route(&data_dir, None, || None);
        assert!(matches!(unknown, HookRoute::InstallDefault));
        let payload_wins =
            resolve_hook_route(&data_dir, Some(&tmp.path().to_string_lossy()), || {
                Some(repo.clone())
            });
        assert!(matches!(payload_wins, HookRoute::InstallDefault));
    }

    /// Kimi injects any UserPromptSubmit stdout into the turn verbatim, so a
    /// prompt dropped by allowlist mode must print nothing — not even `{}`.
    #[tokio::test]
    async fn an_allowlist_drop_prints_nothing_for_kimi_user_prompts() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let mut args = kimi_hook_args("user-prompt", &dead_server_url());
        args.capture_mode = Some(crate::cli::CaptureModeArg::Allowlist);
        let mut stdout = Vec::new();
        run_with_payload(
            Some(data_dir.clone()),
            args,
            serde_json::json!({"session_id": "k", "cwd": tmp.path(), "prompt": "hi"}).to_string(),
            &mut stdout,
            |_, _| panic!("a dropped prompt spawns nothing"),
        )
        .await
        .unwrap();
        assert!(stdout.is_empty(), "{:?}", String::from_utf8_lossy(&stdout));
        assert_eq!(hook_spool::spool_len(&hook_spool::spool_dir(&data_dir)), 0);
    }

    /// The same for a prompt dropped because its profile was refused.
    #[tokio::test]
    async fn a_refused_route_prints_nothing_for_kimi_user_prompts() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let repo = repo_with_marker(tmp.path(), "repo", "server = \"nobody\"\n");
        let mut stdout = Vec::new();
        run_with_payload(
            Some(data_dir.clone()),
            kimi_hook_args("user-prompt", &dead_server_url()),
            serde_json::json!({"session_id": "k", "cwd": repo, "prompt": "hi"}).to_string(),
            &mut stdout,
            |_, _| panic!("a refused route spawns nothing"),
        )
        .await
        .unwrap();
        assert!(stdout.is_empty(), "{:?}", String::from_utf8_lossy(&stdout));
        assert_eq!(hook_spool::spool_len(&hook_spool::spool_dir(&data_dir)), 0);
    }

    /// Session start fetches the handoff from the profile's server with the
    /// profile's token; the install-default server sees nothing at all.
    #[tokio::test]
    async fn session_start_handoff_comes_from_the_profile_server_only() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let (profile_base, mut profile_requests) = serve_requests("200 OK", "B-HANDOFF").await;
        let (default_base, mut default_requests) = serve_requests("200 OK", "A-HANDOFF").await;
        let repo = repo_with_marker(tmp.path(), "repo", "server = \"team-b\"\n");
        register_profile(&data_dir, "team-b", &profile_base, &[&repo], Some("tok-b"));
        crate::config::store_hook_auth_token(&data_dir, "INSTALL-TOKEN").unwrap();

        let mut stdout = Vec::new();
        run_with_payload(
            Some(data_dir.clone()),
            kiro_hook_args("session-start", &default_base),
            serde_json::json!({"session_id": "kiro-session", "cwd": repo}).to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"B-HANDOFF\n");
        let mut recorded = Vec::new();
        while let Some(request) = first_request(&mut profile_requests).await {
            recorded.push(request);
        }
        assert!(
            recorded.iter().any(|r| r.starts_with("GET /handoff?")
                && r.lines()
                    .any(|l| l.eq_ignore_ascii_case("authorization: Bearer tok-b"))),
            "{recorded:?}"
        );
        assert!(
            recorded.iter().all(|r| !r.contains("INSTALL-TOKEN")),
            "{recorded:?}"
        );
        assert_eq!(first_request(&mut default_requests).await, None);
    }

    /// Recording stub that accepts exactly one bearer. An authorised
    /// `/hook/batch` answers `{"accepted": n}`, an authorised per-event POST
    /// `202`, anything else `401`. Every request is recorded whole (head and
    /// body), so a test can see both who authenticated and what was delivered.
    async fn serve_token_gated(
        accepted_token: &'static str,
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                // Read until the head is complete and the body has arrived:
                // a batch body can land in a second segment.
                let mut raw = Vec::new();
                let mut chunk = [0_u8; 8192];
                loop {
                    let read = stream.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    raw.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&raw);
                    let Some((head, body)) = text.split_once("\r\n\r\n") else {
                        continue;
                    };
                    let expected = head
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if body.len() >= expected {
                        break;
                    }
                }
                let request = String::from_utf8_lossy(&raw).into_owned();
                let _ = tx.send(request.clone());
                let authorized = request.lines().any(|l| {
                    l.trim()
                        .eq_ignore_ascii_case(&format!("authorization: Bearer {accepted_token}"))
                });
                let is_batch = request
                    .lines()
                    .next()
                    .is_some_and(|l| l.contains("/hook/batch"));
                let (status, body) = if !authorized {
                    ("401 Unauthorized", "{\"error\":\"bad token\"}".to_string())
                } else if is_batch {
                    let payload = request.split("\r\n\r\n").nth(1).unwrap_or("");
                    let accepted = serde_json::from_str::<serde_json::Value>(payload)
                        .ok()
                        .and_then(|v| v.as_array().map(Vec::len))
                        .unwrap_or(0);
                    ("200 OK", format!("{{\"accepted\":{accepted}}}"))
                } else {
                    ("202 Accepted", "queued".to_string())
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (format!("http://{addr}"), rx)
    }

    /// Everything a stub recorded, once no more requests arrive.
    async fn recorded(requests: &mut tokio::sync::mpsc::UnboundedReceiver<String>) -> Vec<String> {
        let mut all = Vec::new();
        while let Ok(Some(request)) =
            tokio::time::timeout(Duration::from_millis(250), requests.recv()).await
        {
            all.push(request);
        }
        all
    }

    /// The issue's first acceptance criterion at the wire: two repositories
    /// on one install, one routed to a profile and one not, spool into the
    /// same queue and are drained by one pass, and each server receives
    /// exactly its own event with exactly its own bearer. Server A accepts
    /// only the install token and server B only the profile's, so a
    /// misdelivered event or a swapped credential would be refused and
    /// counted as undelivered.
    #[tokio::test]
    async fn a_mixed_spool_drains_each_event_only_to_its_own_server() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let work = tmp.path().join("work");
        let (base_a, mut requests_a) = serve_token_gated("INSTALL-TOKEN").await;
        let (base_b, mut requests_b) = serve_token_gated("tok-b").await;
        let repo_a = repo_with_marker(&work, "a", "workspace = \"a\"\n");
        let repo_b = repo_with_marker(&work, "b", "workspace = \"b\"\nserver = \"team-b\"\n");
        register_profile(&data_dir, "team-b", &base_b, &[&repo_b], Some("tok-b"));
        crate::config::store_hook_auth_token(&data_dir, "INSTALL-TOKEN").unwrap();

        for (repo, sentinel) in [(&repo_a, "SENTINEL-A"), (&repo_b, "SENTINEL-B")] {
            let mut stdout = Vec::new();
            run_with_payload(
                Some(data_dir.clone()),
                claude_args("user-prompt-submit", &base_a),
                serde_json::json!({"session_id": "s", "cwd": repo, "prompt": sentinel}).to_string(),
                &mut stdout,
                |_, _| panic!("a prompt only spools"),
            )
            .await
            .unwrap();
        }
        let spool = hook_spool::spool_dir(&data_dir);
        assert_eq!(hook_spool::spool_len(&spool), 2);

        let result = hook_spool::drain_with_live_token(
            &spool,
            &data_dir,
            Duration::from_secs(5),
            Duration::from_millis(500),
            Some("INSTALL-TOKEN"),
            hook_spool::MaxAttempts::new(crate::config::DEFAULT_HOOK_SPOOL_MAX_ATTEMPTS),
        )
        .await;
        assert_eq!(result.sent, 2, "{result:?}");
        assert_eq!(hook_spool::spool_len(&spool), 0, "nothing left queued");

        let got_a = recorded(&mut requests_a).await;
        let got_b = recorded(&mut requests_b).await;
        assert_eq!(got_a.len(), 1, "server A saw {got_a:?}");
        assert_eq!(got_b.len(), 1, "server B saw {got_b:?}");
        let (a, b) = (&got_a[0], &got_b[0]);
        assert!(a.contains("SENTINEL-A") && !a.contains("SENTINEL-B"), "{a}");
        assert!(b.contains("SENTINEL-B") && !b.contains("SENTINEL-A"), "{b}");
        assert!(
            a.lines()
                .any(|l| l.eq_ignore_ascii_case("authorization: Bearer INSTALL-TOKEN"))
                && !a.contains("tok-b"),
            "{a}"
        );
        assert!(
            b.lines()
                .any(|l| l.eq_ignore_ascii_case("authorization: Bearer tok-b"))
                && !b.contains("INSTALL-TOKEN"),
            "{b}"
        );
    }

    #[tokio::test]
    async fn kimi_user_prompt_prints_the_handoff_body_verbatim() {
        let tmp = tempfile::tempdir().unwrap();
        let (base, mut requests) = serve_requests("200 OK", "AMWS-HANDOFF-DELTA").await;
        let mut stdout = Vec::new();
        run_with_payload(
            Some(tmp.path().to_path_buf()),
            kimi_hook_args("user-prompt", &base),
            serde_json::json!({
                "sessionId": "session_abc",
                "cwd": tmp.path(),
                "prompt": "hello"
            })
            .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        // Kimi injects UserPromptSubmit stdout verbatim into the turn, so the
        // body must be the bare handoff — never a JSON envelope.
        assert_eq!(stdout, b"AMWS-HANDOFF-DELTA\n");
        let request = first_request(&mut requests).await.unwrap();
        assert!(request.starts_with("GET /handoff?"), "{request}");
        assert!(request.contains("agent=kimi-code"), "{request}");
        // The native session id rides along so the destructive fetch can link
        // the managed run to the kimi session.
        assert!(request.contains("session_id=session_abc"), "{request}");
    }

    #[tokio::test]
    async fn kimi_user_prompt_submit_stem_also_delivers_the_handoff() {
        // The default PosixNative/WindowsNative installs pass the script stem
        // (`--event user-prompt-submit`), not the legacy `user-prompt` token;
        // both must trigger delivery or the production path would print `{}`
        // and kimi would inject it as literal context.
        let tmp = tempfile::tempdir().unwrap();
        let (base, mut requests) = serve_requests("200 OK", "AMWS-HANDOFF-DELTA").await;
        let mut stdout = Vec::new();
        run_with_payload(
            Some(tmp.path().to_path_buf()),
            kimi_hook_args("user-prompt-submit", &base),
            serde_json::json!({"sessionId": "session_abc", "cwd": tmp.path(), "prompt": "hi"})
                .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(stdout, b"AMWS-HANDOFF-DELTA\n");
        let request = first_request(&mut requests).await.unwrap();
        assert!(request.starts_with("GET /handoff?"), "{request}");

        let tmp = tempfile::tempdir().unwrap();
        let (base, mut requests) = serve_requests("404 Not Found", "").await;
        let mut stdout = Vec::new();
        run_with_payload(
            Some(tmp.path().to_path_buf()),
            kimi_hook_args("user-prompt-submit", &base),
            serde_json::json!({"sessionId": "session_abc", "cwd": tmp.path(), "prompt": "hi"})
                .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        let request = first_request(&mut requests).await.unwrap();
        assert!(request.starts_with("GET /handoff?"), "{request}");
        assert_eq!(stdout, b"");
    }

    #[tokio::test]
    async fn kimi_user_prompt_prints_nothing_when_no_handoff_is_pending() {
        let tmp = tempfile::tempdir().unwrap();
        let (base, mut requests) = serve_requests("404 Not Found", "").await;
        let mut stdout = Vec::new();
        run_with_payload(
            Some(tmp.path().to_path_buf()),
            kimi_hook_args("user-prompt", &base),
            serde_json::json!({"sessionId": "session_abc", "cwd": tmp.path(), "prompt": "hi"})
                .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        // The hook still attempted the fetch (a miss is indistinguishable
        // from an empty handoff server-side)...
        let request = first_request(&mut requests).await.unwrap();
        assert!(request.starts_with("GET /handoff?"), "{request}");
        // ...but stdout stays empty: kimi injects nothing, and a `{}`
        // envelope would show up as literal user-visible text.
        assert_eq!(stdout, b"");
    }

    #[tokio::test]
    async fn kimi_session_start_never_fetches_the_handoff() {
        let tmp = tempfile::tempdir().unwrap();
        // A handoff IS pending; kimi's SessionStart stdout is discarded, so
        // the hook must not consume it here (it is delivered on user-prompt).
        let (base, mut requests) = serve_requests("200 OK", "AMWS-HANDOFF-DELTA").await;
        let mut stdout = Vec::new();
        run_with_payload(
            Some(tmp.path().to_path_buf()),
            kimi_hook_args("session-start", &base),
            serde_json::json!({"sessionId": "session_abc", "cwd": tmp.path()}).to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"{}\n");
        // The session-start backlog drain may POST the spooled event, but no
        // request may touch /handoff.
        while let Some(request) = first_request(&mut requests).await {
            assert!(!request.starts_with("GET /handoff"), "{request}");
        }
    }

    #[tokio::test]
    async fn claude_user_prompt_does_not_fetch_the_handoff() {
        let tmp = tempfile::tempdir().unwrap();
        let (base, mut requests) = serve_requests("200 OK", "AMWS-HANDOFF-DELTA").await;
        let mut args = kimi_hook_args("user-prompt", &base);
        args.agent = "claude-code".into();
        let mut stdout = Vec::new();
        run_with_payload(
            Some(tmp.path().to_path_buf()),
            args,
            serde_json::json!({"session_id": "claude-session", "cwd": tmp.path()}).to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        // Claude keeps receiving the handoff on session-start; user-prompt
        // output stays the plain empty object and no fetch happens.
        assert_eq!(stdout, b"{}\n");
        while let Some(request) = first_request(&mut requests).await {
            assert!(!request.starts_with("GET /handoff"), "{request}");
        }
    }

    fn write_briefing_marker(dir: &Path) {
        std::fs::write(
            dir.join(".ai-memory.toml"),
            "[briefing]\ninject_on_session_start = true\nmax_chars = 6000\n",
        )
        .unwrap();
    }

    #[tokio::test]
    async fn kimi_user_prompt_briefing_only_on_first_prompt_of_session() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let cwd = tmp.path().join("repo");
        std::fs::create_dir(&cwd).unwrap();
        write_briefing_marker(&cwd);
        let (base, mut requests) = serve_requests("200 OK", "AMWS-HANDOFF-DELTA").await;
        let payload = serde_json::json!({
            "sessionId": "session_abc",
            "cwd": cwd,
            "prompt": "hi"
        })
        .to_string();

        // First prompt of the session: the briefing params ride along so the
        // server appends the compiled project brief (kimi cannot receive it
        // on SessionStart — that hook's stdout is discarded).
        let mut stdout = Vec::new();
        run_with_payload(
            Some(data_dir.clone()),
            kimi_hook_args("user-prompt-submit", &base),
            payload.clone(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(stdout, b"AMWS-HANDOFF-DELTA\n");
        let first = first_request(&mut requests).await.unwrap();
        assert!(first.starts_with("GET /handoff?"), "{first}");
        assert!(first.contains("&briefing=true"), "{first}");
        assert!(first.contains("&briefing_budget=6000"), "{first}");
        // ...and the session is marked as briefed.
        assert!(data_dir.join("briefed").join("session_abc").is_file());

        // Second prompt: the handoff is still fetched and printed (cheap and
        // self-limiting), but the briefing params are gone so the server
        // does not recompose the brief on every prompt.
        let mut stdout = Vec::new();
        run_with_payload(
            Some(data_dir.clone()),
            kimi_hook_args("user-prompt-submit", &base),
            payload,
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(stdout, b"AMWS-HANDOFF-DELTA\n");
        let second = first_request(&mut requests).await.unwrap();
        assert!(second.starts_with("GET /handoff?"), "{second}");
        assert!(second.contains("agent=kimi-code"), "{second}");
        assert!(second.contains("session_id=session_abc"), "{second}");
        assert!(second.contains("&cwd="), "{second}");
        assert!(!second.contains("briefing"), "{second}");
    }

    #[tokio::test]
    async fn kimi_user_prompt_briefing_fallback_key_hashes_agent_and_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let cwd = tmp.path().join("repo");
        std::fs::create_dir(&cwd).unwrap();
        write_briefing_marker(&cwd);
        let (base, mut requests) = serve_requests("200 OK", "AMWS-HANDOFF-DELTA").await;
        // No session id in the payload: the briefed marker is keyed by a
        // stable hash of agent+cwd, so a session-less payload still briefs
        // only once.
        let payload = serde_json::json!({"cwd": cwd, "prompt": "hi"}).to_string();

        let mut stdout = Vec::new();
        run_with_payload(
            Some(data_dir.clone()),
            kimi_hook_args("user-prompt", &base),
            payload.clone(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(stdout, b"AMWS-HANDOFF-DELTA\n");
        let first = first_request(&mut requests).await.unwrap();
        assert!(first.contains("&briefing=true"), "{first}");
        let expected_key = format!(
            "{:x}",
            Sha256::digest(format!("kimi-code\n{}", cwd.to_str().unwrap()).as_bytes())
        );
        assert!(data_dir.join("briefed").join(expected_key).is_file());

        let mut stdout = Vec::new();
        run_with_payload(
            Some(data_dir.clone()),
            kimi_hook_args("user-prompt", &base),
            payload,
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(stdout, b"AMWS-HANDOFF-DELTA\n");
        let second = first_request(&mut requests).await.unwrap();
        assert!(second.starts_with("GET /handoff?"), "{second}");
        assert!(!second.contains("briefing"), "{second}");
    }

    #[tokio::test]
    async fn kimi_user_prompt_without_briefing_creates_no_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let cwd = tmp.path().join("repo");
        std::fs::create_dir(&cwd).unwrap();
        let (base, mut requests) = serve_requests("404 Not Found", "").await;

        let mut stdout = Vec::new();
        run_with_payload(
            Some(data_dir.clone()),
            kimi_hook_args("user-prompt-submit", &base),
            serde_json::json!({
                "session_id": "session_abc",
                "cwd": cwd,
                "prompt": "hi"
            })
            .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        let request = first_request(&mut requests).await.unwrap();
        assert!(request.starts_with("GET /handoff?"), "{request}");
        assert!(!request.contains("briefing"), "{request}");
        // Only the profile digest's own gate is written; no brief marker.
        let markers: Vec<String> = std::fs::read_dir(data_dir.join("briefed"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(markers, vec!["profile-session_abc".to_owned()]);
    }

    /// Kimi re-fetches on every prompt, so the profile digest rides the first
    /// prompt only: later prompts of the session send `profile_digest=0`.
    #[tokio::test]
    async fn kimi_delivers_the_profile_digest_on_the_first_prompt_only() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let cwd = tmp.path().join("repo");
        std::fs::create_dir(&cwd).unwrap();
        let (base, mut requests) = serve_requests("404 Not Found", "").await;
        let prompt = || {
            serde_json::json!({ "session_id": "session_k", "cwd": cwd, "prompt": "hi" }).to_string()
        };
        for _ in 0..2 {
            let mut stdout = Vec::new();
            run_with_payload(
                Some(data_dir.clone()),
                kimi_hook_args("user-prompt-submit", &base),
                prompt(),
                &mut stdout,
                |_, _| Ok(()),
            )
            .await
            .unwrap();
        }
        let first = first_request(&mut requests).await.unwrap();
        let second = first_request(&mut requests).await.unwrap();
        assert!(!first.contains("profile_digest"), "{first}");
        assert!(second.contains("&profile_digest=0"), "{second}");
    }

    #[tokio::test]
    async fn grok_session_start_never_fetches_the_handoff() {
        let tmp = tempfile::tempdir().unwrap();
        let (base, mut requests) = serve_requests("200 OK", "AMWS-HANDOFF-DELTA").await;
        let mut stdout = Vec::new();
        run_with_payload(
            Some(tmp.path().to_path_buf()),
            grok_hook_args("session-start", &base),
            serde_json::json!({"session_id": "grok-session", "cwd": tmp.path()}).to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"{}\n");
        while let Some(request) = first_request(&mut requests).await {
            assert!(!request.starts_with("GET /handoff"), "{request}");
        }
    }

    #[tokio::test]
    async fn grok_user_prompt_does_not_fetch_the_handoff() {
        let tmp = tempfile::tempdir().unwrap();
        let (base, mut requests) = serve_requests("200 OK", "AMWS-HANDOFF-DELTA").await;
        let mut stdout = Vec::new();
        run_with_payload(
            Some(tmp.path().to_path_buf()),
            grok_hook_args("user-prompt", &base),
            serde_json::json!({
                "session_id": "grok-session",
                "cwd": tmp.path(),
                "prompt": "hello"
            })
            .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        // Grok discards allowing UserPromptSubmit stdout. Fetching would
        // accept the handoff and then throw the body away.
        assert_eq!(stdout, b"{}\n");
        while let Some(request) = first_request(&mut requests).await {
            assert!(
                !request.starts_with("GET /handoff"),
                "grok user-prompt must not accept the handoff: {request}"
            );
        }
    }

    #[tokio::test]
    async fn grok_user_prompt_submit_stem_does_not_fetch_the_handoff() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let cwd = tmp.path().join("repo");
        std::fs::create_dir(&cwd).unwrap();
        write_briefing_marker(&cwd);
        let (base, mut requests) = serve_requests("200 OK", "AMWS-HANDOFF-DELTA").await;
        let mut stdout = Vec::new();
        run_with_payload(
            Some(data_dir),
            grok_hook_args("user-prompt-submit", &base),
            serde_json::json!({
                "session_id": "grok-session",
                "cwd": cwd,
                "prompt": "hi"
            })
            .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();

        assert_eq!(stdout, b"{}\n");
        while let Some(request) = first_request(&mut requests).await {
            assert!(
                !request.starts_with("GET /handoff"),
                "briefing opt-in must not make grok fetch /handoff: {request}"
            );
        }
    }

    #[tokio::test]
    async fn grok_post_tool_prints_additional_context_once() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let (base, mut requests) = serve_requests("200 OK", "AMWS-HANDOFF-DELTA").await;
        let payload = serde_json::json!({
            "session_id": "grok-session",
            "cwd": tmp.path(),
            "tool_name": "read_file"
        })
        .to_string();

        let mut stdout = Vec::new();
        run_with_payload(
            Some(data_dir.clone()),
            grok_hook_args("post-tool-use", &base),
            payload.clone(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        let envelope: serde_json::Value = serde_json::from_slice(stdout.trim_ascii()).unwrap();
        assert_eq!(
            envelope["hookSpecificOutput"]["hookEventName"],
            "PostToolUse"
        );
        assert_eq!(
            envelope["hookSpecificOutput"]["additionalContext"],
            "AMWS-HANDOFF-DELTA"
        );
        let first = first_request(&mut requests).await.unwrap();
        assert!(first.starts_with("GET /handoff?"), "{first}");
        assert!(first.contains("agent=grok"), "{first}");
        assert!(first.contains("session_id=grok-session"), "{first}");
        assert!(
            data_dir
                .join("handoff-shown")
                .join("grok-session")
                .is_file(),
            "shown marker missing"
        );

        let mut stdout = Vec::new();
        run_with_payload(
            Some(data_dir),
            grok_hook_args("post-tool-use", &base),
            payload,
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(stdout, b"{}\n");
        assert!(
            first_request(&mut requests).await.is_none(),
            "second post-tool must not fetch again"
        );
    }

    #[tokio::test]
    async fn grok_post_tool_includes_briefing_when_the_marker_opts_in() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("data");
        let cwd = tmp.path().join("repo");
        std::fs::create_dir(&cwd).unwrap();
        write_briefing_marker(&cwd);
        let (base, mut requests) = serve_requests("200 OK", "AMWS-HANDOFF-DELTA").await;
        let mut stdout = Vec::new();
        run_with_payload(
            Some(data_dir),
            grok_hook_args("post-tool-use", &base),
            serde_json::json!({
                "session_id": "grok-session",
                "cwd": cwd,
                "tool_name": "read_file"
            })
            .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        let request = first_request(&mut requests).await.unwrap();
        assert!(request.contains("&briefing=true"), "{request}");
        assert!(request.contains("&briefing_budget=6000"), "{request}");
        let envelope: serde_json::Value = serde_json::from_slice(stdout.trim_ascii()).unwrap();
        assert_eq!(
            envelope["hookSpecificOutput"]["additionalContext"],
            "AMWS-HANDOFF-DELTA"
        );
    }

    #[tokio::test]
    async fn grok_post_tool_skips_a_subagent_payload() {
        let tmp = tempfile::tempdir().unwrap();
        let (base, mut requests) = serve_requests("200 OK", "AMWS-HANDOFF-DELTA").await;
        let mut stdout = Vec::new();
        run_with_payload(
            Some(tmp.path().join("data")),
            grok_hook_args("post-tool-use", &base),
            serde_json::json!({
                "session_id": "child-session",
                "cwd": tmp.path(),
                "subagentType": "goal-plan-writer",
                "tool_name": "read_file"
            })
            .to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(stdout, b"{}\n");
        while let Some(request) = first_request(&mut requests).await {
            assert!(
                !request.starts_with("GET /handoff"),
                "a child session must not accept the parent handoff: {request}"
            );
        }
    }

    #[tokio::test]
    async fn grok_post_tool_without_handoff_prints_empty_object() {
        let tmp = tempfile::tempdir().unwrap();
        let (base, mut requests) = serve_requests("404 Not Found", "").await;
        let mut stdout = Vec::new();
        run_with_payload(
            Some(tmp.path().join("data")),
            grok_hook_args("post-tool-use", &base),
            serde_json::json!({"session_id": "grok-session", "cwd": tmp.path()}).to_string(),
            &mut stdout,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(stdout, b"{}\n");
        let request = first_request(&mut requests).await.unwrap();
        assert!(request.starts_with("GET /handoff?"), "{request}");
    }

    #[test]
    fn grok_additional_context_is_clipped_to_the_model_cap() {
        let long = "x".repeat(GROK_ADDITIONAL_CONTEXT_CHARS + 50);
        let envelope = grok_post_tool_handoff_envelope(&long);
        let note = envelope["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert!(note.ends_with("\n[truncated]"));
        assert!(note.chars().count() <= GROK_ADDITIONAL_CONTEXT_CHARS);
    }

    #[test]
    fn briefed_markers_are_bounded_and_keep_current() {
        let tmp = tempfile::tempdir().unwrap();
        let marker_dir = tmp.path().join("briefed");
        let count = MAX_BRIEFED_MARKERS + 20;
        for index in 0..count {
            mark_briefed(&marker_dir.join(format!("session-{index:04}")));
        }

        let retained = std::fs::read_dir(&marker_dir).unwrap().count();
        assert_eq!(retained, MAX_BRIEFED_MARKERS);
        assert!(
            marker_dir
                .join(format!("session-{:04}", count - 1))
                .is_file()
        );
    }
}
