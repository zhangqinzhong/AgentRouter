//! `ai-memory setup` through the shipped binary, in a temp home.
//!
//! The service manager is a test double: a `systemctl` script first on `PATH`
//! that records every call and, on `restart`, runs the rendered unit's
//! `ExecStart` in the background. No real user session, unit directory or
//! harness config is touched.

#![cfg(unix)]

use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

use crate::e2e_support::hermetic;

const BIN: &str = env!("CARGO_BIN_EXE_ai-memory");

/// A temp root holding the operator's home and a directory of fake tools.
struct Sandbox {
    _tmp: tempfile::TempDir,
    // Only the Linux service test reads it.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    root: PathBuf,
    home: PathBuf,
}

impl Sandbox {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        Self {
            _tmp: tmp,
            root,
            home,
        }
    }

    /// The default data dir `setup` resolves in this home: macOS uses
    /// `~/Library/Application Support`, other Unix the XDG data dir.
    fn data_dir(&self) -> PathBuf {
        if cfg!(target_os = "macos") {
            self.home.join("Library/Application Support/ai-memory")
        } else {
            self.home.join(".local/share/ai-memory")
        }
    }

    /// Every file under the home with its contents, the database and logs
    /// aside (the running server owns those).
    fn snapshot(&self) -> Vec<(PathBuf, Vec<u8>)> {
        let skip = [self.data_dir().join("db"), self.data_dir().join("logs")];
        let mut files = Vec::new();
        let mut pending = vec![self.home.clone()];
        while let Some(dir) = pending.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                if skip.iter().any(|s| path.starts_with(s)) {
                    continue;
                }
                if path.is_dir() {
                    pending.push(path);
                } else {
                    files.push((path.clone(), std::fs::read(&path).unwrap_or_default()));
                }
            }
        }
        files.sort();
        files
    }

    fn cmd(&self, port: Option<u16>) -> Command {
        let mut cmd = hermetic(BIN);
        cmd.env("HOME", &self.home)
            .env("AI_MEMORY_HOME", &self.home)
            .env("XDG_CONFIG_HOME", self.home.join(".config"))
            .env("XDG_DATA_HOME", self.home.join(".local/share"))
            .env("AI_MEMORY_EMBEDDING_PROVIDER", "none")
            .env("AI_MEMORY_BACKFILL_ON_START", "false")
            .env("AI_MEMORY_AUTO_IMPROVE__SCHEDULER__ENABLED", "false")
            .env("RUST_LOG", "off")
            .env_remove("CLAUDE_CODE_SESSION_ID")
            .env_remove("MUSE_SESSION_ID")
            .current_dir(&self.home)
            .stdin(Stdio::null());
        if let Some(port) = port {
            // Never the default port: a real server may be listening there.
            cmd.env("AI_MEMORY_BIND", format!("127.0.0.1:{port}"))
                .env("AI_MEMORY_SERVER_URL", format!("http://127.0.0.1:{port}"));
        }
        cmd
    }
}

fn text(out: &Output) -> String {
    format!(
        "status: {}\nstdout: {}\nstderr: {}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

/// Without `--yes` and with no terminal on stdin, `setup` shows the plan,
/// changes nothing and exits non-zero naming `--yes`.
#[test]
fn setup_without_yes_and_without_a_terminal_changes_nothing() {
    let sandbox = Sandbox::new();
    std::fs::create_dir_all(sandbox.home.join(".claude/projects")).unwrap();
    let before = sandbox.snapshot();
    let port = crate::e2e_support::free_port();
    let out = sandbox.cmd(Some(port)).arg("setup").output().unwrap();
    assert!(!out.status.success(), "{}", text(&out));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("ai-memory setup will:"), "{}", text(&out));
    assert!(
        stdout.contains("wire claude-code (detected)"),
        "{}",
        text(&out)
    );
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("--yes"),
        "{}",
        text(&out)
    );
    // Any command opens its log under the data dir; nothing else may appear.
    assert!(!sandbox.data_dir().join("config.toml").exists());
    assert!(!sandbox.data_dir().join("auth-tokens").exists());
    assert_eq!(sandbox.snapshot(), before, "setup wrote without --yes");
}

