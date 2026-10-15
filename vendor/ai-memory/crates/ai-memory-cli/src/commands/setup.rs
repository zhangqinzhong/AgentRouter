//! `ai-memory setup` — a native install in one command.
//!
//! A composition of the commands a native install otherwise runs by hand, in
//! order, through their own library functions:
//!
//! 1. `init`, which on a fresh data dir also mints the root bearer token into
//!    `<data_dir>/auth-tokens/default` and records `[auth] bearer_token_file`;
//! 2. a per-user service running `serve` on that install
//!    ([`super::user_service`]): a systemd `--user` unit or a launchd
//!    LaunchAgent, rendered from the packaged templates. Windows has none;
//! 3. for each agent (named with `--agent`, else detected from its session
//!    store or MCP config under the home, the way `doctor` finds them):
//!    `install-mcp --apply`, `install-hooks --apply` and global
//!    `install-skills`;
//! 4. a self-check that writes nothing: `/healthz`, a `memory_status` call
//!    over MCP with the install's credential, and `doctor`.
//!
//! The token is never printed or passed on a command line. The installers keep
//! it out of every harness config (hooks read the credential files `init`
//! seeds; MCP clients go through `mcp-bridge` or an env-var reference), as
//! they do when run by hand.
//!
//! Every step is idempotent, so a second `setup` changes nothing. Without
//! `--yes` the plan is shown first and confirmed on a terminal; with no
//! terminal to ask on, `setup` changes nothing and exits non-zero.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::io::{BufRead as _, IsTerminal as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use ai_memory_workstream::{ManagedHarness, OpenCodeDialect, native_store_root};
use anyhow::{Context as _, Result, bail};

use super::user_service::{self, CommandRunner, ServiceChange, ServiceManager, ServiceUnit};
use super::{
    agent_plugins, doctor, init, install_hooks, install_mcp, install_skills, run_autowire,
};
use crate::cli::{
    AgentChoice, DoctorArgs, HookInstallScope, InitArgs, InstallHooksArgs, InstallMcpArgs,
    InstallSkillsAgent, InstallSkillsArgs, InstallSkillsScope, McpClient, SetupArgs,
};
use crate::config::Config;
use crate::http_client::{ServerEndpoint, ServerProbe, probe_server};

/// How long `setup` waits for a service it just started to answer.
const SERVICE_READY_TIMEOUT: Duration = Duration::from_secs(30);

/// The MCP entry name every installer writes by default.
const ENTRY_NAME: &str = "ai-memory";

/// Harnesses that share a native store with another one, so finding the store
/// cannot tell them apart: OpenCode 2 shares OpenCode's, and the Kiro CLI v3
/// engine's store contains the v2 engine's. Wiring both would write two
/// dialects into one config, so only the stable one is detected; the other is
/// wired when named with `--agent`.
const EXPLICIT_ONLY: &[ManagedHarness] = &[ManagedHarness::OpenCode2, ManagedHarness::KiroV3];

/// What `setup` will do.
#[derive(Debug)]
struct SetupPlan {
    data_dir: PathBuf,
    config_path: PathBuf,
    /// No config file yet: `init` writes one (and mints the token when the
    /// data dir has no database either).
    fresh: bool,
    service: ServicePlan,
    agents: Vec<AgentPlan>,
    /// Agents came from detection, not `--agent`.
    detected: bool,
}

