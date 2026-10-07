# Integrated project memory

AgentRouter embeds the ai-memory 2.5.2 runtime and presents its knowledge,
search, sessions, handoffs, client integration, and maintenance tools through
native React pages. It does not embed the upstream web UI. Upstream source,
license, and provenance are in `vendor/ai-memory` and `vendor/ai-memory.UPSTREAM.md`.

## Storage and lifecycle

The default directory is `<AgentRouter config directory>/ai-memory`, or
`~/.agentrouter/ai-memory` on macOS/Linux. Wiki, SQLite, raw events, configuration,
backups, and integration receipts remain independent of worktrees and profiles.
The runtime is bundled with the application; there is no in-product download or
separate engine installation step.

Memory is opt-in. The first start copies the verified bundled runtime into an
immutable runtime directory, initializes the data directory, and listens only on
`127.0.0.1:49374`. Requests require a random local credential, kept outside the
renderer. An existing listener is a conflict, not permission to adopt or stop
another process. Application shutdown stops only its own child. Closing a window
without exiting the application does not stop it. Auto-start is optional.

Semantic search is initially disabled to avoid an implicit model download or
external embedding calls. Enabling it uses the configured embedding provider:
local by default (with a model download), or the explicitly configured cloud
provider, which receives memory content. The confirmation explains this boundary.
Cloud model providers can be configured in the advanced TOML editor; saving also
warns about external calls, and changes take effect on restart. Inherited model keys, profile homes,
and arbitrary `AI_MEMORY_*` variables are not passed to the service. Automatic
historical-session backfill is disabled. The upstream capability remains
available through its bundled CLI.

## Native interface

- Project memory: project selection, search, directory and reading pane, editing
  and pinning. Sessions and handoffs live within the selected project. The session
  list includes open sessions and can finalize a specifically selected session.
- Clients: preview, install, inspect, and remove client-wide MCP/Hook wiring.
  This is deliberately separate from AgentRouter configuration profiles.
- Settings / Advanced maintenance: the complete live upstream MCP tool catalog, schema-driven native
  forms, and a structured-argument mode. Non-read-only calls require confirmation.
- Settings: lifecycle, semantic search, backup, full upstream TOML, and bounded
  logs. Saving configuration preserves a private backup.

The native client table covers twenty-one client/engine variants, including Claude
Code, Codex, OpenCode 1/2, Cursor, Gemini, Grok, Pi, OMP, Command Code,
Antigravity, Zero, ZCode, Devin, Kimi, Kiro 2/3, Zed, Muse, and macOS Claude
Desktop, plus Xiaomi MiMo MCP and capture plugin. Capability differences are retained. Project-specific adapters such as
VS Code Copilot, Swival, and Kiro v2 custom-agent hooks require an explicit target
and remain available in the bundled CLI rather than silently guessing a project.
A configured entry is not reported as a verified live capture.

## Capture and safety

Installed integrations use allowlist capture. Put `.ai-memory.toml` in an opted-in
project with explicit `workspace` and `project` names. Nothing writes markers or
turns on capture for all repositories automatically. Native hooks buffer events;
session boundaries and bounded mid-session drains deliver them to the server.

ZCode has no session-end hook: its `Stop` event ends a turn, not the session.
Finish the selected session from Project memory → Sessions when the work is
complete. This preserves multi-turn capture; the next session receives the
finished session's handoff. A session left open is not evidence of failed capture.

Client installs reuse upstream merge logic. AgentRouter records the previous
bytes and the exact installed postimage under owner-only permissions. Removal
restores the prior file only if the current postimage is still identical. If
another application/user modified it, removal refuses rather than overwriting
those changes. Integrations that share a config file may need removal in reverse
installation order. Removing a client never purges stored memory.

All stored prose is untrusted history. The renderer never executes stored HTML,
and backend reads use a closed route allowlist. Ordinary memory data is not
automatically a correct description of the current branch.

## Build and validation

`npm run build:assets` bundles a checksum-pinned official runtime for the host.
For a different package target, set `AR_BUILD_PLATFORM` and `AR_BUILD_ARCH` to
match electron-builder. Packaging checks architecture and manifest consistency.
`npm run build:memory -- --source` builds the vendored source with upstream's
required Rust toolchain (1.95 or newer); it is not a TypeScript port.

Memory tests live in `packages/core/test/{unit,integration}/memory` and
`packages/ui/test/component/memory.test.tsx`. Real-engine tests use a temporary
home/data directory and ephemeral port, never the operator's hooks or database.
Prepare the runtime with `npm run build:memory` before running those tests.

Database migrations belong to upstream. Before replacing an existing data format,
take a complete backup; swapping an older executable is not a database rollback.

## Project onboarding and model organization

Clients now includes project onboarding. Enter an existing absolute directory,
explicit workspace/project names, and the instruction family. Preview prepares
upstream `install-instructions --compact` plus its managed Agent Skills in a
private staging directory. Apply checks every previewed preimage, preserves
existing instruction content, writes a recovery snapshot under `backups/`, and
records installed file status. Unmanaged skill collisions and symlink targets
are rejected. A new `.ai-memory.toml` enables allowlist capture and a bounded
startup briefing. Existing markers must match the chosen scope; capture rules
and existing briefing settings are preserved. Install each required instruction
family when several clients use the same project. This does not change global
agent instructions or silently connect clients.

