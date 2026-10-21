//! The parts of the desktop installer that do not need a window: deciding
//! which `ai-memory` binary to run, installing the bundled one where the
//! command-line installers put theirs, and reading the setup page's address
//! from `ai-memory setup --web`.
//!
//! The coexistence rules come from `docs/desktop/installer-and-coexistence.md`:
//! an existing install is used as it is and never overwritten, and the bundled
//! binary is copied out of the app bundle before anything runs it, because the
//! service `setup` registers names the binary it ran from, and a path inside a
//! `.app`, an install directory the next update replaces, or an AppImage mount
//! that exists only while the app runs would stop the server from starting.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, bail};

/// The binary's file name on this platform.
pub const EXE_NAME: &str = if cfg!(windows) {
    "ai-memory.exe"
} else {
    "ai-memory"
};

/// Where `install.sh` (Linux, macOS) or `install.ps1` (Windows) installs the
/// release, which is also where the bundled binary goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    /// The directory holding the binary and its `hooks/` bundle.
    pub lib_dir: PathBuf,
    /// A link on `PATH` to the binary (`~/.local/bin/ai-memory`); Windows
    /// puts `lib_dir` itself on the user `PATH` instead.
    pub link: Option<PathBuf>,
}

impl Layout {
    /// The layout for a home directory, or on Windows for
    /// `%LOCALAPPDATA%`.
    #[must_use]
    pub fn for_platform(home: &Path, local_app_data: Option<&Path>) -> Self {
        if cfg!(windows) {
            let base = local_app_data
                .map_or_else(|| home.join("AppData").join("Local"), Path::to_path_buf);
            Self {
                lib_dir: base.join("Programs").join("ai-memory"),
                link: None,
            }
        } else {
            Self {
                lib_dir: home.join(".local").join("lib").join("ai-memory"),
                link: Some(home.join(".local").join("bin").join(EXE_NAME)),
            }
        }
    }

    #[must_use]
    pub fn exe(&self) -> PathBuf {
        self.lib_dir.join(EXE_NAME)
    }
}

/// Which binary runs the setup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Choice {
    /// An install that already exists: used as it is.
    Existing(PathBuf),
    /// Nothing installed: copy the bundled binary into the layout first.
    InstallBundled,
}

/// Prefer the command-line installers' location, then an `ai-memory` found
/// on `PATH` (a package manager's, a hand-built one), and install the bundled
/// binary only when there is neither.
#[must_use]
pub fn choose(layout: &Layout, on_path: Option<PathBuf>) -> Choice {
    let installed = layout.exe();
    if installed.is_file() {
        return Choice::Existing(installed);
    }
    match on_path {
        Some(path) => Choice::Existing(path),
        None => Choice::InstallBundled,
    }
}

/// The first `ai-memory` in a `PATH` value.
#[must_use]
pub fn find_on_path(path: Option<OsString>) -> Option<PathBuf> {
    std::env::split_paths(&path?)
        .map(|dir| dir.join(EXE_NAME))
        .find(|candidate| candidate.is_absolute() && candidate.is_file())
}

/// Where package managers put `ai-memory`, searched after `PATH`: an app
/// started from the Dock or a desktop menu gets a minimal `PATH` that misses
/// Homebrew, Nix and Cargo, and would otherwise install a second copy.
#[must_use]
pub fn package_manager_dirs(home: &Path) -> Vec<PathBuf> {
    if cfg!(windows) {
        return vec![home.join(".cargo").join("bin")];
    }
    vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        home.join(".nix-profile").join("bin"),
        PathBuf::from("/run/current-system/sw/bin"),
        home.join(".cargo").join("bin"),
    ]
}