#[derive(Debug)]
enum ServicePlan {
    Install(ServiceUnit),
    Skip(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AgentPlan {
    agent: AgentChoice,
    mcp: Option<McpClient>,
    skills: InstallSkillsAgent,
    /// The ai-memory marketplace plugin is enabled for this agent: it carries
    /// the hooks, MCP entry and skills, so setup writes none of them (#1166).
    plugin: bool,
}

impl AgentPlan {
    fn new(agent: AgentChoice) -> Self {
        Self {
            agent,
            mcp: install_hooks::mcp_client_for_agent(agent),
            skills: skills_for(agent),
            plugin: false,
        }
    }

    /// [`Self::new`], with the plugin state of `agent` under `home`.
    fn detect(agent: AgentChoice, home: &Path, env: &dyn Fn(&str) -> Option<OsString>) -> Self {
        let harness = match agent {
            AgentChoice::ClaudeCode => Some(agent_plugins::PluginHarness::ClaudeCode),
            AgentChoice::Codex => Some(agent_plugins::PluginHarness::Codex),
            _ => None,
        };
        Self {
            plugin: harness
                .is_some_and(|harness| agent_plugins::enabled(harness, home, env).is_some()),
            ..Self::new(agent)
        }
    }
}

/// The skill directory family an agent reads; agents without one of their
/// own read the cross-client `~/.agents/skills`.
fn skills_for(agent: AgentChoice) -> InstallSkillsAgent {
    match agent {
        AgentChoice::ClaudeCode => InstallSkillsAgent::ClaudeCode,
        AgentChoice::Grok => InstallSkillsAgent::Grok,
        AgentChoice::CopilotCli => InstallSkillsAgent::CopilotCli,
        AgentChoice::Devin => InstallSkillsAgent::Devin,
        AgentChoice::Hermes => InstallSkillsAgent::Hermes,
        _ => InstallSkillsAgent::Agents,
    }
}

/// The OpenCode major version an agent names outright, so neither installer
/// probes `opencode --version` and picks one dialect for both.
fn opencode_dialect(agent: AgentChoice) -> Option<OpenCodeDialect> {
    match agent {
        AgentChoice::OpenCode => Some(OpenCodeDialect::V1),
        AgentChoice::OpenCode2 => Some(OpenCodeDialect::V2),
        _ => None,
    }
}

/// Run `setup`.
///
/// # Errors
/// When the plan cannot be built, the operator declines it (or there is no
/// terminal to ask on and no `--yes`), or any step fails; the other steps
/// still run and the error counts the failures.
pub async fn run(config: &Config, args: SetupArgs, config_path: Option<&Path>) -> Result<()> {
    let captured = config.runtime_env.process_env().to_vec();
    let env = move |name: &str| -> Option<OsString> {
        captured
            .iter()
            .find(|(key, _)| key.as_os_str() == name)
            .map(|(_, value)| value.clone())
    };
    let home = super::run::native_home(config).context("locating your home directory")?;
    let exe = std::env::current_exe().context("locating the running ai-memory binary")?;
    let exe = service_exe(&exe, &env);

    let written_config = init_config_path(config, config_path);
    let agents = if args.agents.is_empty() {
        let mut found = detect_agents(
            &home,
            &|harness| doctor::relocated_session_dir_with(harness, &env),
            &|client| install_mcp::mcp_config_path_with(client, &env).ok(),
        );
        if muse_detected(&home, &env) {
            found.push(AgentChoice::Muse);
        }
        found
    } else {
        dedup(args.agents.iter().copied())
    };
    let service = if args.no_service {
        ServicePlan::Skip("skipped (--no-service)".to_owned())
    } else {
        let spec = user_service::ServiceSpec {
            exe,
            data_dir: config.data_dir.clone(),
            config_path: written_config.clone(),
            home: home.clone(),
            xdg_config_home: env("XDG_CONFIG_HOME").map(PathBuf::from),
        };
        let reachable = matches!(
            probe_server(&ServerEndpoint::from_config_resolving_auth(config).await).await,
            ServerProbe::Reachable
        );
        plan_service(
            ServiceManager::current(),
            &spec,
            &config.server_url,
            reachable,
        )
    };
    let plan = SetupPlan {
        data_dir: config.data_dir.clone(),
        fresh: !written_config.exists(),
        config_path: written_config,
        service,
        agents: agents
            .into_iter()
            .map(|agent| AgentPlan::detect(agent, &home, &env))
            .collect(),
        detected: args.agents.is_empty(),
    };

    print_plan(&plan);
    if !args.yes {
        confirm()?;
    }
    execute(
        config,
        config_path,
        plan,
        &user_service::SystemRunner,
        SERVICE_READY_TIMEOUT,
    )
    .await
}

fn init_config_path(config: &Config, explicit: Option<&Path>) -> PathBuf {
    explicit.map_or_else(|| config.data_dir.join("config.toml"), Path::to_path_buf)
}

fn dedup(agents: impl Iterator<Item = AgentChoice>) -> Vec<AgentChoice> {
    let mut seen = Vec::new();
    for agent in agents {
        if !seen.contains(&agent) {
            seen.push(agent);
        }
    }
    seen
}

/// The agents to wire when none was named: every harness `doctor` scans whose
/// session store exists, or whose MCP config file does, under `home`.
fn detect_agents(
    home: &Path,
    session_dir_for: &dyn Fn(ManagedHarness) -> Option<PathBuf>,
    mcp_config_for: &dyn Fn(McpClient) -> Option<PathBuf>,
) -> Vec<AgentChoice> {
    let found = doctor::SCANNED_HARNESSES
        .iter()
        .copied()
        .filter(|harness| !EXPLICIT_ONLY.contains(harness))
        .filter_map(|harness| {
            let agent = run_autowire::agent_choice_for_harness(harness)?;
            let store = native_store_root(harness, home, session_dir_for(harness).as_deref());
            let config = install_hooks::mcp_client_for_agent(agent)
                .and_then(mcp_config_for)
                .is_some_and(|path| path.is_file());
            (store.is_dir() || config).then_some(agent)
        });
    dedup(found)
}

/// Whether Meta Muse Code has run for this user: its config directory
/// (`${XDG_CONFIG_HOME:-~/.config}/muse`) or its data directory
/// (`${XDG_DATA_HOME:-~/.local/share}/muse`, where its sessions live) exists.
/// Muse has no native-session adapter, so it is found by these directories
/// rather than by [`detect_agents`]. Each XDG variable counts only when it is
/// an absolute path, lexically.
fn muse_detected(home: &Path, env: &dyn Fn(&str) -> Option<OsString>) -> bool {
    let xdg = |name: &str, fallback: &[&str]| {
        super::path_util::agent_config_home(env(name))
            .filter(|dir| dir.is_absolute())
            .unwrap_or_else(|| {
                fallback
                    .iter()
                    .fold(home.to_path_buf(), |dir, part| dir.join(part))
            })
            .join("muse")
    };
    xdg("XDG_CONFIG_HOME", &[".config"]).is_dir()
        || xdg("XDG_DATA_HOME", &[".local", "share"]).is_dir()
}

/// The binary path the service unit runs. A package manager's versioned
/// location (a Homebrew `Cellar/<formula>/<version>` or a `/nix/store` path)
/// disappears on the next upgrade or `brew cleanup` / garbage collection, so a
/// unit naming it stops starting. When the running binary lives in one, the
/// unit names a stable link that resolves to the same file instead: the path
/// as invoked, an `ai-memory` on `PATH` (`/usr/local/bin`, `~/.nix-profile/bin`,
/// `/etc/profiles/per-user/<user>/bin`), or Homebrew's `opt/<formula>` and
/// `bin` links. Without one, the resolved path is kept as before.
fn service_exe(invoked: &Path, env: &dyn Fn(&str) -> Option<OsString>) -> PathBuf {
    let Ok(resolved) = std::fs::canonicalize(invoked) else {
        return invoked.to_path_buf();
    };
    if !is_versioned_package_path(&resolved) {
        return resolved;
    }
    let name = resolved.file_name().unwrap_or(invoked.as_os_str());
    let on_path = env("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join(name))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    std::iter::once(invoked.to_path_buf())
        .chain(homebrew_links(&resolved))
        .chain(on_path)
        .find(|candidate| {
            candidate.is_absolute()
                && !is_versioned_package_path(candidate)
                && std::fs::canonicalize(candidate).is_ok_and(|target| target == resolved)
        })
        .unwrap_or(resolved)
}

/// Whether `path` sits in a store a package manager replaces per version.
fn is_versioned_package_path(path: &Path) -> bool {
    let parts: Vec<_> = path.components().map(|part| part.as_os_str()).collect();
    parts.windows(2).any(|pair| pair == ["nix", "store"]) || cellar_index(&parts).is_some()
}

/// The index of a `Cellar` component followed by `<formula>/<version>/...`.
fn cellar_index(parts: &[&std::ffi::OsStr]) -> Option<usize> {
    parts
        .iter()
        .position(|part| *part == "Cellar")
        .filter(|index| parts.len() > index + 3)
}

/// Homebrew's version-independent links to a `<prefix>/Cellar/<formula>/
/// <version>/<rest>` file: `<prefix>/opt/<formula>/<rest>` (what Homebrew's
/// own services use) and `<prefix>/<rest>`.
fn homebrew_links(resolved: &Path) -> Vec<PathBuf> {
    let parts: Vec<_> = resolved.components().map(|part| part.as_os_str()).collect();
    let Some(index) = cellar_index(&parts) else {
        return Vec::new();
    };
    let prefix: PathBuf = parts[..index].iter().collect();
    let rest: PathBuf = parts[index + 3..].iter().collect();
    vec![
        prefix.join("opt").join(parts[index + 1]).join(&rest),
        prefix.join(rest),
    ]
}

/// Decide the service step. A server already answering with no unit of ours
/// in place is left in charge (Docker, a packaged unit, a foreground
/// `serve`): a second server could not bind the port anyway.
fn plan_service(
    manager: Option<ServiceManager>,
    spec: &user_service::ServiceSpec,
    server_url: &str,
    reachable: bool,
) -> ServicePlan {
    let Some(manager) = manager else {
        return ServicePlan::Skip(
            "not supported on this platform (Windows has no service step); start the server \
             with `ai-memory serve --transport http` and see docs/windows.md"
                .to_owned(),
        );
    };
    if !super::hook_spool::is_loopback_url(server_url) {
        return ServicePlan::Skip(format!(
            "the configured server {server_url} is not on this machine; no local service"
        ));
    }
    match user_service::render(manager, spec) {
        Ok(unit) if reachable && !unit.path.exists() => ServicePlan::Skip(format!(
            "a server already answers at {server_url}; leaving it in charge (pass --no-service \
             to skip this check)"
        )),
        Ok(unit) => ServicePlan::Install(unit),
        Err(error) => ServicePlan::Skip(format!("cannot render the service: {error:#}")),
    }
}

fn print_plan(plan: &SetupPlan) {
    println!("ai-memory setup will:");
    if plan.fresh {
        println!(
            "  - create the data dir {} and write {} (with a new root bearer token in \
             auth-tokens/default when the data dir is new)",
            plan.data_dir.display(),
            plan.config_path.display()
        );
    } else {
        println!(
            "  - keep the existing install at {} ({})",
            plan.data_dir.display(),
            plan.config_path.display()
        );
    }
    match &plan.service {
        ServicePlan::Install(unit) => println!(
            "  - install and start a {} at {}",
            unit.manager.describe(),
            unit.path.display()
        ),
        ServicePlan::Skip(reason) => println!("  - service: {reason}"),
    }
    if plan.agents.is_empty() {
        println!(
            "  - wire no agent: none {}; name one with --agent <name>",
            if plan.detected {
                "was detected"
            } else {
                "was named"
            }
        );
    }
    for agent in &plan.agents {
        let name = agent.agent.kind().as_str();
        if agent.plugin {
            println!(
                "  - leave {name} to its enabled ai-memory plugin ({}), which carries the \
                 hooks, MCP entry and skills",
                agent_plugins::PLUGIN_ID
            );
            continue;
        }
        let mcp = if agent.mcp.is_some() {
            "MCP + hooks"
        } else {
            "hooks"
        };
        println!(
            "  - wire {name}{}: {mcp} + skills",
            if plan.detected { " (detected)" } else { "" }
        );
    }
    println!("  - check /healthz, memory_status and doctor (read-only)");
}

/// Ask on a terminal; refuse without one.
fn confirm() -> Result<()> {
    if !std::io::stdin().is_terminal() {
        bail!(
            "nothing was changed: there is no terminal to confirm this plan on. Re-run \
             `ai-memory setup --yes` to apply it."
        );
    }
    print!("Proceed? [y/N] ");
    std::io::stdout().flush().ok();
    let mut answer = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut answer)
        .context("reading the answer")?;
    if matches!(answer.trim(), "y" | "Y" | "yes" | "YES" | "Yes") {
        Ok(())
    } else {
        bail!("nothing was changed")
    }
}

/// Apply the plan. Every step runs even when an earlier one failed, so the
/// report names every problem at once.
async fn execute(
    config: &Config,
    config_path: Option<&Path>,
    plan: SetupPlan,
    runner: &dyn CommandRunner,
    ready_timeout: Duration,
) -> Result<()> {
    let mut problems: Vec<String> = Vec::new();

    println!("\n== init");
    let outcome = init::initialize(config, &InitArgs { force: false }, config_path)?;
    let mut config = config.clone();
    if let Some(token) = outcome.root_token
        && config.auth.bearer_token.is_none()
    {
        config.auth.adopt_token_file(token.path, token.token);
    }
    println!(
        "config: {} {}",
        if outcome.config_written {
            "wrote"
        } else {
            "kept"
        },
        outcome.config_path.display()
    );

    println!("\n== service");
    let mut wait_for_server = false;
    match &plan.service {
        ServicePlan::Skip(reason) => println!("service: {reason}"),
        ServicePlan::Install(unit) => match user_service::install(unit, runner) {
            Ok(change) => {
                wait_for_server = change != ServiceChange::Unchanged;
                println!(
                    "service: {} {}",
                    match change {
                        ServiceChange::Installed => "installed and started",
                        ServiceChange::Updated => "updated and restarted",
                        ServiceChange::Started => "started",
                        ServiceChange::Unchanged => "already running from",
                    },
                    unit.path.display()
                );
            }
            Err(error) => problems.push(format!(
                "service: {error:#}. Start the server yourself with `ai-memory serve --transport \
                 http`, or re-run with --no-service when it runs some other way."
            )),
        },
    }
    let endpoint = ServerEndpoint::from_config_resolving_auth(&config).await;
    if wait_for_server && !wait_until_reachable(&endpoint, ready_timeout).await {
        problems.push(format!(
            "service: the server did not answer at {} within {}s",
            endpoint.url,
            ready_timeout.as_secs()
        ));
    }

    let mut skills_done = BTreeSet::new();
    for agent in &plan.agents {
        println!("\n== {}", agent.agent.kind().as_str());
        for problem in wire_agent(&config, *agent, &mut skills_done) {
            problems.push(format!("{}: {problem}", agent.agent.kind().as_str()));
        }
    }

    println!("\n== self-check");
    for problem in self_check(&config, &endpoint).await {
        problems.push(format!("self-check: {problem}"));
    }

    println!();
    if config.auth.bearer_token.is_none() {
        println!("auth: none (loopback); run `ai-memory auth enable` to require a bearer token");
    } else {
        println!("auth: bearer token (owner-only file; never printed)");
    }
    if let Some(hint) = web_sign_in_hint(&config, &endpoint) {
        println!("{hint}");
    }
    if problems.is_empty() {
        println!(
            "ai-memory is set up. Restart your agents so they load the new hooks and MCP entry."
        );
        return Ok(());
    }
    for problem in &problems {
        eprintln!("problem: {problem}");
    }
    bail!(
        "setup finished with {} problem(s); fix them and re-run `ai-memory setup`",
        problems.len()
    )
}

/// How a browser signs in to the web UI on a token-file install. With no
/// human accounts the server answers `/web` with a Basic challenge, and the
/// token file's contents are the password. The token itself is never printed.
fn web_sign_in_hint(config: &Config, endpoint: &ServerEndpoint) -> Option<String> {
    let file = config.auth.token_file.as_ref().filter(|file| file.loaded)?;
    Some(format!(
        "web UI: {} (the service runs with --enable-web); when the browser asks \
         for a username and password, use any username and the contents of {} \
         as the password",
        endpoint.build_url("/web"),
        file.path.display()
    ))
}

async fn wait_until_reachable(endpoint: &ServerEndpoint, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if matches!(probe_server(endpoint).await, ServerProbe::Reachable) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// `install-mcp`, `install-hooks` and `install-skills` for one agent, MCP
/// first so an OpenCode major-version move has one entry before the hook
/// installer reads it (the order `ai-memory run` auto-wire uses). Returns the
/// failures.
fn wire_agent(config: &Config, plan: AgentPlan, skills_done: &mut BTreeSet<String>) -> Vec<String> {
    let mut problems = Vec::new();
    if plan.plugin {
        // Writing the settings-file wiring as well would load every skill
        // twice and register a second MCP server; the hook copies would be
        // de-duplicated, but nothing would be gained.
        println!(
            "plugin: {} is enabled; leaving the settings-file hooks, MCP entry and skills \
             alone (run `ai-memory install-hooks --agent {} --apply` to add them anyway)",
            agent_plugins::PLUGIN_ID,
            plan.agent.kind().as_str()
        );
        return problems;
    }
    let dialect = opencode_dialect(plan.agent);
    if let Some(client) = plan.mcp {
        if install_mcp::existing_entry_is_session_aware(client, None, ENTRY_NAME) {
            println!("mcp: keeping the existing session-aware entry");
        } else {
            let args = InstallMcpArgs {
                client,
                server_url: None,
                name: ENTRY_NAME.to_owned(),
                auth_token: None,
                apply: true,
                config_file: None,
                session_aware: false,
                flavor: None,
                token_env_var: false,
                stdio_bridge: false,
                bridge_data_dir: None,
            };
            if let Err(error) = install_mcp::run_with_opencode_dialect(config, args, dialect) {
                problems.push(format!("install-mcp: {error:#}"));
            }
        }
    }
    let hooks = InstallHooksArgs {
        agent: plan.agent,
        hooks_dir: None,
        server_url: None,
        auth_token: None,
        as_user: None,
        apply: true,
        config_file: None,
        scope: HookInstallScope::Global,
        project_strategy: None,
        capture_assistant: false,
        capture_mode: None,
        no_capture_prompts: false,
        capture_prompts: false,
        profile: None,
    };
    if let Err(error) =
        install_hooks::run_with_opencode_dialect_and_mcp_path(config, hooks, dialect, None)
    {
        problems.push(format!("install-hooks: {error:#}"));
    }
    let skills_key = format!("{:?}", plan.skills);
    if skills_done.insert(skills_key) {
        let args = InstallSkillsArgs {
            scope: InstallSkillsScope::Global,
            agent: plan.skills,
            target_dir: None,
            print: false,
            force: false,
        };
        if let Err(error) = install_skills::run(config, args) {
            problems.push(format!("install-skills: {error:#}"));
        }
    }
    problems
}

/// `/healthz`, `memory_status` over MCP, and `doctor`; none of them writes a
/// file. Returns the failures.
async fn self_check(config: &Config, endpoint: &ServerEndpoint) -> Vec<String> {
    let mut problems = Vec::new();
    let healthz = endpoint.build_url("/healthz");
    match reqwest::Client::new()
        .get(&healthz)
        .timeout(Duration::from_secs(5))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => println!("healthz: ok ({healthz})"),
        Ok(response) => problems.push(format!("{healthz} answered {}", response.status())),
        Err(error) => {
            problems.push(format!("{healthz} did not answer: {error}"));
            // Nothing else can pass without a server.
            return problems;
        }
    }
    match memory_status(config).await {
        Ok(()) => println!("memory_status: ok"),
        Err(error) => problems.push(format!("memory_status: {error:#}")),
    }
    let doctor = DoctorArgs {
        workspace: None,
        project: None,
        since_days: 30,
        json: false,
    };
    if let Err(error) = doctor::run(config, doctor).await {
        problems.push(format!("doctor: {error:#}"));
    }
    problems
}

/// One `memory_status` call over the server's MCP endpoint, authenticated the
/// way `mcp-bridge` authenticates, so a refused credential shows here rather
/// than in the agent's first session.
async fn memory_status(config: &Config) -> Result<()> {
    use rmcp::ServiceExt as _;
    use rmcp::model::CallToolRequestParams;
    use rmcp::transport::StreamableHttpClientTransport;

    let url = install_mcp::mcp_server_url_from_base(&config.server_url);
    let transport = StreamableHttpClientTransport::from_config(super::mcp_bridge::upstream_config(
        &url,
        None,
        config.auth.bearer_token.as_deref(),
    )?);
    let client = ().serve(transport).await.with_context(|| format!("connecting to {url}"))?;
    let result = client
        .peer()
        .call_tool(CallToolRequestParams::new("memory_status"))
        .await;
    client.cancel().await.ok();
    let result = result.context("calling memory_status")?;
    if result.is_error == Some(true) {
        bail!("memory_status reported an error");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Muse is detected by its config or data directory under the home or
    /// the absolute XDG roots, and not otherwise.
    #[test]
    fn muse_is_detected_by_its_config_or_data_directory() {
        let none = |_: &str| -> Option<OsString> { None };
        let home = tempfile::tempdir().unwrap();
        assert!(!muse_detected(home.path(), &none));
        std::fs::create_dir_all(home.path().join(".local/share/muse/sessions")).unwrap();
        assert!(muse_detected(home.path(), &none));

        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".config/muse")).unwrap();
        assert!(muse_detected(home.path(), &none));

        let home = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(xdg.path().join("muse")).unwrap();
        let xdg_path = xdg.path().as_os_str().to_owned();
        let env = move |name: &str| (name == "XDG_CONFIG_HOME").then(|| xdg_path.clone());
        assert!(muse_detected(home.path(), &env));
        assert_eq!(skills_for(AgentChoice::Muse), InstallSkillsAgent::Agents);
        assert_eq!(AgentPlan::new(AgentChoice::Muse).mcp, Some(McpClient::Muse));
    }

    /// A versioned Homebrew binary is recorded through the `opt/<formula>`
    /// link that survives `brew upgrade` and `brew cleanup`, falling back to
    /// the `<prefix>/bin` link; a link to some other binary never wins.
    #[cfg(unix)]
    #[test]
    fn a_cellar_binary_is_recorded_through_its_stable_homebrew_link() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let prefix = std::fs::canonicalize(root.path()).unwrap();
        let cellar_bin = prefix.join("Cellar/ai-memory/3.0.0/bin");
        std::fs::create_dir_all(&cellar_bin).unwrap();
        let real = cellar_bin.join("ai-memory");
        std::fs::write(&real, "bin").unwrap();
        let no_env = |_: &str| None;

        // No link at all: the resolved path is all there is.
        assert_eq!(service_exe(&real, &no_env), real);

        std::fs::create_dir_all(prefix.join("bin")).unwrap();
        symlink(&real, prefix.join("bin/ai-memory")).unwrap();
        assert_eq!(service_exe(&real, &no_env), prefix.join("bin/ai-memory"));

        std::fs::create_dir_all(prefix.join("opt")).unwrap();
        symlink("../Cellar/ai-memory/3.0.0", prefix.join("opt/ai-memory")).unwrap();
        assert_eq!(
            service_exe(&real, &no_env),
            prefix.join("opt/ai-memory/bin/ai-memory")
        );

        // Control: a stable link that points at another version is refused.
        let other = tempfile::tempdir().unwrap();
        let other = std::fs::canonicalize(other.path()).unwrap();
        let old_bin = other.join("Cellar/ai-memory/2.9.0/bin");
        std::fs::create_dir_all(&old_bin).unwrap();
        let old = old_bin.join("ai-memory");
        std::fs::write(&old, "old").unwrap();
        std::fs::create_dir_all(other.join("bin")).unwrap();
        symlink(&real, other.join("bin/ai-memory")).unwrap();
        assert_eq!(service_exe(&old, &no_env), old);
    }

