//! OS-level confinement (Layer 2) for agent shell commands.
//!
//! Wraps the one-shot shell command in the platform's confinement runner:
//!   - Linux: bubblewrap (`bwrap`) — read-only root fs, rw project bind, private /tmp + /dev, `--unshare-net`, dies with the parent.
//!   - macOS: `sandbox-exec` with a generated Seatbelt profile.
//!   - Windows: not enforced in this layer (L1 policy only). A true Windows L2 needs a dedicated WSL sandbox distro (imported rootfs with drvfs mounts disabled) — routing through a default distro would expose the FULL host disk via /mnt/c, which is worse than no sandbox.
//!
//! Only `workspaceOnly` mode routes here — `readOnly` keeps L1 semantics
//! (an OS wall would also block reads, which readOnly explicitly allows).
//!
//! When the platform runner is unavailable, `try_wrap` returns `None` and the
//! caller falls through to the plain command: L1 stays the gate, with a
//! one-time log so the user knows the OS layer is missing.

use std::path::PathBuf;
use std::process::Command;

use crate::modules::workspace::WorkspaceEnv;

/// What the agent shell is confined to. `root` is the project workspace.
/// On platforms without a confinement runner (Windows) the field is unused —
/// gated dead-code allowance keeps cross-platform construction compiling.
#[derive(Debug, Clone)]
pub struct SandboxSpec {
    #[cfg_attr(
        not(any(target_os = "linux", target_os = "macos")),
        allow(dead_code)
    )]
    pub root: PathBuf,
}

/// One-time "runner missing" notices so we don't spam the log per command.
fn note_once(what: &'static str) {
    use std::collections::HashSet;
    use std::sync::{LazyLock, Mutex};
    static NOTED: LazyLock<Mutex<HashSet<&'static str>>> =
        LazyLock::new(|| Mutex::new(HashSet::new()));
    let mut noted = crate::modules::lock::mutex_lock(&NOTED);
    if noted.insert(what) {
        log::warn!("sandbox: {what} — OS confinement unavailable, L1 policy only");
    }
}

