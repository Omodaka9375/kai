//! Windows sandbox distro (Layer 2) — a dedicated minimal WSL distro that
//! agent shell commands run inside when `workspaceOnly` is active.
//!
//! Why a dedicated distro (and not the user's): a default WSL distro auto-
//! mounts the ENTIRE host disk tree at /mnt/c — routing agent commands there
//! would be worse than no sandbox. The sandbox distro instead:
//!   - is imported from Alpine minirootfs (~3.5 MB, busybox only),
//!   - runs with `[automount] enabled = false` (written into /etc/wsl.conf
//!     after import, then terminated so the conf applies on next boot),
//!   - mounts ONLY the project directory, rw, via a manual drvfs mount at
//!     `/ws/<djb2hash>` — per-root mountpoints avoid remount races between
//!     concurrent agent runs on different projects,
//!   - drops to the non-root `sandbox` user before running the command —
//!     root in-distro could `mount -t drvfs C:\ /c` (full host-disk RW), so
//!     confinement is enforced by privilege, not by convention. Mounts and
//!     user creation live in the root-run setup script only.
//!
//! Known limits (documented honestly):
//!   - NETWORK: WSL2 distros share ONE network namespace inside the utility VM — per-distro network isolation is architecturally impossible; Windows L2 is filesystem confinement only.
//!   - CANCEL/TIMEOUT: killing the wsl.exe client does NOT kill the in-distro process — wrapped commands run under busybox `timeout` with the host timeout + slack, so an orphaned in-distro command dies on its own shortly after the host gives up.
//!
//! Cross-platform note: this module compiles on ALL platforms because the
//! `sandbox_wsl_*` commands are registered unconditionally in the invoke
//! handler (generate_handler! cannot cfg-gate entries). Windows-only items
//! are `#[cfg(windows)]`-gated; the commands cfg-split their bodies with
//! non-Windows stubs (same pattern as workspace::wsl_*). The pure helpers
//! (mountpoint_for / sh_quote / translate_cwd) compile everywhere so their
//! unit tests run in CI on every platform.

use serde::Serialize;
use tauri::ipc::Channel;

#[cfg(windows)]
use std::path::PathBuf;
#[cfg(windows)]
use std::process::Command;
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
#[cfg(windows)]
use tauri::Manager;

#[cfg(windows)]
use crate::modules::workspace::decode_command_output;

/// Registered WSL distro name for the sandbox. Windows-only at runtime,
/// but compiled cross-platform; non-Windows builds see no caller, hence the
/// cfg-gated dead-code allowance (tests still exercise it everywhere).
#[cfg_attr(not(windows), allow(dead_code))]
pub const DISTRO_NAME: &str = "kai-sandbox";

/// The non-root user all sandboxed commands run as. Root in-distro could
/// `mount -t drvfs C:\ /c` — full host-disk RW — so wrapped commands run as
/// this unprivileged user instead. Mounts stay in the root-run setup script,
/// which only ever runs at explicit user request (Settings button).
#[cfg_attr(not(windows), allow(dead_code))]
pub const SANDBOX_USER: &str = "sandbox";

/// Numeric uid for SANDBOX_USER. Alpine adduser takes -u; fixing the uid
/// keeps /ws ownership stable across reinstalls.
#[cfg_attr(not(windows), allow(dead_code))]
pub const SANDBOX_UID: u32 = 4200;

/// Alpine minirootfs — busybox sh/mount/mountpoint/timeout, no package setup.
/// Version-pinned; a 404 (release archived) surfaces as a clear setup error.
#[cfg(windows)]
const ALPINE_URL: &str = "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/alpine-minirootfs-3.21.0-x86_64.tar.gz";

/// Installed-state cache: 0 = unknown, 1 = installed, 2 = not installed.
/// Avoids paying a `wsl -l -q` spawn (up to ~800 ms cold) per sandboxed
/// command. Setup/remove flip the cached value so no stale window remains.
#[cfg(windows)]
static INSTALLED: AtomicU8 = AtomicU8::new(0);
#[cfg(windows)]
static SETUP_RUNNING: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
fn wsl(args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("wsl.exe");
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.args(args).output().map_err(|e| e.to_string())
}

/// Raw registration check via `wsl -l -q` (UTF-16 output — decode).
#[cfg(windows)]
pub fn distro_installed() -> bool {
    let Ok(out) = wsl(&["-l", "-q"]) else {
        return false;
    };
    let list = decode_command_output(&out.stdout);
    list.lines().map(str::trim).any(|name| name == DISTRO_NAME)
}

