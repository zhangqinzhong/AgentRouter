//! The per-user service `ai-memory setup` installs: a systemd `--user` unit on
//! Linux, a launchd LaunchAgent on macOS.
//!
//! Both are rendered from the packaged templates
//! (`packaging/systemd/ai-memory-user.service` and
//! `packaging/launchd/com.github.akitaonrails.ai-memory.plist`), with the
//! running binary, the data dir and the config file `setup` used substituted
//! in. Spelling the data dir and config out matters: a server started against
//! another config would not require the token `init` recorded there, while the
//! hooks and MCP entries `setup` writes would present it.
//!
//! The service manager is driven through [`CommandRunner`], so tests render
//! into a temp dir and record the `systemctl` / `launchctl` calls instead of
//! touching a real user session. Windows has no service step.

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail};

/// The systemd user unit template the AUR and RPM packages ship.
const SYSTEMD_USER_TEMPLATE: &str =
    include_str!("../../../../packaging/systemd/ai-memory-user.service");
/// The macOS LaunchAgent template `docs/macos.md` and the menu bar app use.
const LAUNCHD_TEMPLATE: &str =
    include_str!("../../../../packaging/launchd/com.github.akitaonrails.ai-memory.plist");

/// The unit name, the same one the packages install, so a user unit written
/// here takes precedence over a packaged `/usr/lib/systemd/user` copy instead
/// of starting a second server on the same port.
pub(crate) const SYSTEMD_UNIT_NAME: &str = "ai-memory.service";
/// The LaunchAgent label, shared with the macOS menu bar app.
pub(crate) const LAUNCHD_LABEL: &str = "com.github.akitaonrails.ai-memory";

/// Template text each renderer replaces; a template edited so one of them no
/// longer matches fails the render rather than shipping a unit that silently
/// keeps the packaged defaults.
const SYSTEMD_BIN: &str = "/usr/bin/ai-memory";
const SYSTEMD_DATA_DIR: &str = "%h/.local/share/ai-memory";
const SYSTEMD_CONFIG: &str = "%h/.config/ai-memory/config.toml";
const LAUNCHD_BIN: &str = "<string>__AI_MEMORY_BIN__</string>";
const LAUNCHD_HOME: &str = "<string>__HOME__/";

/// Start of the identity line `setup` writes into every unit it renders. The
/// rest of the line is the SHA-256 of the file without that line, so
/// `uninstall` can tell a unit `setup` wrote, and nobody edited since, from a
/// hand-written or hand-edited one, which it leaves alone.
const IDENTITY_PREFIX: &str = "ai-memory-setup-unit sha256:";

/// Which service manager this platform uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ServiceManager {
    SystemdUser,
    Launchd,
}

impl ServiceManager {
    /// The manager for the platform this binary was built for; `None` on
    /// Windows and anything else without a supported per-user manager.
    pub(crate) const fn current() -> Option<Self> {
        if cfg!(target_os = "linux") {
            Some(Self::SystemdUser)
        } else if cfg!(target_os = "macos") {
            Some(Self::Launchd)
        } else {
            None
        }
    }

    pub(crate) const fn describe(self) -> &'static str {
        match self {
            Self::SystemdUser => "systemd user unit",
            Self::Launchd => "launchd LaunchAgent",
        }
    }
}

/// What the rendered service runs.
#[derive(Debug, Clone)]
pub(crate) struct ServiceSpec {
    /// Absolute path of the `ai-memory` binary to run.
    pub(crate) exe: PathBuf,
    pub(crate) data_dir: PathBuf,
    pub(crate) config_path: PathBuf,
    /// The operator's home, where the unit or LaunchAgent is installed.
    pub(crate) home: PathBuf,
    /// `$XDG_CONFIG_HOME`, when set (systemd only).
    pub(crate) xdg_config_home: Option<PathBuf>,
}

/// A rendered service file and where it goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ServiceUnit {
    pub(crate) manager: ServiceManager,
    pub(crate) path: PathBuf,
    pub(crate) contents: String,
}

impl ServiceUnit {
    /// Whether the file on disk already holds exactly this unit.
    pub(crate) fn is_current(&self) -> bool {
        std::fs::read_to_string(&self.path).is_ok_and(|text| text == self.contents)
    }
}

