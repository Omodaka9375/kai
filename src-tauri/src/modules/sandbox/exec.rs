//! OS-level confinement (Layer 2) for agent shell commands.
//!
//! Wraps the one-shot shell command in the platform's confinement runner:
//!   - Linux: bubblewrap (`bwrap`) — read-only system dirs, rw project bind, private /tmp + /dev, `--unshare-net`, dies with the parent.
//!   - macOS: `sandbox-exec` with a generated Seatbelt profile.
//!   - Windows: dedicated WSL sandbox distro (see wsl.rs) — project mounted
//!     rw via drvfs, everything else unreachable, commands drop to a non-root
//!     in-distro user so the agent cannot mount the host disk.
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
    #[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
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
        let root = spec
            .root
            .to_str()
            .ok_or_else(|| format!("non-UTF-8 sandbox root: {}", spec.root.display()))?;
        if let Some(cmd) =
            crate::modules::sandbox::wsl::wrap_wsl(command, root, cwd, watchdog_secs, pid_file)
        {
            return Ok(Some(cmd));
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

/// System directories mounted read-only so toolchains resolve. Deliberately
/// NOT the whole root (`--ro-bind / /`): that exposed every host file —
/// `~/.ssh`, sibling projects' `.env`, keychain dirs — to agent shell reads,
/// which L2 promised to confine. HOME is never bound; tools that need a
/// home get HOME pointed at the project (see wrap_bwrap), so their caches
/// land inside the only rw location. Symlinked dirs (merged-usr /bin →
/// /usr/bin) are skipped — the real target covers them.
#[cfg(target_os = "linux")]
const RO_SYSTEM_DIRS: &[&str] = &[
    "/usr", "/etc", "/opt", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/libx32",
];

/// bwrap argv prefix (without the trailing shell args). Pure — unit-tested.
#[cfg(target_os = "linux")]
fn bwrap_args(root: &str) -> Vec<String> {
    let mut a = Vec::new();
    for dir in RO_SYSTEM_DIRS {
        // Skip symlinks (merged-usr layouts) and missing dirs — binding a
        // symlink makes bwrap follow it, duplicating the real target.
        match std::fs::symlink_metadata(dir) {
            Ok(m) if m.is_dir() => {
                a.push("--ro-bind".into());
                a.push((*dir).into());
                a.push((*dir).into());
            }
            _ => {}
        }
    }
    a.extend([
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
        "--".into(),
    ]);
    a
}

/// Minimal environment for confined commands. The parent's env (which may
/// carry API keys, tokens, proxy creds) must not leak into the sandbox —
/// `env_clear` plus exactly these vars. HOME is the project root so
/// toolchain caches (cargo registry, pnpm store) write inside the only rw
/// location instead of failing or escaping.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn minimal_env(root: &str) -> Vec<(String, String)> {
    vec![
        ("HOME".into(), root.into()),
        ("PATH".into(), "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".into()),
        ("TMPDIR".into(), "/tmp".into()),
        ("USER".into(), "sandbox".into()),
    ]
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
    // Scrub the environment BEFORE anything else: the confined command must
    // see exactly minimal_env, never the parent's (API keys, tokens).
    cmd.env_clear();
    for (k, v) in minimal_env(&root) {
        cmd.env(k, v);
    }
    for arg in bwrap_args(&root) {
        cmd.arg(arg);
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    // `-c`, not `-lc`: a login shell would source user dotfiles from the
    // ro-bound system dirs, which can undo cwd / set proxies at will.
    cmd.arg(shell).arg("-c").arg(command);
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
    // Escape the root for embedding inside the profile string literal: a
    // path containing `"` or `\` would otherwise corrupt the profile.
    let esc = root.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        "(version 1)\n\
         (deny default)\n\
         (allow file-read* (subpath \"/usr\") (subpath \"/bin\") (subpath \"/sbin\") (subpath \"/System\") (subpath \"/Library\"))\n\
         (allow file-read* (subpath \"/dev\") (subpath \"/etc\"))\n\
         (allow file-read* file-write* (subpath \"{esc}\"))\n\
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
    // Same env contract as the Linux arm: nothing from the parent leaks.
    cmd.env_clear();
    for (k, v) in minimal_env(&root) {
        cmd.env(k, v);
    }
    cmd.arg("-p").arg(seatbelt_profile(&root));
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // `-c`, not `-lc`: login shells source dotfiles, which can rewrite cwd
    // and set proxies inside the confinement.
    cmd.arg(shell).arg("-c").arg(command);
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
        // The whole-root ro-bind is GONE — only whitelisted system dirs are
        // bound, so agent shell reads cannot reach ~/.ssh or sibling projects.
        assert!(!args.windows(3).any(|w| w == ["--ro-bind".to_string(), "/".to_string(), "/".to_string()]),
            "must not bind the entire root fs read-only");
        let ro_idx = args.iter().position(|a| a == "--ro-bind").expect("at least one ro-bind (CI has /usr)");
        assert_eq!(args[ro_idx + 1], "/usr");
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
        // Exotic paths must not corrupt the profile literal.
        let q = seatbelt_profile("/Users/u/we\"ird");
        assert!(q.contains("we\\\"ird"));
    }

    #[test]
    fn try_wrap_wsl_repo_returns_none() {
        // WSL repos can't use host runners — plain fallback, not an error.
        let spec = SandboxSpec {
            root: PathBuf::from("/mnt/x"),
        };
        let ws = WorkspaceEnv::Wsl {
            distro: "Ubuntu".into(),
        };
        let r = try_wrap("echo hi", &spec, &ws, None, None, None).unwrap();
        assert!(r.is_none());
    }
}