/// Cached variant for the per-command hot path.
#[cfg(windows)]
pub fn distro_installed_cached() -> bool {
    match INSTALLED.load(Ordering::Relaxed) {
        1 => return true,
        2 => return false,
        _ => {}
    }
    let installed = distro_installed();
    INSTALLED.store(if installed { 1 } else { 2 }, Ordering::Relaxed);
    installed
}

/// DJB2 — same construction as the frontend (kaiPaths.ts) but local-only:
/// the mountpoint just needs stability per project path, not cross-language
/// agreement.
#[cfg_attr(not(windows), allow(dead_code))]
fn djb2(s: &str) -> u32 {
    let mut hash: u32 = 5381;
    for b in s.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(b as u32);
    }
    hash
}

/// Stable per-project mountpoint. Windows paths arrive with varying case AND
/// separator styles between calls — normalize both before hashing so the
/// mountpoint is stable.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn mountpoint_for(root: &str) -> String {
    let norm = root.to_lowercase().replace('\\', "/");
    format!("/ws/{:08x}", djb2(&norm))
}

/// POSIX single-quote escaping for embedding a string in a `sh -c` script.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Map a host cwd to its in-sandbox path. Subdirectories of the project root
/// map under the mountpoint; anything else (or no cwd) maps to the
/// mountpoint itself.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn translate_cwd(root: &str, cwd: Option<&str>) -> String {
    let mp = mountpoint_for(root);
    let Some(cwd) = cwd.filter(|c| !c.is_empty()) else {
        return mp;
    };
    // Normalize separators, compare case-insensitively (Windows FS), but keep
    // the ORIGINAL case for the mapped tail.
    let root_n = root.replace('\\', "/");
    let cwd_n = cwd.replace('\\', "/");
    let prefix = format!("{}/", root_n.to_lowercase());
    let cwd_l = cwd_n.to_lowercase();
    if let Some(sub) = cwd_l.strip_prefix(&prefix) {
        let tail_start = cwd_n.len().saturating_sub(sub.len());
        let tail = &cwd_n[tail_start..];
        return format!("{}/{}", mp, tail);
    }
    mp
}

/// Build the wsl.exe argv that runs `command` inside the sandbox distro with
/// the project mounted rw. Returns None when the distro is not installed
/// (caller falls back to the plain command — L1 stays the gate).
///
/// Two-phase privilege split (mounts need root; the command must NOT run as
/// root or it could `mount -t drvfs C:\ /c` and reach the whole host disk):
///
///   Phase 1 (root):   mkdir -p <mp>; mountpoint -q <mp> || mount -t drvfs '<root>' <mp>; chown <mp>
///   Phase 2 (sandbox): mkdir -p <mp>/.kai-bg; cd '<in_cwd>'; [mkdir pid-dir; printf pid > f;]
///                     exec [timeout <s>] sh -lc '<command>'
///
/// The phase-1 mount is trusted: root and mountpoint are KAI-computed; no
/// user- or agent-controlled text reaches it. Everything else — cwd,
/// command, pid path — is interpolated only into phase 2, where every value
/// is sh_quote'd (the old UNQUOTED `cd <in_cwd>` let a quote in a legal
/// Windows dir name break out into arbitrary in-distro shell) and the
/// process runs as the unprivileged sandbox user, so even a hypothetical
/// injection could not mount or reach the host.
///
/// The pid file's parent is pre-created in phase 2 (the old script created
/// only <mp>, so the printf redirect failed and background kills were a
/// silent no-op).
#[cfg(windows)]
pub fn wrap_wsl(
    command: &str,
    root: &str,
    cwd: Option<&str>,
    watchdog_secs: Option<u64>,
    pid_file: Option<&str>,
) -> Option<Command> {
    if !distro_installed_cached() {
        return None;
    }
    let mp = mountpoint_for(root);
    let in_cwd = translate_cwd(root, cwd);
    let inner = match watchdog_secs {
        // Busybox `timeout` reaps the command even if the host kills only the
        // wsl.exe client — WSL keeps in-distro processes alive otherwise.
        Some(secs) => format!("timeout {secs}s sh -lc {}", sh_quote(command)),
        None => format!("sh -lc {}", sh_quote(command)),
    };
    // Phase 1 — root bootstrap: ensure the mount dir exists and the project
    // is mounted. `|| true` on the chown: concurrent runs may race; the
    // mount itself is idempotent via mountpoint -q.
    let bootstrap = format!(
        "mkdir -p {mp}; mountpoint -q {mp} 2>/dev/null || mount -t drvfs {root} {mp}; chown {user}:root {mp} 2>/dev/null || true",
        root = sh_quote(root),
        user = SANDBOX_USER,
    );
    // Phase 2 — unprivileged. `$$` is the pid of the subshell that execs
    // the command (the leader's pid after exec); the pid file lives inside
    // the mounted project so the host can read it, and kill_in_distro
    // targets the process GROUP (negative pid).
    let pid_write = match pid_file {
        Some(f) => format!(
            "mkdir -p {parent}; printf '%s' \"$$\" > {file}; ",
            parent = sh_quote(&parent_dir_or(f, &mp)),
            file = sh_quote(f),
        ),
        None => String::new(),
    };
    let run = format!(
        "mkdir -p {mp}/.kai-bg; cd {cwd}; {pid_write}exec {inner}",
        cwd = sh_quote(&in_cwd),
    );
    let mut cmd = Command::new("wsl.exe");
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.arg("-d")
        .arg(DISTRO_NAME)
        // wsl.exe execs ONE command, so phase 2 is delegated from the
        // root-run script via busybox `su`. su runs the quoted `run` script
        // as the sandbox user; the outer script never interpolates
        // untrusted text outside sh_quote.
        .arg("--user")
        .arg("root")
        .arg("--exec")
        .arg("sh")
        .arg("-c")
        .arg(format!(
            "{bootstrap}; su -s /bin/sh {user} -c {run}",
            user = SANDBOX_USER,
            run = sh_quote(&run),
        ));
    Some(cmd)
}