    /// A `/nix/store` binary is recorded through the profile link on `PATH`
    /// that resolves to it, and the path as invoked wins when it is stable.
    #[cfg(unix)]
    #[test]
    fn a_nix_store_binary_is_recorded_through_its_profile_link() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(root.path()).unwrap();
        let store_bin = root.join("nix/store/abc123-ai-memory-3.0.0/bin");
        std::fs::create_dir_all(&store_bin).unwrap();
        let real = store_bin.join("ai-memory");
        std::fs::write(&real, "bin").unwrap();
        let profile_bin = root.join("home/.nix-profile/bin");
        std::fs::create_dir_all(&profile_bin).unwrap();
        symlink(&real, profile_bin.join("ai-memory")).unwrap();
        let elsewhere = root.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let path = std::env::join_paths([&elsewhere, &store_bin, &profile_bin]).unwrap();
        let env = move |name: &str| (name == "PATH").then(|| path.clone());

        assert_eq!(service_exe(&real, &env), profile_bin.join("ai-memory"));
        assert_eq!(service_exe(&real, &|_: &str| None), real);

        let invoked = root.join("invoked");
        symlink(&real, &invoked).unwrap();
        assert_eq!(service_exe(&invoked, &env), invoked);
    }

    /// A binary outside any versioned store keeps the resolved path, as
    /// before: a `~/.local/bin` install is already stable.
    #[cfg(unix)]
    #[test]
    fn a_plain_binary_keeps_its_resolved_path() {
        let root = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(root.path()).unwrap();
        let real = root.join(".local/bin/ai-memory");
        std::fs::create_dir_all(real.parent().unwrap()).unwrap();
        std::fs::write(&real, "bin").unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(service_exe(&link, &|_: &str| None), real);
        assert!(!is_versioned_package_path(Path::new(
            "/opt/homebrew/bin/ai-memory"
        )));
        assert!(!is_versioned_package_path(Path::new("/srv/Cellar/x")));
        assert!(is_versioned_package_path(Path::new(
            "/opt/homebrew/Cellar/ai-memory/3.0.0/bin/ai-memory"
        )));
        assert!(is_versioned_package_path(Path::new(
            "/nix/store/abc-ai-memory/bin/ai-memory"
        )));
    }

    /// An enabled plugin takes an agent's wiring over; a disabled or absent
    /// one, and an agent the plugins do not cover, keep the full plan.
    #[test]
    fn an_enabled_plugin_takes_over_the_agents_wiring() {
        use crate::commands::agent_plugins::test_support::{
            install_claude_plugin, install_codex_plugin,
        };
        let home = tempfile::tempdir().unwrap();
        let env = |_: &str| None;
        assert!(!AgentPlan::detect(AgentChoice::ClaudeCode, home.path(), &env).plugin);

        install_claude_plugin(home.path(), "3.0.0", false);
        assert!(!AgentPlan::detect(AgentChoice::ClaudeCode, home.path(), &env).plugin);
        install_claude_plugin(home.path(), "3.0.0", true);
        assert!(AgentPlan::detect(AgentChoice::ClaudeCode, home.path(), &env).plugin);
        assert!(!AgentPlan::detect(AgentChoice::Codex, home.path(), &env).plugin);
        assert!(!AgentPlan::detect(AgentChoice::Grok, home.path(), &env).plugin);

        install_codex_plugin(home.path());
        assert!(AgentPlan::detect(AgentChoice::Codex, home.path(), &env).plugin);
    }

    /// A token-file install learns how to open the web UI: the URL and the
    /// file to read, never the token. An inline or absent token prints no hint.
    #[test]
    fn web_hint_names_the_token_file_and_never_the_token() {
        let endpoint = ServerEndpoint::from_pair(Some("http://127.0.0.1:49374".to_owned()), None);
        let mut config = Config::default();
        assert_eq!(web_sign_in_hint(&config, &endpoint), None);

        config.auth.bearer_token = Some("inline-root-token".to_owned());
        assert_eq!(web_sign_in_hint(&config, &endpoint), None);

        let file = PathBuf::from("/data/auth-tokens/default");
        config
            .auth
            .adopt_token_file(file.clone(), "file-root-token".to_owned());
        let hint = web_sign_in_hint(&config, &endpoint).expect("token-file install gets a hint");
        assert!(hint.contains("http://127.0.0.1:49374/web"), "{hint}");
        assert!(hint.contains(&file.display().to_string()), "{hint}");
        assert!(!hint.contains("file-root-token"), "{hint}");
    }

    fn spec(home: &Path) -> user_service::ServiceSpec {
        user_service::ServiceSpec {
            exe: PathBuf::from("/opt/ai-memory/ai-memory"),
            data_dir: home.join("data"),
            config_path: home.join("data").join("config.toml"),
            home: home.to_path_buf(),
            xdg_config_home: None,
        }
    }

    #[test]
    fn detection_finds_harness_stores_and_mcp_configs_under_home() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        // Claude Code by its session store, Codex by its MCP config only.
        std::fs::create_dir_all(home.join(".claude").join("projects")).unwrap();
        let codex_config = home.join("codex-config.toml");
        std::fs::write(&codex_config, "").unwrap();
        let mcp = |client: McpClient| (client == McpClient::Codex).then(|| codex_config.clone());
        let found = detect_agents(home, &|_| None, &mcp);
        assert_eq!(found, vec![AgentChoice::ClaudeCode, AgentChoice::Codex]);
    }

    /// Control: an empty home detects nothing, and a named-but-missing MCP
    /// config path does not count as present.
    #[test]
    fn an_empty_home_detects_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope.json");
        let found = detect_agents(tmp.path(), &|_| None, &|_| Some(missing.clone()));
        assert!(found.is_empty(), "{found:?}");
    }

    /// OpenCode 2 shares OpenCode's store; detection must not wire both
    /// dialects into the one config file.
    #[test]
    fn a_shared_store_detects_only_the_stable_harness() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        std::fs::create_dir_all(home.join(".local/share/opencode")).unwrap();
        std::fs::create_dir_all(home.join(".kiro/sessions/cli")).unwrap();
        let found = detect_agents(home, &|_| None, &|_| None);
        assert_eq!(found, vec![AgentChoice::OpenCode, AgentChoice::KiroCli]);
    }

    /// A relocated store (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, …) is looked for
    /// where the relocation points, not under the home.
    #[test]
    fn detection_follows_a_relocated_store() {
        let tmp = tempfile::tempdir().unwrap();
        let elsewhere = tmp.path().join("relocated-claude");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let relocate = |harness: ManagedHarness| {
            (harness == ManagedHarness::Claude).then(|| elsewhere.clone())
        };
        let found = detect_agents(&tmp.path().join("home"), &relocate, &|_| None);
        assert_eq!(found, vec![AgentChoice::ClaudeCode]);
    }

    #[test]
    fn skills_go_to_each_agents_own_directory_or_the_shared_one() {
        assert_eq!(
            skills_for(AgentChoice::ClaudeCode),
            InstallSkillsAgent::ClaudeCode
        );
        assert_eq!(skills_for(AgentChoice::Grok), InstallSkillsAgent::Grok);
        assert_eq!(
            skills_for(AgentChoice::CopilotCli),
            InstallSkillsAgent::CopilotCli
        );
        assert_eq!(skills_for(AgentChoice::Codex), InstallSkillsAgent::Agents);
        assert_eq!(
            skills_for(AgentChoice::KimiCode),
            InstallSkillsAgent::Agents
        );
    }

    #[test]
    fn named_agents_are_deduplicated_in_order() {
        assert_eq!(
            dedup(
                [
                    AgentChoice::Codex,
                    AgentChoice::ClaudeCode,
                    AgentChoice::Codex
                ]
                .into_iter()
            ),
            vec![AgentChoice::Codex, AgentChoice::ClaudeCode]
        );
    }

    #[test]
    fn windows_has_no_service_step_and_says_so() {
        let tmp = tempfile::tempdir().unwrap();
        let ServicePlan::Skip(reason) =
            plan_service(None, &spec(tmp.path()), "http://127.0.0.1:49374", false)
        else {
            panic!("expected a skip");
        };
        assert!(reason.contains("Windows"), "{reason}");
    }

    #[test]
    fn a_remote_server_gets_no_local_service() {
        let tmp = tempfile::tempdir().unwrap();
        let plan = plan_service(
            Some(ServiceManager::SystemdUser),
            &spec(tmp.path()),
            "https://memory.example.com",
            true,
        );
        assert!(
            matches!(plan, ServicePlan::Skip(reason) if reason.contains("not on this machine"))
        );
    }

    /// A server that already answers with no unit of ours in place is not
    /// ours to replace; once our unit exists, a running server is the one it
    /// started and the unit is managed as usual.
    // Windows skips the service step before this decision.
    #[cfg(unix)]
    #[test]
    fn an_answering_server_without_our_unit_is_left_in_charge() {
        let tmp = tempfile::tempdir().unwrap();
        let spec = spec(tmp.path());
        let url = "http://127.0.0.1:49374";
        let plan = plan_service(Some(ServiceManager::SystemdUser), &spec, url, true);
        assert!(matches!(plan, ServicePlan::Skip(reason) if reason.contains("already answers")));

        let ServicePlan::Install(unit) =
            plan_service(Some(ServiceManager::SystemdUser), &spec, url, false)
        else {
            panic!("expected an install when nothing answers");
        };
        std::fs::create_dir_all(unit.path.parent().unwrap()).unwrap();
        std::fs::write(&unit.path, &unit.contents).unwrap();
        assert!(matches!(
            plan_service(Some(ServiceManager::SystemdUser), &spec, url, true),
            ServicePlan::Install(_)
        ));
    }
}