/// Render the unit for `manager`.
///
/// # Errors
/// A path that is relative or holds a control character (which no unit
/// syntax can carry safely), or a template that no longer has the text the
/// renderer replaces.
pub(crate) fn render(manager: ServiceManager, spec: &ServiceSpec) -> Result<ServiceUnit> {
    for (what, path) in [
        ("binary", &spec.exe),
        ("data dir", &spec.data_dir),
        ("config file", &spec.config_path),
        ("home", &spec.home),
    ] {
        checked_path(what, path)?;
    }
    match manager {
        ServiceManager::SystemdUser => render_systemd(spec),
        ServiceManager::Launchd => render_launchd(spec),
    }
}

fn checked_path<'a>(what: &str, path: &'a Path) -> Result<&'a str> {
    let text = path
        .to_str()
        .with_context(|| format!("the {what} path {} is not UTF-8", path.display()))?;
    if !path.is_absolute() {
        bail!("the {what} path {text} is not absolute");
    }
    if text.chars().any(char::is_control) {
        bail!("the {what} path {text:?} contains a control character");
    }
    Ok(text)
}

/// One `ExecStart=` word: double-quoted, with `\` and `"` escaped for the
/// unit parser, `%` doubled so it is no specifier, and `$` doubled so it is
/// no variable expansion.
fn systemd_word(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '%' => out.push_str("%%"),
            '$' => out.push_str("$$"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

fn render_systemd(spec: &ServiceSpec) -> Result<ServiceUnit> {
    let exec = SYSTEMD_USER_TEMPLATE
        .lines()
        .find(|line| line.starts_with("ExecStart="))
        .context("the packaged systemd user unit has no ExecStart line")?;
    for needle in [SYSTEMD_BIN, SYSTEMD_DATA_DIR, SYSTEMD_CONFIG] {
        if !exec.contains(needle) {
            bail!("the packaged systemd user unit's ExecStart no longer contains {needle}");
        }
    }
    let rendered_exec = exec
        .replacen(
            SYSTEMD_BIN,
            &systemd_word(checked_path("binary", &spec.exe)?),
            1,
        )
        .replacen(
            SYSTEMD_DATA_DIR,
            &systemd_word(checked_path("data dir", &spec.data_dir)?),
            1,
        )
        .replacen(
            SYSTEMD_CONFIG,
            &systemd_word(checked_path("config file", &spec.config_path)?),
            1,
        );
    let body = SYSTEMD_USER_TEMPLATE.replacen(exec, &rendered_exec, 1);
    let unstamped = format!(
        "# Written by `ai-memory setup` from packaging/systemd/ai-memory-user.service.\n\
         # Re-run `ai-memory setup` instead of editing; `ai-memory uninstall` removes it.\n{body}"
    );
    Ok(ServiceUnit {
        manager: ServiceManager::SystemdUser,
        path: unit_path(
            ServiceManager::SystemdUser,
            &spec.home,
            spec.xdg_config_home.as_deref(),
        ),
        contents: stamp(ServiceManager::SystemdUser, &unstamped),
    })
}

/// Where `manager`'s unit for ai-memory lives: under `$XDG_CONFIG_HOME` (when
/// absolute) or `~/.config` for systemd, `~/Library/LaunchAgents` for launchd.
pub(crate) fn unit_path(
    manager: ServiceManager,
    home: &Path,
    xdg_config_home: Option<&Path>,
) -> PathBuf {
    match manager {
        ServiceManager::SystemdUser => xdg_config_home
            .filter(|dir| dir.is_absolute())
            .map_or_else(|| home.join(".config"), Path::to_path_buf)
            .join("systemd")
            .join("user")
            .join(SYSTEMD_UNIT_NAME),
        ServiceManager::Launchd => home
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{LAUNCHD_LABEL}.plist")),
    }
}

fn identity_line(manager: ServiceManager, digest: &str) -> String {
    match manager {
        ServiceManager::SystemdUser => format!("# {IDENTITY_PREFIX}{digest}"),
        ServiceManager::Launchd => format!("<!-- {IDENTITY_PREFIX}{digest} -->"),
    }
}

fn sha256_hex(text: &str) -> String {
    use sha2::{Digest as _, Sha256};
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// Insert the identity line: first in a systemd unit, right after the XML
/// declaration in a plist (which must stay first).
fn stamp(manager: ServiceManager, unstamped: &str) -> String {
    let line = identity_line(manager, &sha256_hex(unstamped));
    match manager {
        ServiceManager::SystemdUser => format!("{line}\n{unstamped}"),
        ServiceManager::Launchd => match unstamped.split_once('\n') {
            Some((declaration, rest)) => format!("{declaration}\n{line}\n{rest}"),
            None => format!("{line}\n{unstamped}"),
        },
    }
}

/// Whether `text` is a unit `setup` rendered and nobody changed since: exactly
/// one identity line, whose digest matches the rest of the file.
pub(crate) fn is_rendered_by_setup(text: &str) -> bool {
    let mut identities = text
        .split_inclusive('\n')
        .enumerate()
        .filter(|(_, line)| line.contains(IDENTITY_PREFIX));
    let (Some((index, line)), None) = (identities.next(), identities.next()) else {
        return false;
    };
    let Some(digest) = line
        .split_once(IDENTITY_PREFIX)
        .map(|(_, rest)| rest.trim_end_matches(['\n', '\r', ' ', '>', '-']))
    else {
        return false;
    };
    let rest: String = text
        .split_inclusive('\n')
        .enumerate()
        .filter(|(i, _)| *i != index)
        .map(|(_, line)| line)
        .collect();
    digest.len() == 64 && sha256_hex(&rest) == digest
}

fn xml_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn render_launchd(spec: &ServiceSpec) -> Result<ServiceUnit> {
    if !LAUNCHD_TEMPLATE.contains(LAUNCHD_BIN) || !LAUNCHD_TEMPLATE.contains(LAUNCHD_HOME) {
        bail!("the packaged LaunchAgent no longer has the placeholders `setup` fills in");
    }
    let string = |text: &str| format!("<string>{}</string>", xml_text(text));
    // The template leaves the data dir and config to the macOS defaults; pass
    // them so the agent serves the install `setup` initialised, whatever
    // `--data-dir` / `AI_MEMORY_DATA_DIR` / `--config` chose.
    let program = [
        string(checked_path("binary", &spec.exe)?),
        string("--data-dir"),
        string(checked_path("data dir", &spec.data_dir)?),
        string("--config"),
        string(checked_path("config file", &spec.config_path)?),
    ]
    .join("\n    ");
    let home = format!("<string>{}/", xml_text(checked_path("home", &spec.home)?));
    let contents = LAUNCHD_TEMPLATE
        .replacen(LAUNCHD_BIN, &program, 1)
        .replace(LAUNCHD_HOME, &home);
    if contents.contains("<string>__") {
        bail!("the packaged LaunchAgent has a placeholder `setup` does not fill in");
    }
    Ok(ServiceUnit {
        manager: ServiceManager::Launchd,
        path: unit_path(ServiceManager::Launchd, &spec.home, None),
        contents: stamp(ServiceManager::Launchd, &contents),
    })
}

/// The directory launchd writes the agent's logs to; launchd creates the
/// files but not the directory.
pub(crate) fn launchd_log_dir(home: &Path) -> PathBuf {
    home.join("Library").join("Logs").join("ai-memory")
}

/// The result of one service-manager command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommandOutcome {
    pub(crate) success: bool,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

/// Runs `systemctl` / `launchctl` / `id`. Injectable so tests never reach a
/// real service manager.
pub(crate) trait CommandRunner {
    /// Run `program` with `args`; an `Err` means it could not be started.
    fn run(&self, program: &str, args: &[&str]) -> Result<CommandOutcome>;
}

/// Runs commands for real, resolved through `PATH`.
pub(crate) struct SystemRunner;

impl CommandRunner for SystemRunner {
    fn run(&self, program: &str, args: &[&str]) -> Result<CommandOutcome> {
        let output = std::process::Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .output()
            .with_context(|| format!("running {program}"))?;
        Ok(CommandOutcome {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

/// What installing the service did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ServiceChange {
    /// The unit was written for the first time and the service started.
    Installed,
    /// The unit changed and the service was restarted on it.
    Updated,
    /// The unit was current but the service was not running; it was started.
    Started,
    /// The unit was current and the service already running: nothing done.
    Unchanged,
}

/// Write `unit` when it differs from the file on disk, then make sure the
/// service is enabled and running on it. A current unit whose service already
/// runs is left alone, so a second `setup` changes nothing.
///
/// # Errors
/// A failed write, or a service-manager command that could not be run or
/// failed; the error carries its output.
pub(crate) fn install(unit: &ServiceUnit, runner: &dyn CommandRunner) -> Result<ServiceChange> {
    let existed = unit.path.exists();
    let current = unit.is_current();
    let running = match unit.manager {
        ServiceManager::SystemdUser => systemd_running(runner),
        ServiceManager::Launchd => launchd_loaded(runner, &launchd_domain(runner)?),
    };
    if current && running {
        return Ok(ServiceChange::Unchanged);
    }
    if !current {
        write_unit(unit)?;
    }
    match unit.manager {
        ServiceManager::SystemdUser => start_systemd(runner)?,
        ServiceManager::Launchd => start_launchd(unit, runner, running)?,
    }
    Ok(match (existed, current) {
        (false, _) => ServiceChange::Installed,
        (true, false) => ServiceChange::Updated,
        (true, true) => ServiceChange::Started,
    })
}

fn write_unit(unit: &ServiceUnit) -> Result<()> {
    if let Some(parent) = unit.path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    ai_memory_wiki::write_atomic(&unit.path, unit.contents.as_bytes())
        .with_context(|| format!("writing {}", unit.path.display()))?;
    // No secret lives in a unit; keep the conventional mode, since launchd
    // refuses a LaunchAgent other users can write and systemd only reads it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&unit.path, std::fs::Permissions::from_mode(0o644))
            .with_context(|| format!("setting the mode of {}", unit.path.display()))?;
    }
    Ok(())
}

fn require(runner: &dyn CommandRunner, program: &str, args: &[&str]) -> Result<CommandOutcome> {
    let outcome = runner.run(program, args)?;
    if !outcome.success {
        bail!(
            "`{program} {}` failed: {}",
            args.join(" "),
            outcome.stderr.trim()
        );
    }
    Ok(outcome)
}

fn succeeds(runner: &dyn CommandRunner, program: &str, args: &[&str]) -> bool {
    runner
        .run(program, args)
        .is_ok_and(|outcome| outcome.success)
}

fn systemd_running(runner: &dyn CommandRunner) -> bool {
    succeeds(
        runner,
        "systemctl",
        &["--user", "is-active", "--quiet", SYSTEMD_UNIT_NAME],
    ) && succeeds(
        runner,
        "systemctl",
        &["--user", "is-enabled", "--quiet", SYSTEMD_UNIT_NAME],
    )
}

fn start_systemd(runner: &dyn CommandRunner) -> Result<()> {
    require(runner, "systemctl", &["--user", "daemon-reload"])?;
    require(
        runner,
        "systemctl",
        &["--user", "enable", SYSTEMD_UNIT_NAME],
    )?;
    require(
        runner,
        "systemctl",
        &["--user", "restart", SYSTEMD_UNIT_NAME],
    )?;
    Ok(())
}

fn launchd_domain(runner: &dyn CommandRunner) -> Result<String> {
    let uid = require(runner, "id", &["-u"])?.stdout.trim().to_owned();
    if uid.is_empty() || !uid.chars().all(|c| c.is_ascii_digit()) {
        bail!("`id -u` printed {uid:?}, not a user id");
    }
    Ok(format!("gui/{uid}"))
}

fn launchd_loaded(runner: &dyn CommandRunner, domain: &str) -> bool {
    succeeds(
        runner,
        "launchctl",
        &["print", &format!("{domain}/{LAUNCHD_LABEL}")],
    )
}

fn start_launchd(unit: &ServiceUnit, runner: &dyn CommandRunner, loaded: bool) -> Result<()> {
    let domain = launchd_domain(runner)?;
    if let Some(home) = unit
        .path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
    {
        let logs = launchd_log_dir(home);
        std::fs::create_dir_all(&logs).with_context(|| format!("creating {}", logs.display()))?;
    }
    if loaded {
        require(
            runner,
            "launchctl",
            &["bootout", &format!("{domain}/{LAUNCHD_LABEL}")],
        )?;
    }
    let plist = unit.path.to_string_lossy();
    require(runner, "launchctl", &["bootstrap", &domain, &plist])?;
    Ok(())
}

/// What `uninstall` did about the user service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Removal {
    /// There is no unit at the path `setup` writes.
    Absent,
    /// `setup`'s unit was stopped, disabled and deleted.
    Removed(PathBuf),
    /// A unit is there but `setup` did not write it, or it was edited since;
    /// it was left alone.
    NotOurs(PathBuf),
}

/// Whether the unit at `path` is one `uninstall` would remove; reads only.
pub(crate) fn planned_removal(path: &Path) -> Removal {
    match std::fs::read_to_string(path) {
        Err(_) if !path.exists() => Removal::Absent,
        Ok(text) if is_rendered_by_setup(&text) => Removal::Removed(path.to_path_buf()),
        _ => Removal::NotOurs(path.to_path_buf()),
    }
}

/// Stop, disable and delete the unit at `path` when `setup` wrote it and it
/// is unedited; leave anything else alone. A second call finds nothing.
///
/// # Errors
/// A service-manager command that fails (the file is then kept, so a still
/// running service never loses its unit) or a failed delete.
pub(crate) fn remove(
    manager: ServiceManager,
    path: &Path,
    runner: &dyn CommandRunner,
) -> Result<Removal> {
    let planned = planned_removal(path);
    if !matches!(planned, Removal::Removed(_)) {
        return Ok(planned);
    }
    match manager {
        ServiceManager::SystemdUser => {
            require(
                runner,
                "systemctl",
                &["--user", "disable", "--now", SYSTEMD_UNIT_NAME],
            )?;
            delete_unit(path)?;
            require(runner, "systemctl", &["--user", "daemon-reload"])?;
        }
        ServiceManager::Launchd => {
            let domain = launchd_domain(runner)?;
            if launchd_loaded(runner, &domain) {
                require(
                    runner,
                    "launchctl",
                    &["bootout", &format!("{domain}/{LAUNCHD_LABEL}")],
                )?;
            }
            delete_unit(path)?;
        }
    }
    Ok(planned)
}

fn delete_unit(path: &Path) -> Result<()> {
    std::fs::remove_file(path).with_context(|| format!("removing {}", path.display()))
}

// The service step is Unix-only (systemd user units, launchd), and these
// tests render and drive it with Unix paths.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Records every call and answers from a script: the first matching
    /// `(program, first args)` prefix wins, anything else succeeds.
    #[derive(Default)]
    struct FakeRunner {
        calls: RefCell<Vec<String>>,
        failing: Vec<&'static str>,
        stdout: Vec<(&'static str, &'static str)>,
    }

    impl CommandRunner for FakeRunner {
        fn run(&self, program: &str, args: &[&str]) -> Result<CommandOutcome> {
            let line = format!("{program} {}", args.join(" "));
            self.calls.borrow_mut().push(line.clone());
            let success = !self.failing.iter().any(|prefix| line.starts_with(prefix));
            let stdout = self
                .stdout
                .iter()
                .find(|(prefix, _)| line.starts_with(prefix))
                .map_or_else(String::new, |(_, out)| (*out).to_owned());
            Ok(CommandOutcome {
                success,
                stdout,
                stderr: if success {
                    String::new()
                } else {
                    "boom".into()
                },
            })
        }
    }

    fn spec(root: &Path) -> ServiceSpec {
        ServiceSpec {
            exe: root.join("bin").join("ai-memory"),
            data_dir: root.join("data"),
            config_path: root.join("data").join("config.toml"),
            home: root.join("home"),
            xdg_config_home: None,
        }
    }

    fn exec_line(unit: &ServiceUnit) -> String {
        unit.contents
            .lines()
            .find(|line| line.starts_with("ExecStart="))
            .unwrap()
            .to_owned()
    }

    #[test]
    fn the_systemd_unit_runs_this_binary_on_this_install() {
        let root = Path::new("/srv/u");
        let unit = render(ServiceManager::SystemdUser, &spec(root)).unwrap();
        assert_eq!(
            unit.path,
            Path::new("/srv/u/home/.config/systemd/user/ai-memory.service")
        );
        assert_eq!(
            exec_line(&unit),
            "ExecStart=\"/srv/u/bin/ai-memory\" --data-dir \"/srv/u/data\" --config \
             \"/srv/u/data/config.toml\" serve --transport http --enable-web"
        );
        // Everything else is the packaged unit, untouched.
        for line in SYSTEMD_USER_TEMPLATE
            .lines()
            .filter(|line| !line.starts_with("ExecStart="))
        {
            assert!(unit.contents.contains(line), "lost template line {line}");
        }
    }

    #[test]
    fn the_systemd_unit_honours_an_absolute_xdg_config_home_only() {
        let mut spec = spec(Path::new("/srv/u"));
        spec.xdg_config_home = Some(PathBuf::from("/srv/xdg"));
        let unit = render(ServiceManager::SystemdUser, &spec).unwrap();
        assert_eq!(
            unit.path,
            Path::new("/srv/xdg/systemd/user/ai-memory.service")
        );
        spec.xdg_config_home = Some(PathBuf::from("relative/xdg"));
        let unit = render(ServiceManager::SystemdUser, &spec).unwrap();
        assert!(unit.path.starts_with("/srv/u/home/.config"));
    }

    /// A path with a space, a quote, a specifier and a variable must reach the
    /// server as one literal argument, never as a split word, a `%h`
    /// expansion or an environment lookup.
    #[test]
    fn hostile_paths_are_quoted_as_single_literal_words() {
        let mut spec = spec(Path::new("/srv/u"));
        spec.data_dir = PathBuf::from("/srv/my data/%h/$HOME/\"q\"/back\\slash");
        let unit = render(ServiceManager::SystemdUser, &spec).unwrap();
        assert!(
            exec_line(&unit).contains(
                "--data-dir \"/srv/my data/%%h/$$HOME/\\\"q\\\"/back\\\\slash\" --config"
            ),
            "{}",
            exec_line(&unit)
        );
    }

    #[test]
    fn control_characters_and_relative_paths_are_refused() {
        let mut bad = spec(Path::new("/srv/u"));
        bad.data_dir = PathBuf::from("/srv/u/data\nExecStartPre=/bin/sh -c evil");
        for manager in [ServiceManager::SystemdUser, ServiceManager::Launchd] {
            let err = render(manager, &bad).unwrap_err();
            assert!(format!("{err:#}").contains("control character"), "{err:#}");
        }
        let mut relative = spec(Path::new("/srv/u"));
        relative.exe = PathBuf::from("bin/ai-memory");
        assert!(render(ServiceManager::SystemdUser, &relative).is_err());
    }

    #[test]
    fn the_launch_agent_fills_every_placeholder_and_escapes_xml() {
        let mut spec = spec(Path::new("/Users/a"));
        spec.data_dir = PathBuf::from("/Users/a/<x>&y");
        let unit = render(ServiceManager::Launchd, &spec).unwrap();
        assert_eq!(
            unit.path,
            Path::new("/Users/a/home/Library/LaunchAgents/com.github.akitaonrails.ai-memory.plist")
        );
        assert!(
            unit.contents
                .contains("<string>/Users/a/bin/ai-memory</string>")
        );
        assert!(unit.contents.contains(
            "<string>--data-dir</string>\n    <string>/Users/a/&lt;x&gt;&amp;y</string>"
        ));
        assert!(
            unit.contents
                .contains("<string>/Users/a/home/Library/Logs/ai-memory/stdout.log</string>")
        );
        assert!(!unit.contents.contains("<string>__"));
        assert!(unit.contents.contains("<string>serve</string>"));
    }

    #[test]
    fn a_first_systemd_install_writes_the_unit_and_starts_it() {
        let tmp = tempfile::tempdir().unwrap();
        let unit = render(ServiceManager::SystemdUser, &spec(tmp.path())).unwrap();
        let runner = FakeRunner {
            failing: vec!["systemctl --user is-active"],
            ..FakeRunner::default()
        };
        assert_eq!(install(&unit, &runner).unwrap(), ServiceChange::Installed);
        assert!(unit.is_current());
        assert_eq!(
            runner.calls.borrow().clone(),
            vec![
                "systemctl --user is-active --quiet ai-memory.service",
                "systemctl --user daemon-reload",
                "systemctl --user enable ai-memory.service",
                "systemctl --user restart ai-memory.service",
            ]
        );
    }

    /// The idempotence contract: a current unit with a running service makes
    /// no write and no state-changing call.
    #[test]
    fn a_current_running_systemd_unit_is_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let unit = render(ServiceManager::SystemdUser, &spec(tmp.path())).unwrap();
        write_unit(&unit).unwrap();
        let before = std::fs::metadata(&unit.path).unwrap().modified().unwrap();
        let runner = FakeRunner::default();
        assert_eq!(install(&unit, &runner).unwrap(), ServiceChange::Unchanged);
        assert_eq!(
            std::fs::metadata(&unit.path).unwrap().modified().unwrap(),
            before
        );
        assert!(
            runner
                .calls
                .borrow()
                .iter()
                .all(|call| call.contains("is-active") || call.contains("is-enabled")),
            "{:?}",
            runner.calls.borrow()
        );
    }

    #[test]
    fn a_changed_unit_is_rewritten_and_restarted() {
        let tmp = tempfile::tempdir().unwrap();
        let unit = render(ServiceManager::SystemdUser, &spec(tmp.path())).unwrap();
        std::fs::create_dir_all(unit.path.parent().unwrap()).unwrap();
        std::fs::write(&unit.path, "stale").unwrap();
        let runner = FakeRunner::default();
        assert_eq!(install(&unit, &runner).unwrap(), ServiceChange::Updated);
        assert!(unit.is_current());
        assert!(
            runner
                .calls
                .borrow()
                .contains(&"systemctl --user restart ai-memory.service".to_owned())
        );
    }

    #[test]
    fn a_failing_service_manager_is_an_error_with_its_output() {
        let tmp = tempfile::tempdir().unwrap();
        let unit = render(ServiceManager::SystemdUser, &spec(tmp.path())).unwrap();
        let runner = FakeRunner {
            failing: vec!["systemctl"],
            ..FakeRunner::default()
        };
        let err = install(&unit, &runner).unwrap_err();
        assert!(
            format!("{err:#}").contains("daemon-reload` failed: boom"),
            "{err:#}"
        );
    }

    #[test]
    fn a_launch_agent_is_bootstrapped_into_the_gui_domain() {
        let tmp = tempfile::tempdir().unwrap();
        let unit = render(ServiceManager::Launchd, &spec(tmp.path())).unwrap();
        let runner = FakeRunner {
            failing: vec!["launchctl print"],
            stdout: vec![("id -u", "501\n")],
            ..FakeRunner::default()
        };
        assert_eq!(install(&unit, &runner).unwrap(), ServiceChange::Installed);
        let plist = unit.path.to_string_lossy().into_owned();
        assert_eq!(
            runner.calls.borrow().clone(),
            vec![
                "id -u".to_owned(),
                "launchctl print gui/501/com.github.akitaonrails.ai-memory".to_owned(),
                "id -u".to_owned(),
                format!("launchctl bootstrap gui/501 {plist}"),
            ]
        );
        assert!(launchd_log_dir(&tmp.path().join("home")).is_dir());

        // Changed while loaded: booted out first, then bootstrapped again.
        std::fs::write(&unit.path, "stale").unwrap();
        let runner = FakeRunner {
            stdout: vec![("id -u", "501\n")],
            ..FakeRunner::default()
        };
        assert_eq!(install(&unit, &runner).unwrap(), ServiceChange::Updated);
        assert!(
            runner.calls.borrow().contains(
                &"launchctl bootout gui/501/com.github.akitaonrails.ai-memory".to_owned()
            )
        );
    }

    #[test]
    fn a_non_numeric_uid_is_refused() {
        let runner = FakeRunner {
            stdout: vec![("id -u", "501; rm -rf ~\n")],
            ..FakeRunner::default()
        };
        assert!(launchd_domain(&runner).is_err());
    }

    #[test]
    fn rendered_units_carry_an_identity_that_survives_only_unedited() {
        for manager in [ServiceManager::SystemdUser, ServiceManager::Launchd] {
            let unit = render(manager, &spec(Path::new("/srv/u"))).unwrap();
            assert!(is_rendered_by_setup(&unit.contents), "{manager:?}");
            // Hand-edited: any byte changed outside the identity line.
            let edited = unit.contents.replacen("serve", "serve --verbose", 1);
            assert!(!is_rendered_by_setup(&edited), "{manager:?} edited");
            // A copied identity line on a different body, or two of them.
            let line = unit
                .contents
                .lines()
                .find(|l| l.contains(IDENTITY_PREFIX))
                .unwrap();
            assert!(!is_rendered_by_setup(&format!(
                "{line}\n[Service]\nExecStart=/bin/evil\n"
            )));
            assert!(!is_rendered_by_setup(&format!("{line}\n{}", unit.contents)));
        }
        // The packaged template itself (what a package or a person installs)
        // is not ours.
        assert!(!is_rendered_by_setup(SYSTEMD_USER_TEMPLATE));
        assert!(!is_rendered_by_setup(LAUNCHD_TEMPLATE));
    }

    #[test]
    fn removing_our_systemd_unit_stops_disables_deletes_and_reloads_once() {
        let tmp = tempfile::tempdir().unwrap();
        let unit = render(ServiceManager::SystemdUser, &spec(tmp.path())).unwrap();
        write_unit(&unit).unwrap();
        let runner = FakeRunner::default();
        assert_eq!(
            remove(ServiceManager::SystemdUser, &unit.path, &runner).unwrap(),
            Removal::Removed(unit.path.clone())
        );
        assert!(!unit.path.exists());
        assert_eq!(
            runner.calls.borrow().clone(),
            vec![
                "systemctl --user disable --now ai-memory.service",
                "systemctl --user daemon-reload",
            ]
        );

        // A second removal finds nothing and calls nothing.
        let again = FakeRunner::default();
        assert_eq!(
            remove(ServiceManager::SystemdUser, &unit.path, &again).unwrap(),
            Removal::Absent
        );
        assert!(again.calls.borrow().is_empty());
    }

    /// Adversarial control: a unit `setup` did not write, or one edited after
    /// it did, is neither stopped nor deleted.
    #[test]
    fn a_foreign_or_edited_unit_is_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let unit = render(ServiceManager::SystemdUser, &spec(tmp.path())).unwrap();
        std::fs::create_dir_all(unit.path.parent().unwrap()).unwrap();
        for text in [
            SYSTEMD_USER_TEMPLATE.to_owned(),
            unit.contents
                .replacen("Restart=on-failure", "Restart=always", 1),
        ] {
            std::fs::write(&unit.path, &text).unwrap();
            let runner = FakeRunner::default();
            assert_eq!(
                remove(ServiceManager::SystemdUser, &unit.path, &runner).unwrap(),
                Removal::NotOurs(unit.path.clone())
            );
            assert_eq!(std::fs::read_to_string(&unit.path).unwrap(), text);
            assert!(runner.calls.borrow().is_empty());
        }
    }

    #[test]
    fn a_failed_disable_keeps_the_unit() {
        let tmp = tempfile::tempdir().unwrap();
        let unit = render(ServiceManager::SystemdUser, &spec(tmp.path())).unwrap();
        write_unit(&unit).unwrap();
        let runner = FakeRunner {
            failing: vec!["systemctl --user disable"],
            ..FakeRunner::default()
        };
        assert!(remove(ServiceManager::SystemdUser, &unit.path, &runner).is_err());
        assert!(unit.is_current());
    }

    #[test]
    fn removing_our_launch_agent_boots_it_out_then_deletes_it() {
        let tmp = tempfile::tempdir().unwrap();
        let unit = render(ServiceManager::Launchd, &spec(tmp.path())).unwrap();
        write_unit(&unit).unwrap();
        let runner = FakeRunner {
            stdout: vec![("id -u", "501\n")],
            ..FakeRunner::default()
        };
        assert_eq!(
            remove(ServiceManager::Launchd, &unit.path, &runner).unwrap(),
            Removal::Removed(unit.path.clone())
        );
        assert!(!unit.path.exists());
        assert_eq!(
            runner.calls.borrow().clone(),
            vec![
                "id -u",
                "launchctl print gui/501/com.github.akitaonrails.ai-memory",
                "launchctl bootout gui/501/com.github.akitaonrails.ai-memory",
            ]
        );
    }
}