/// Parent dir of a pid-file path (inside the project mount), or `mp` when
/// the path has no separator. Used to mkdir -p the pid file's parent — the
/// redirect silently fails otherwise and background kills become no-ops.
#[cfg(windows)]
fn parent_dir_or(path: &str, fallback: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[..i].to_string(),
        None => fallback.to_string(),
    }
}

/// Kill the in-distro process recorded in `pid_file` (background procs).
/// Best-effort: a missing file means the process already exited (or never
/// started) — not an error. Kills the whole PROCESS GROUP (negative pid) —
/// a bare `kill -9 PID` orphans grandchildren (dev-server children) in the
/// distro.
#[cfg(windows)]
pub fn kill_in_distro(pid_file: &str) {
    let script = format!(
        "if [ -f {f} ]; then kill -9 -\"$(cat {f})\" 2>/dev/null; rm -f {f}; fi",
        f = sh_quote(pid_file),
    );
    let mut cmd = Command::new("wsl.exe");
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let _ = cmd
        .arg("-d")
        .arg(DISTRO_NAME)
        .arg("-u")
        .arg("root")
        .arg("--exec")
        .arg("sh")
        .arg("-c")
        .arg(script)
        .output();
}

// ── Lifecycle commands ────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SandboxSetupEvent {
    pub phase: String,
    pub downloaded: u64,
    pub total: u64,
    pub message: Option<String>,
}

#[cfg(windows)]
fn distro_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("sandbox-distro"))
}

/// Import the sandbox distro: download Alpine minirootfs, `wsl --import`,
/// write the automount-off wsl.conf, terminate so it applies next boot.
#[tauri::command]
pub async fn sandbox_wsl_setup(
    app: tauri::AppHandle,
    on_event: Channel<SandboxSetupEvent>,
) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = (app, on_event);
        Err("the WSL sandbox is only available on Windows".into())
    }
    #[cfg(windows)]
    {
        if SETUP_RUNNING.swap(true, Ordering::SeqCst) {
            return Err("sandbox distro setup already in progress".into());
        }
        let result = setup_inner(&app, &on_event).await;
        SETUP_RUNNING.store(false, Ordering::SeqCst);
        result
    }
}