/// Spawns a server through the fake service manager: the slow tier.
#[cfg(target_os = "linux")]
mod slow {
    use super::*;
    use serde_json::{Value, json};
    use std::path::Path;
    use std::time::{Duration, Instant};

    /// `systemctl --user` stand-in. `restart` runs the unit's `ExecStart`
    /// (the rendered paths carry no `%` or `$`, so shell word splitting
    /// matches systemd's here).
    const FAKE_SYSTEMCTL: &str = r#"#!/bin/sh
state="${FAKE_SYSTEMD_STATE:?}"
mkdir -p "$state"
printf '%s\n' "$*" >> "$state/calls"
[ "$1" = "--user" ] || exit 2
shift
unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/ai-memory.service"
alive() { [ -f "$state/pid" ] && kill -0 "$(cat "$state/pid")" 2>/dev/null; }
case "$1" in
  daemon-reload) ;;
  enable) touch "$state/enabled" ;;
  is-enabled) [ -f "$state/enabled" ] ;;
  is-active) alive ;;
  disable)
    rm -f "$state/enabled"
    if [ "$2" = "--now" ] && alive; then kill "$(cat "$state/pid")"; rm -f "$state/pid"; fi ;;
  restart)
    if alive; then kill "$(cat "$state/pid")"; sleep 0.2; fi
    line="$(sed -n 's/^ExecStart=//p' "$unit")"
    eval "set -- $line"
    "$@" >"$state/server.log" 2>&1 &
    echo $! > "$state/pid"
    ;;
  *) exit 3 ;;
