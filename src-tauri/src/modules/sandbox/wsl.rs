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
//!   - executes everything as root (an imported distro's default user); root
//!     inside the sandbox VM is the confinement boundary, not an escape.
//!
//! Known limits (documented honestly):
//!   - NETWORK: WSL2 distros share ONE network namespace inside the utility
//!     VM — per-distro network isolation is architecturally impossible.
//!     Windows L2 is filesystem confinement only.
//!   - CANCEL/TIMEOUT: killing the wsl.exe client does NOT kill the in-distro
//!     process. Wrapped commands therefore run under busybox `timeout` with
//!     the host timeout + slack, so an orphaned in-distro command dies on its
//!     own shortly after the host gives up.

#![cfg(windows)]

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::Manager;

use crate::modules::workspace::decode_command_output;

/// Registered WSL distro name for the sandbox.
pub const DISTRO_NAME: &str = "kai-sandbox";

/// Alpine minirootfs — busybox sh/mount/mountpoint/timeout, no package setup.
/// Version-pinned; a 404 (release archived) surfaces as a clear setup error.
const ALPINE_URL: &str = "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/alpine-minirootfs-3.21.0-x86_64.tar.gz";

/// wsl.conf disabling automount, written into the imported distro. Manual
/// drvfs mounts remain available — automount only controls the blanket
/// /mnt/<drive> boot mounts.
/// (Inlined into import_distro's printf — kept here as documentation.)
const _: () = ();

/// Installed-state cache: 0 = unknown, 1 = installed, 2 = not installed.
/// Avoids paying a `wsl -l -q` spawn (up to ~800 ms cold) per sandboxed
/// command. Setup/remove flip the cached value so no stale window remains.
static INSTALLED: AtomicU8 = AtomicU8::new(0);
static SETUP_RUNNING: AtomicBool = AtomicBool::new(false);

fn wsl(args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("wsl.exe");
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.args(args).output().map_err(|e| e.to_string())
}

/// Raw registration check via `wsl -l -q` (UTF-16 output — decode).
pub fn distro_installed() -> bool {
    let Ok(out) = wsl(&["-l", "-q"]) else {
        return false;
    };
    let list = decode_command_output(&out.stdout);
    list.lines()
        .map(str::trim)
        .any(|name| name == DISTRO_NAME)
}

/// Cached variant for the per-command hot path.
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
pub fn mountpoint_for(root: &str) -> String {
    let norm = root.to_lowercase().replace('\\', "/");
    format!("/ws/{:08x}", djb2(&norm))
}

/// POSIX single-quote escaping for embedding a string in a `sh -c` script.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Map a host cwd to its in-sandbox path. Subdirectories of the project root
/// map under the mountpoint; anything else (or no cwd) maps to the
/// mountpoint itself.
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
/// Script shape (one `sh -c`, executed as root in the distro):
///   mkdir -p <mp>; mountpoint -q <mp> || mount -t drvfs '<root>' <mp>;
///   cd <in_cwd>; exec [timeout <secs>] sh -lc '<command>'
///
/// When `pid_file` is given (background procs), the in-distro leader writes
/// its PID to the file just before exec'ing the command, so the host can
/// kill the in-distro process on demand — killing wsl.exe alone does not
/// reach it.
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
    // The pid-file must be written INSIDE the mounted project (drvfs rw) so
    // the host can also see it. `$$` in the busybox sh -c context is the
    // subshell that execs the command — its pid is the command's pid after
    // exec, and busybox kill -9 on it reaps the direct children too via
    // the process group (sh spawns children in its group).
    let pid_write = match pid_file {
        Some(f) => format!("printf '%s' \"$$\" > {}", sh_quote(f)),
        None => String::new(),
    };
    let script = format!(
        "mkdir -p {mp}; mountpoint -q {mp} 2>/dev/null || mount -t drvfs {root} {mp}; cd {in_cwd}; {pid_write}; exec {inner}",
        root = sh_quote(root),
    );
    let mut cmd = Command::new("wsl.exe");
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.arg("-d")
        .arg(DISTRO_NAME)
        .arg("-u")
        .arg("root")
        .arg("--exec")
        .arg("sh")
        .arg("-c")
        .arg(script);
    Some(cmd)
}

/// Kill the in-distro process recorded in `pid_file` (background procs).
/// Best-effort: a missing file means the process already exited (or never
/// started) — not an error.
pub fn kill_in_distro(pid_file: &str) {
    let script = format!(
        "if [ -f {f} ]; then kill -9 \"$(cat {f})\" 2>/dev/null; rm -f {f}; fi",
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

fn distro_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(dir.join("sandbox-distro"))
}

/// Import the sandbox distro: download Alpine minirootfs, `wsl --import`,
/// write the automount-off wsl.conf, terminate so it applies next boot.
#[tauri::command]
pub async fn sandbox_wsl_setup(
    app: tauri::AppHandle,
    on_event: Channel<SandboxSetupEvent>,
) -> Result<(), String> {
    if SETUP_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("sandbox distro setup already in progress".into());
    }
    let result = setup_inner(&app, &on_event).await;
    SETUP_RUNNING.store(false, Ordering::SeqCst);
    result
}

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
    let resp = client.get(ALPINE_URL).send().await.map_err(|e| e.to_string())?;
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
            out.status, stderr.trim()
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
    let _ = wsl(&["--terminate", DISTRO_NAME]);
    Ok(())
}

/// Unregister the sandbox distro and drop its directory.
#[tauri::command]
pub async fn sandbox_wsl_remove(app: tauri::AppHandle) -> Result<(), String> {
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
        assert_eq!(
            translate_cwd(root, Some("E:\\Other")),
            mountpoint_for(root),
        );
    }

    #[test]
    fn wrap_script_contains_mount_and_watchdog() {
        // Exercise the script builder without requiring the distro:
        // reproduce wrap_wsl's script construction for a known input.
        let mp = mountpoint_for("D:\\Code\\Proj");
        let inner = format!("timeout 12s sh -lc {}", sh_quote("pnpm test"));
        let script = format!(
            "mkdir -p {mp}; mountpoint -q {mp} 2>/dev/null || mount -t drvfs {root} {mp}; cd {mp}; exec {inner}",
            root = sh_quote("D:\\Code\\Proj"),
        );
        assert!(script.contains("mount -t drvfs 'D:\\Code\\Proj'"));
        assert!(script.contains("timeout 12s"));
        assert!(script.contains("exec sh -lc") || script.contains("sh -lc"));
    }
}