/// Wrap `command` for OS confinement. Returns `Ok(None)` when this platform
/// has no runner available (caller falls through to the plain command).
/// The returned Command still needs stdio/cwd set by the caller.
/// `watchdog_secs` arms an in-runner watchdog where killing the host client
/// would not kill the confined process (WSL) — None for platforms where the
/// host controls the process tree directly. `pid_file` (WSL background procs)
/// records the in-distro leader pid so `kill_in_distro` can reap it later.
pub fn try_wrap(
    command: &str,
    spec: &SandboxSpec,
    workspace: &WorkspaceEnv,
    cwd: Option<&str>,
    watchdog_secs: Option<u64>,
    pid_file: Option<&str>,
) -> Result<Option<Command>, String> {
    // Consumed only by the Windows (WSL) arm; sink them elsewhere so they
    // don't warn under CI clippy `-D warnings`.
    #[cfg(not(windows))]
    let _ = (watchdog_secs, pid_file);
    // A WSL repo resolves its paths inside the distro; the host runner
    // cannot see those. Skip OS confinement there — L1 applies.
    if workspace.is_wsl() {
        return Ok(None);
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(cmd) = wrap_bwrap(command, spec, cwd)? {
            return Ok(Some(cmd));
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(cmd) = wrap_sandbox_exec(command, spec, cwd)? {
            return Ok(Some(cmd));
        }
    }
    #[cfg(windows)]
    {
        if let Some(root) = spec.root.to_str() {
            if let Some(cmd) = crate::modules::sandbox::wsl::wrap_wsl(
                command,
                root,
                cwd,
                watchdog_secs,
                pid_file,
            ) {
                return Ok(Some(cmd));
            }
        }
        note_once("sandbox distro not installed — install it in Settings > Sandbox");
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (command, spec, cwd);
        note_once("no OS confinement runner on this platform");
    }
    Ok(None)
}

// ── Linux: bubblewrap ────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn bwrap_available() -> bool {
    static OK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *OK.get_or_init(|| {
        std::process::Command::new("bwrap")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

/// bwrap argv prefix (without the trailing shell args). Pure — unit-tested.
#[cfg(target_os = "linux")]
fn bwrap_args(root: &str) -> Vec<String> {
    let mut a = vec![
        "--ro-bind".into(),
        "/".into(),
        "/".into(), // read-only view of the whole root fs
        "--bind".into(),
        root.into(),
        root.into(), // rw project bind (project must be writable)
        "--dev".into(),
        "/dev".into(),
        "--proc".into(),
        "/proc".into(),
        "--tmpfs".into(),
        "/tmp".into(), // private writable tmp
        "--tmpfs".into(),
        "/run".into(),
        "--unshare-net".into(), // no network (LLN: no exfil channel)
        "--die-with-parent".into(),
        "--new-session".into(), // no dbus session escape
    ];
    a.push("--".into());
    a
}

#[cfg(target_os = "linux")]
fn wrap_bwrap(
    command: &str,
    spec: &SandboxSpec,
    cwd: Option<&str>,
) -> Result<Option<Command>, String> {
    if !bwrap_available() {
        note_once("bwrap not installed");
        return Ok(None);
    }
    let root = spec
        .root
        .to_str()
        .ok_or_else(|| format!("non-UTF-8 sandbox root: {}", spec.root.display()))?
        .to_string();
    let mut cmd = Command::new("bwrap");
    {
        use std::os::unix::process::CommandExt;
        // New process group so kill_child_tree can reap bwrap AND children.
            cmd.process_group(0);
    }
    for arg in bwrap_args(&root) {
        cmd.arg(arg);
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    cmd.arg(shell).arg("-lc").arg(command);
    if let Some(dir) = cwd.filter(|s| !s.is_empty()) {
        cmd.current_dir(dir);
    }
    Ok(Some(cmd))
}

// ── macOS: sandbox-exec (Seatbelt) ───────────────────────────────────────

#[cfg(target_os = "macos")]
fn sandbox_exec_available() -> bool {
    std::path::Path::new("/usr/bin/sandbox-exec").exists()
}

/// Generate a Seatbelt profile confining reads+writes to the project and
/// system read locations, with networking denied. Pure — unit-tested.
#[cfg(target_os = "macos")]
fn seatbelt_profile(root: &str) -> String {
    format!(
        "(version 1)\n\
         (deny default)\n\
         (allow file-read* (subpath \"/usr\") (subpath \"/bin\") (subpath \"/sbin\") (subpath \"/System\") (subpath \"/Library\"))\n\
         (allow file-read* (subpath \"/dev\") (subpath \"/etc\"))\n\
         (allow file-read* file-write* (subpath \"{root}\"))\n\
         (allow process*)\n\
         (deny network*)\n"
    )
}

#[cfg(target_os = "macos")]
fn wrap_sandbox_exec(
    command: &str,
    spec: &SandboxSpec,
    cwd: Option<&str>,
) -> Result<Option<Command>, String> {
    if !sandbox_exec_available() {
        note_once("sandbox-exec not present");
        return Ok(None);
    }
    let root = spec
        .root
        .to_str()
        .ok_or_else(|| format!("non-UTF-8 sandbox root: {}", spec.root.display()))?
        .to_string();
    let mut cmd = Command::new("/usr/bin/sandbox-exec");
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.arg("-p").arg(seatbelt_profile(&root));
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    cmd.arg(shell).arg("-lc").arg(command);
    if let Some(dir) = cwd.filter(|s| !s.is_empty()) {
        cmd.current_dir(dir);
    }
    Ok(Some(cmd))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn bwrap_args_bind_root_rw_and_unshare_net() {
        let args = bwrap_args("/home/u/proj");
        assert!(args.contains(&"--ro-bind".to_string()));
        // Root is bound rw (project writes must work).
        let bind_idx = args.iter().position(|a| a == "--bind").unwrap();
        assert_eq!(args[bind_idx + 1], "/home/u/proj");
        assert_eq!(args[bind_idx + 2], "/home/u/proj");
        assert!(args.contains(&"--unshare-net".to_string()));
        assert_eq!(*args.last().unwrap(), "--".to_string());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn seatbelt_confines_to_root_and_denies_net() {
        let p = seatbelt_profile("/Users/u/proj");
        assert!(p.contains("(subpath \"/Users/u/proj\")"));
        assert!(p.contains("(deny network*)"));
        assert!(p.contains("(allow file-write* (subpath \"/Users/u/proj\")"));
    }

    #[test]
    fn try_wrap_wsl_repo_returns_none() {
        // WSL repos can't use host runners — plain fallback, not an error.
        let spec = SandboxSpec { root: PathBuf::from("/mnt/x") };
        let ws = WorkspaceEnv::Wsl { distro: "Ubuntu".into() };
        let r = try_wrap("echo hi", &spec, &ws, None, None, None).unwrap();
        assert!(r.is_none());
    }
}