Connect client MCP and hooks separately in the same page, reload the client,
and start work in the opted-in directory. Configured files do not prove a live
client has loaded them: check session observations and the subsequent memory
page. The real-runtime integration test drives installed Codex hooks and checks
capture, synthesized pages, and next-session handoff injection. It does not
claim to run every supported client application.

ZCode's upstream adapter has no SessionEnd event. After the client has finished,
use the selected session's Finish session action. This calls upstream
`finalize-session` with explicit scope, agent and session UUID; it never closes
all sessions or guesses the latest one. Stop is only a turn boundary. Grok/Zero
retrieve handoffs via MCP because they do not inject SessionStart output.

Settings now offers explicit OpenAI-compatible model configuration (local server
or cloud/gateway), a structured connection test, background review, end-of-session
consolidation and approval controls. Secrets stay in owner-only
`agentrouter-model.json`, are omitted from read responses and redacted from logs.
A saved key does not follow a changed API destination. These explicit settings
are passed through ai-memory's supported environment overrides; corresponding
advanced TOML fields are overridden once this panel is saved. Without a saved
model override, advanced TOML retains authority. Stop memory before changing
model settings and restart to apply; no inherited global API keys are used.

Rule-based cleanup/lint follows upstream maintenance configuration. LLM review
requires a configured provider; its schedule and evidence thresholds retain the
upstream settings. The native model form defaults new configurations to manual
approval, explicitly unlike upstream's auto-approval default. Pending proposal
operations remain in Advanced maintenance. Neither this integration nor its tests
silently enable a paid provider. Full cloud/client acceptance remains separate
from the loopback mock-model and native-hook integration checks.

### Grok Build and Xiaomi MiMo acceptance

Grok Build 1.0.44 was tested with isolated home/project directories and the local
HTTP proxy: one session wrote a durable page through MCP and a separate session
read it back. Native hooks captured nine observations per session and both
sessions ended. Grok native memory was disabled for the test.

Xiaomi MiMo desktop 26.923.232338 supports remote MCP in the top-level `mcp`
object. AgentRouter resolves `MIMOCODE_HOME/config`, `XDG_CONFIG_HOME/mimocode`,
or `~/.config/mimocode`, in that order, and honors `mimocode.jsonc`,
`mimocode.json`, then `config.json` precedence. JSONC comments and other servers
are preserved. MiMo adds `$schema` when loading configuration; ownership tracks
the managed MCP entry so uninstall preserves that addition and user settings.
The installed application's extracted backend connected to the real local
ai-memory runtime successfully in an isolated test. A subsequent real two-session
test used MiMo's `engine-entry.mjs` and DeepSeek through AgentRouter: the first
prompt chose CEDAR-8264 without using MCP or writing files; after closure, the
second session recovered the value solely from injected handoff context. This
covers the installed backend, not desktop UI clicks or application-exit capture.
Both session deletion and AgentRouter's explicit scoped finalization were tested
as separate closure paths; explicit finalization preserves the MiMo conversation.
MiMo session capture now uses a generated native plugin in
`plugins/agentrouter-ai-memory.js`. It routes lifecycle events through the bundled
native hook CLI for allowlist policy, privacy filtering and durable spooling.
It captures prompts and tool metadata (not raw tool arguments/results), drains on
idle, closes on session deletion, and injects scoped handoffs through MiMo's
system-context callback. Idle does not close a session. New conversations automatically read sanitized
user prompts from completed turns in the same scoped project and directory,
including sessions that remain open. Records after the last Stop/SessionEnd are
excluded; the receiving session is excluded by its stable namespaced UUID.
Recall is bounded to three recent sessions, fifty observations each, and a
12,000-character context budget. This is recent conversation recall, not an
LLM-generated summary. No manual finalization or conversation deletion is needed.
Explicit finalization remains optional for full archive/maintenance workflows;
application exit is still not treated as a verified SessionEnd callback.

The pinned upstream runtime has no MiMo agent enum. Captures use `other`, with
a stable UUID v5 derived from the `agentrouter:xiaomi-mimo:` namespace and
`client: xiaomi-mimo` in native payloads. They are never
attributed to OpenCode. The current session list therefore reports `other`.
Handoff scope accepts the same simple, explicit workspace/project marker syntax
as AgentRouter setup; ambiguous markers skip injection rather than choosing a
fallback project. Capture policy is checked before any handoff is consumed.

The completed-turn recall test used the installed MiMo backend and real gateway
model calls: session A recorded BIRCH-9057, session B recalled it without deleting
or finalizing A, and A accepted another message afterwards. Both persisted
sessions remained open. The native-runtime regression also checks that prompts
after the last completion boundary are excluded from recall.

## Runtime upgrade to 2.5.2

The bundled source and all five platform archive checksums are pinned to v2.5.2
(commit `7580b74d0fb9d14a6d949dc92f5ea8bb7feb3c83`). Integration tests run the
actual macOS binary with isolated data and client homes, including Codex hook
capture, ZCode lifecycle behavior, MiMo idle capture/recall, and client installers.
This does not certify a new live conversation in every desktop client. Back up
the complete memory data directory before starting the upgraded runtime against
existing data; upgrading the bundle alone does not restart the running service.