esac
"#;

    struct Service {
        state: PathBuf,
        bin: PathBuf,
    }

    impl Service {
        fn new(root: &Path) -> Self {
            use std::os::unix::fs::PermissionsExt as _;
            let bin = root.join("fakebin");
            std::fs::create_dir_all(&bin).unwrap();
            let script = bin.join("systemctl");
            std::fs::write(&script, FAKE_SYSTEMCTL).unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            Self {
                state: root.join("systemd"),
                bin,
            }
        }

        fn calls(&self) -> Vec<String> {
            std::fs::read_to_string(self.state.join("calls"))
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect()
        }

        fn apply(&self, cmd: &mut Command) {
            let path = std::env::var_os("PATH").unwrap_or_default();
            let mut joined = std::ffi::OsString::from(&self.bin);
            joined.push(":");
            joined.push(path);
            cmd.env("PATH", joined)
                .env("FAKE_SYSTEMD_STATE", &self.state);
        }
    }

    impl Drop for Service {
        fn drop(&mut self) {
            if let Ok(pid) = std::fs::read_to_string(self.state.join("pid")) {
                let _ = Command::new("kill").arg(pid.trim()).status();
            }
        }
    }

    fn setup(sandbox: &Sandbox, service: &Service, port: u16, args: &[&str]) -> Output {
        let mut cmd = sandbox.cmd(Some(port));
        service.apply(&mut cmd);
        cmd.arg("setup").args(args).output().unwrap()
    }

    async fn captured_sessions(base: &str, token: &str, workspace: &str, project: &str) -> u64 {
        let client = reqwest::Client::new();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let resp = client
                .get(format!("{base}/admin/sessions/by-agent"))
                .bearer_auth(token)
                .query(&[("workspace", workspace), ("project", project)])
                .send()
                .await
                .unwrap();
            let count = if resp.status().is_success() {
                let body: Value = resp.json().await.unwrap();
                body["by_agent"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|x| x["sessions"].as_u64()).sum())
                    .unwrap_or(0)
            } else {
                0
            };
            if count > 0 || Instant::now() >= deadline {
                return count;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Fresh home with Claude Code present: one `setup --yes` initialises the
    /// install with a token, writes and starts the user unit on this install,
    /// wires MCP, hooks and skills without the token in any harness file, and
    /// passes its own self-check. A captured hook event reaches the server. A
    /// second run changes no file and makes no state-changing service call.
    #[tokio::test]
    async fn setup_installs_wires_is_idempotent_and_uninstall_removes_its_unit() {
        let sandbox = Sandbox::new();
        let service = Service::new(&sandbox.root);
        std::fs::create_dir_all(sandbox.home.join(".claude/projects")).unwrap();
        let repo = sandbox.home.join("work/repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(
            repo.join(".ai-memory.toml"),
            "workspace = \"setup-ws\"\nproject = \"setup-project\"\n",
        )
        .unwrap();
        let port = crate::e2e_support::free_port();
        let base = format!("http://127.0.0.1:{port}");

        let first = setup(&sandbox, &service, port, &["--yes"]);
        assert!(first.status.success(), "{}", text(&first));
        let stdout = String::from_utf8_lossy(&first.stdout);
        assert!(stdout.contains("healthz: ok"), "{}", text(&first));
        assert!(stdout.contains("memory_status: ok"), "{}", text(&first));

        let data_dir = sandbox.data_dir();
        let token = std::fs::read_to_string(data_dir.join("auth-tokens/default"))
            .unwrap()
            .trim()
            .to_owned();
        assert!(!token.is_empty());
        assert!(!stdout.contains(&token), "setup printed the token");
        let unit =
            std::fs::read_to_string(sandbox.home.join(".config/systemd/user/ai-memory.service"))
                .unwrap();
        let exec = unit
            .lines()
            .find(|line| line.starts_with("ExecStart="))
            .unwrap();
        assert!(
            exec.contains(&format!("--data-dir \"{}\"", data_dir.display())),
            "{exec}"
        );
        assert!(
            exec.contains(&format!(
                "--config \"{}\"",
                data_dir.join("config.toml").display()
            )),
            "{exec}"
        );
        assert!(!unit.contains(&token), "the unit holds the token");
        assert_eq!(
            service.calls(),
            vec![
                "--user is-active --quiet ai-memory.service",
                "--user daemon-reload",
                "--user enable ai-memory.service",
                "--user restart ai-memory.service",
            ]
        );

        // The token lives only in the token file and the hook credential files.
        let allowed = [
            data_dir.join("auth-tokens/default"),
            data_dir.join("auth-token"),
            data_dir.join("auth-header"),
            data_dir.join("hook-spool"),
            data_dir.join("db"),
        ];
        let leaks: Vec<_> = sandbox
            .snapshot()
            .into_iter()
            .filter(|(path, bytes)| {
                !allowed.iter().any(|a| path.starts_with(a))
                    && bytes.windows(token.len()).any(|w| w == token.as_bytes())
            })
            .map(|(path, _)| path)
            .collect();
        assert!(leaks.is_empty(), "token found in {leaks:?}");

        // Wired: MCP through the bridge, hooks, skills.
        let claude: Value = serde_json::from_str(
            &std::fs::read_to_string(sandbox.home.join(".claude.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(claude["mcpServers"]["ai-memory"]["args"][0], "mcp-bridge");
        let settings = std::fs::read_to_string(sandbox.home.join(".claude/settings.json")).unwrap();
        assert!(settings.contains("user-prompt-submit"), "{settings}");
        assert!(
            sandbox
                .home
                .join(".claude/skills/ai-memory-retrieval/SKILL.md")
                .is_file()
        );

        // A hook event, the way the installed hook sends it, is captured.
        let mut hook = sandbox.cmd(Some(port));
        let mut child = hook
            .args([
                "hook",
                "--event",
                "user-prompt-submit",
                "--agent",
                "claude-code",
                "--server-url",
                &base,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        {
            use std::io::Write as _;
            let payload = json!({
                "session_id": "setup-e2e-session",
                "cwd": repo,
                "prompt": "setup e2e prompt",
            });
            child
                .stdin
                .take()
                .unwrap()
                .write_all(payload.to_string().as_bytes())
                .unwrap();
        }
        assert!(child.wait().unwrap().success());
        let drain = sandbox.cmd(Some(port)).arg("hook-drain").output().unwrap();
        assert!(drain.status.success(), "{}", text(&drain));
        assert_eq!(
            captured_sessions(&base, &token, "setup-ws", "setup-project").await,
            1
        );

        // Second run: same bytes everywhere, no state-changing call.
        let before = sandbox.snapshot();
        let calls_before = service.calls().len();
        let second = setup(&sandbox, &service, port, &["--yes"]);
        assert!(second.status.success(), "{}", text(&second));
        assert!(
            String::from_utf8_lossy(&second.stdout).contains("already running"),
            "{}",
            text(&second)
        );
        let after = sandbox.snapshot();
        let changed: Vec<_> = before
            .iter()
            .zip(after.iter())
            .filter(|(a, b)| a != b)
            .map(|(a, _)| a.0.clone())
            .collect();
        assert_eq!(
            before.len(),
            after.len(),
            "the second run added or removed files"
        );
        assert!(changed.is_empty(), "the second run changed {changed:?}");
        assert_eq!(
            service.calls()[calls_before..].to_vec(),
            vec![
                "--user is-active --quiet ai-memory.service",
                "--user is-enabled --quiet ai-memory.service",
            ]
        );

        // uninstall stops and removes the unit setup wrote, and only once.
        let unit_path = sandbox.home.join(".config/systemd/user/ai-memory.service");
        let calls_before = service.calls().len();
        let removed = uninstall(&sandbox, &service, port);
        assert!(removed.status.success(), "{}", text(&removed));
        assert!(
            String::from_utf8_lossy(&removed.stdout)
                .contains("stopped and removed the user service"),
            "{}",
            text(&removed)
        );
        assert!(!unit_path.exists());
        assert_eq!(
            service.calls()[calls_before..].to_vec(),
            vec![
                "--user disable --now ai-memory.service",
                "--user daemon-reload",
            ]
        );
        let calls_before = service.calls().len();
        let again = uninstall(&sandbox, &service, port);
        assert!(again.status.success(), "{}", text(&again));
        assert_eq!(
            service.calls().len(),
            calls_before,
            "a second uninstall called systemctl"
        );
    }

    fn uninstall(sandbox: &Sandbox, service: &Service, port: u16) -> Output {
        let mut cmd = sandbox.cmd(Some(port));
        service.apply(&mut cmd);
        cmd.args(["uninstall", "--apply", "--yes"])
            .output()
            .unwrap()
    }

    /// Adversarial control: a unit at the same path that `setup` did not
    /// write (the packaged one copied by hand), or one edited after `setup`
    /// wrote it, is neither stopped nor deleted, and uninstall says so.
    #[test]
    fn uninstall_leaves_a_unit_it_did_not_write() {
        let sandbox = Sandbox::new();
        let service = Service::new(&sandbox.root);
        let unit_path = sandbox.home.join(".config/systemd/user/ai-memory.service");
        std::fs::create_dir_all(unit_path.parent().unwrap()).unwrap();
        let foreign = include_str!("../../../../packaging/systemd/ai-memory-user.service");
        std::fs::write(&unit_path, foreign).unwrap();
        let port = crate::e2e_support::free_port();

        let out = uninstall(&sandbox, &service, port);
        assert!(out.status.success(), "{}", text(&out));
        assert!(
            String::from_utf8_lossy(&out.stdout).contains("did not write it"),
            "{}",
            text(&out)
        );
        assert_eq!(std::fs::read_to_string(&unit_path).unwrap(), foreign);
        assert!(service.calls().is_empty(), "{:?}", service.calls());
    }
}