/// Copy the bundled binary and, when present, its `hooks/` bundle into
/// `layout`, the way the command-line installers lay them out, and link the
/// binary onto `PATH` on Linux and macOS when the link is free. Returns the
/// installed binary.
///
/// The copy goes to a temporary name first and is renamed into place, so an
/// interrupted copy never leaves a half-written binary where `setup` looks.
///
/// # Errors
/// When `layout` already holds a binary (it is never replaced), or a copy,
/// rename, permission change or link fails.
pub fn install_bundled(
    layout: &Layout,
    bundled_exe: &Path,
    bundled_hooks: Option<&Path>,
) -> Result<PathBuf> {
    let target = layout.exe();
    if target.exists() {
        bail!("{} already exists; it is left as it is", target.display());
    }
    std::fs::create_dir_all(&layout.lib_dir)
        .with_context(|| format!("creating {}", layout.lib_dir.display()))?;
    let staged = layout.lib_dir.join(format!("{EXE_NAME}.new"));
    std::fs::copy(bundled_exe, &staged)
        .with_context(|| format!("copying {} to {}", bundled_exe.display(), staged.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
            .with_context(|| format!("making {} executable", staged.display()))?;
    }
    std::fs::rename(&staged, &target)
        .with_context(|| format!("moving the binary to {}", target.display()))?;
    if let Some(hooks) = bundled_hooks.filter(|dir| dir.is_dir()) {
        copy_dir(hooks, &layout.lib_dir.join("hooks"))?;
    }
    if let Some(link) = &layout.link {
        link_binary(link, &target)?;
    }
    Ok(target)
}

#[cfg(unix)]
fn link_binary(link: &Path, target: &Path) -> Result<()> {
    if link.symlink_metadata().is_ok() {
        // Someone else's `ai-memory` (the Docker wrapper, a hand-built
        // binary): leave it, as `install.sh` does.
        return Ok(());
    }
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    std::os::unix::fs::symlink(target, link)
        .with_context(|| format!("linking {} to {}", link.display(), target.display()))
}

#[cfg(not(unix))]
fn link_binary(_link: &Path, _target: &Path) -> Result<()> {
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to).with_context(|| format!("creating {}", to.display()))?;
    for entry in std::fs::read_dir(from).with_context(|| format!("reading {}", from.display()))? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), &target)
                .with_context(|| format!("copying {}", entry.path().display()))?;
        }
        // Links are skipped: the release bundle holds none, and following one
        // could copy something from outside it.
    }
    Ok(())
}

/// The setup page's address in a line of `ai-memory setup --web` output: an
/// `http://127.0.0.1:<port>/s/<hex secret>/` URL and nothing else, so the
/// window never navigates anywhere `setup` did not print.
#[must_use]
pub fn setup_url(line: &str) -> Option<String> {
    let url = line.trim();
    let rest = url.strip_prefix("http://127.0.0.1:")?;
    let (port, rest) = rest.split_once('/')?;
    let secret = rest.strip_prefix("s/")?.strip_suffix('/')?;
    let port_ok = !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit());
    let secret_ok = secret.len() == 64 && secret.bytes().all(|b| b.is_ascii_hexdigit());
    (port_ok && secret_ok).then(|| url.to_owned())
}