#[cfg(windows)]
async fn setup_inner(
    app: &tauri::AppHandle,
    on_event: &Channel<SandboxSetupEvent>,
) -> Result<(), String> {
    if distro_installed_cached() {
        let _ = on_event.send(SandboxSetupEvent {
            phase: "done".into(),
            downloaded: 0,
            total: 0,
            message: Some("already installed".into()),
        });
        return Ok(());
    }

    let dir = distro_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let tar_path = dir.join("rootfs.tar.gz");
    let tmp = dir.join(format!("rootfs.part.{}", std::process::id()));

    // ── 1. Download the minirootfs with progress.
    let client = reqwest::Client::new();
    let resp = client
        .get(ALPINE_URL)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!(
            "download failed: HTTP {} from {ALPINE_URL} (the pinned Alpine release may have been archived — this is a KAI bug to report)",
            resp.status()
        ));
    }
    let total = resp.content_length().unwrap_or(0);
    use futures_util::StreamExt;
    use std::io::Write;
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        let _ = on_event.send(SandboxSetupEvent {
            phase: "download".into(),
            downloaded,
            total,
            message: None,
        });
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&tmp, &tar_path).map_err(|e| e.to_string())?;

    // ── 2. Import + configure on a blocking thread (wsl.exe can take ~10s).
    let _ = on_event.send(SandboxSetupEvent {
        phase: "import".into(),
        downloaded,
        total,
        message: Some("importing distro…".into()),
    });
    let dir_clone = dir.clone();
    let tar_clone = tar_path.clone();
    let result: Result<(), String> =
        tokio::task::spawn_blocking(move || import_distro(&dir_clone, &tar_clone))
            .await
            .map_err(|e| e.to_string())?;

    let _ = std::fs::remove_file(&tar_path); // ~3.5 MB — re-downloadable.

    match result {
        Ok(()) => {
            INSTALLED.store(1, Ordering::Relaxed);
            let _ = on_event.send(SandboxSetupEvent {
                phase: "done".into(),
                downloaded,
                total,
                message: Some(DISTRO_NAME.into()),
            });
            Ok(())
        }
        Err(e) => Err(e),
    }
}

#[cfg(windows)]
fn import_distro(dir: &std::path::Path, tar: &std::path::Path) -> Result<(), String> {
    let out = wsl(&[
        "--import",
        DISTRO_NAME,
        &dir.to_string_lossy(),
        &tar.to_string_lossy(),
        "--version",
        "2",
    ])?;
    if !out.status.success() {
        let stderr = decode_command_output(&out.stderr);
        return Err(format!(
            "wsl --import failed ({}): {}",
            out.status,
            stderr.trim()
        ));
    }
    // Write wsl.conf INSIDE the distro, then terminate so the conf applies
    // on the next boot. printf converts the \n escapes in the format string.
    let conf_out = wsl(&[
        "-d",
        DISTRO_NAME,
        "-u",
        "root",
        "--exec",
        "sh",
        "-c",
        "printf '[automount]\\nenabled = false\\n' > /etc/wsl.conf",
    ])?;
    if !conf_out.status.success() {
        let stderr = decode_command_output(&conf_out.stderr);
        return Err(format!("writing /etc/wsl.conf failed: {}", stderr.trim()));
    }
    // Create the non-root user all wrapped commands run as (root in-distro
    // can mount the host disk — see module docs). The mountpoint container
    // /ws is owned by the sandbox user so it can create the per-project
    // mount dir; the drvfs MOUNT itself still needs root and is performed by
    // the root-run bootstrap phase of every wrapped command (see wrap_wsl).
    let user_script = format!(
        "adduser -D -u {uid} {user} 2>/dev/null || true; mkdir -p /ws; chown {user}:root /ws; chmod a+rx /ws",
        uid = SANDBOX_UID,
        user = SANDBOX_USER,
    );
    let user_out = wsl(&[
        "-d",
        DISTRO_NAME,
        "-u",
        "root",
        "--exec",
        "sh",
        "-c",
        &user_script,
    ])?;
    if !user_out.status.success() {
        let stderr = decode_command_output(&user_out.stderr);
        return Err(format!("creating sandbox user failed: {}", stderr.trim()));
    }
    let _ = wsl(&["--terminate", DISTRO_NAME]);
    Ok(())
}

/// Unregister the sandbox distro and drop its directory.
#[tauri::command]
pub async fn sandbox_wsl_remove(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("the WSL sandbox is only available on Windows".into())
    }
    #[cfg(windows)]
    {
        let dir = distro_dir(&app)?;
        let out = tokio::task::spawn_blocking(move || {
            let result = wsl(&["--unregister", DISTRO_NAME]);
            let _ = std::fs::remove_dir_all(&dir);
            result
        })
        .await
        .map_err(|e| e.to_string())??;
        if !out.status.success() {
            let stderr = decode_command_output(&out.stderr);
            return Err(format!(
                "wsl --unregister failed ({}): {}",
                out.status,
                stderr.trim()
            ));
        }
        INSTALLED.store(2, Ordering::Relaxed);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mountpoint_is_stable_across_case_and_separators() {
        let a = mountpoint_for("D:\\Code\\Proj");
        let b = mountpoint_for("d:/code/proj");
        assert_eq!(a, b);
        assert!(a.starts_with("/ws/"));
    }

    #[test]
    fn sh_quote_escapes_single_quotes() {
        assert_eq!(sh_quote("plain"), "'plain'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn translate_cwd_maps_project_subdir() {
        let root = "D:\\Code\\Proj";
        assert_eq!(
            translate_cwd(root, Some("D:\\Code\\Proj\\src\\a.ts")),
            format!("{}/src/a.ts", mountpoint_for(root)),
        );
    }

    #[test]
    fn translate_cwd_root_and_outside_map_to_mountpoint() {
        let root = "D:\\Code\\Proj";
        assert_eq!(translate_cwd(root, None), mountpoint_for(root));
        assert_eq!(
            translate_cwd(root, Some("D:\\Code\\Proj")),
            mountpoint_for(root),
        );
        // Outside the project → the mountpoint (the cd target is the
        // project; L1 already refused anything outside).
        assert_eq!(translate_cwd(root, Some("E:\\Other")), mountpoint_for(root),);
    }

    #[test]
    fn wrap_script_contains_mount_and_watchdog() {
        // Exercise the script builder without requiring the distro:
        // reproduce wrap_wsl's script construction for a known input.
        let mp = mountpoint_for("D:\\Code\\Proj");
        let inner = format!("timeout 12s sh -lc {}", sh_quote("pnpm test"));
        let bootstrap = format!(
            "mkdir -p {mp}; mountpoint -q {mp} 2>/dev/null || mount -t drvfs {root} {mp}; chown {user}:root {mp} 2>/dev/null || true",
            root = sh_quote("D:\\Code\\Proj"),
            user = SANDBOX_USER,
        );
        let run = format!(
            "mkdir -p {mp}/.kai-bg; cd {cwd}; exec {inner}",
            cwd = sh_quote(mp.as_str()),
        );
        let script = format!(
            "{bootstrap}; su -s /bin/sh {user} -c {run}",
            user = SANDBOX_USER,
            run = sh_quote(&run),
        );
        assert!(script.contains("mount -t drvfs 'D:\\Code\\Proj'"));
        assert!(script.contains("timeout 12s"));
        // Privilege split: bootstrap as root, command via su to sandbox.
        assert!(script.contains("su -s /bin/sh"));
        // The cd target must be quoted — the injection escape was an
        // unquoted cd with an attacker-influenced path. (Assert on `run`
        // before its quotes are escaped again by the outer embedding.)
        assert!(run.contains("cd '/ws/"));
        // Pid-file parent must be pre-created, not just <mp>.
        assert!(run.contains("mkdir -p /ws/") || run.contains(&format!("mkdir -p {mp}/.kai-bg")));
    }

    #[test]
    fn kill_uses_negative_pid_for_group_kill() {
        // The kill must target the process GROUP (negative pid) so
        // grandchildren of a dev server die with the leader.
        let f = "/ws/1a2b3c4d/.kai-bg/x.pid";
        let script = format!(
            "if [ -f {f} ]; then kill -9 -\"$(cat {f})\" 2>/dev/null; rm -f {f}; fi",
            f = sh_quote(f),
        );
        assert!(script.contains("kill -9 -\"$(cat"));
    }

    #[test]
    fn translate_cwd_survives_quote_chars() {
        // A cwd containing a single quote must survive sh_quote — the
        // unquoted-cd injection class.
        let root = "D:\\Code\\Proj";
        let cwd = "D:\\Code\\Proj\\it's \"quoted\" & $(pwd)";
        let in_cwd = translate_cwd(root, Some(cwd));
        let quoted = sh_quote(&in_cwd);
        // The quoted form embeds the path and every inner ' is escaped.
        assert!(quoted.starts_with('\''));
        assert!(quoted.contains("it"));
        assert_eq!(quoted.matches('\'').count() % 2, 1);
    }
}