/// What to tell the user when `setup --web` stopped before printing its
/// address. An install older than 3.1 has no `--web` and rejects the
/// arguments; the fix there is an upgrade, not the raw usage error.
#[must_use]
pub fn early_exit_message(exe: &Path, stderr: &str) -> String {
    let detail = stderr.trim();
    if detail.contains("unexpected argument") {
        return format!(
            "{} is too old for this installer (it needs ai-memory 3.1 or newer). Run \
             `ai-memory upgrade`, or update it with your package manager, then open this app \
             again.",
            exe.display()
        );
    }
    if detail.is_empty() {
        "ai-memory setup --web stopped before showing its page".to_owned()
    } else {
        format!("ai-memory setup --web stopped before showing its page: {detail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_matches_the_command_line_installers() {
        let home = Path::new(if cfg!(windows) {
            r"C:\Users\me"
        } else {
            "/home/me"
        });
        let layout = Layout::for_platform(home, None);
        if cfg!(windows) {
            assert!(
                layout
                    .lib_dir
                    .ends_with(r"AppData\Local\Programs\ai-memory")
            );
            assert_eq!(layout.link, None);
        } else {
            assert_eq!(layout.lib_dir, Path::new("/home/me/.local/lib/ai-memory"));
            assert_eq!(
                layout.link.as_deref(),
                Some(Path::new("/home/me/.local/bin/ai-memory"))
            );
        }
        assert_eq!(layout.exe(), layout.lib_dir.join(EXE_NAME));
    }

    /// An installed binary wins, then one on `PATH`; the bundled one is
    /// installed only when there is neither.
    #[test]
    fn an_existing_install_is_preferred_over_the_bundled_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout {
            lib_dir: tmp.path().join("lib"),
            link: None,
        };
        let elsewhere = tmp.path().join("elsewhere").join(EXE_NAME);
        assert_eq!(choose(&layout, None), Choice::InstallBundled);
        assert_eq!(
            choose(&layout, Some(elsewhere.clone())),
            Choice::Existing(elsewhere.clone())
        );
        std::fs::create_dir_all(&layout.lib_dir).unwrap();
        std::fs::write(layout.exe(), b"installed").unwrap();
        assert_eq!(
            choose(&layout, Some(elsewhere)),
            Choice::Existing(layout.exe())
        );
    }

    /// The bundled binary and hooks land in the layout, the binary is
    /// executable and linked, a second install refuses to replace it, and a
    /// link someone else owns is left alone.
    #[test]
    fn installing_copies_the_binary_and_hooks_and_never_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        let bundled = tmp.path().join("bundle");
        std::fs::create_dir_all(bundled.join("hooks").join("claude-code")).unwrap();
        std::fs::write(bundled.join(EXE_NAME), b"binary").unwrap();
        std::fs::write(bundled.join("hooks").join("_lib.sh"), b"lib").unwrap();
        std::fs::write(
            bundled.join("hooks").join("claude-code").join("stop.sh"),
            b"stop",
        )
        .unwrap();
        let layout = Layout {
            lib_dir: tmp.path().join("home/.local/lib/ai-memory"),
            link: Some(tmp.path().join("home/.local/bin").join(EXE_NAME)),
        };
        let installed = install_bundled(
            &layout,
            &bundled.join(EXE_NAME),
            Some(&bundled.join("hooks")),
        )
        .unwrap();
        assert_eq!(installed, layout.exe());
        assert_eq!(std::fs::read(&installed).unwrap(), b"binary");
        assert!(layout.lib_dir.join("hooks/claude-code/stop.sh").is_file());
        assert!(!layout.lib_dir.join(format!("{EXE_NAME}.new")).exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&installed).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755);
            let link = layout.link.as_ref().unwrap();
            assert_eq!(std::fs::read_link(link).unwrap(), installed);
        }

        std::fs::write(bundled.join(EXE_NAME), b"newer").unwrap();
        assert!(install_bundled(&layout, &bundled.join(EXE_NAME), None).is_err());
        assert_eq!(std::fs::read(layout.exe()).unwrap(), b"binary");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_someone_else_owns_is_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let bundled = tmp.path().join(EXE_NAME);
        std::fs::write(&bundled, b"binary").unwrap();
        let link = tmp.path().join("bin").join(EXE_NAME);
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::fs::write(&link, b"#!/bin/sh\necho wrapper\n").unwrap();
        let layout = Layout {
            lib_dir: tmp.path().join("lib"),
            link: Some(link.clone()),
        };
        install_bundled(&layout, &bundled, None).unwrap();
        assert_eq!(std::fs::read(&link).unwrap(), b"#!/bin/sh\necho wrapper\n");
    }

    /// Only the exact address shape `setup --web` prints is followed.
    #[test]
    fn only_a_loopback_setup_address_is_accepted() {
        let secret = "a".repeat(64);
        let good = format!("  http://127.0.0.1:41234/s/{secret}/  ");
        assert_eq!(setup_url(&good).as_deref(), Some(good.trim()));
        for bad in [
            format!("http://localhost:41234/s/{secret}/"),
            format!("https://127.0.0.1:41234/s/{secret}/"),
            format!("http://127.0.0.1:41234/s/{secret}"),
            format!("http://127.0.0.1:41234/s/{}/", "a".repeat(63)),
            format!("http://127.0.0.1:41234/s/{}/", "g".repeat(64)),
            format!("http://127.0.0.1:/s/{secret}/"),
            format!("http://127.0.0.1:41234@evil.example/s/{secret}/"),
            format!("http://127.0.0.1:41234/s/{secret}/extra"),
            "Open the setup page to choose your agents and apply:".to_owned(),
        ] {
            assert_eq!(setup_url(&bad), None, "{bad}");
        }
    }

    #[test]
    fn an_old_install_is_told_to_upgrade() {
        let exe = Path::new("/usr/bin/ai-memory");
        let old = early_exit_message(
            exe,
            "error: unexpected argument '--web' found\n\nUsage: ai-memory setup [OPTIONS]\n",
        );
        assert!(
            old.contains("ai-memory upgrade") && old.contains("/usr/bin/ai-memory"),
            "{old}"
        );
        assert_eq!(
            early_exit_message(exe, "  "),
            "ai-memory setup --web stopped before showing its page"
        );
        assert!(early_exit_message(exe, "boom").ends_with(": boom"));
    }

    #[test]
    fn path_search_finds_only_absolute_existing_binaries() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("bin");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(find_on_path(Some(dir.clone().into_os_string())), None);
        std::fs::write(dir.join(EXE_NAME), b"x").unwrap();
        let path = std::env::join_paths([PathBuf::from("relative"), dir.clone()]).unwrap();
        assert_eq!(find_on_path(Some(path)), Some(dir.join(EXE_NAME)));
        assert_eq!(find_on_path(None), None);
    }
}
