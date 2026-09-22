//! Custom update-install command.
//!
//! `tauri-plugin-updater`'s built-in flow launches the Windows installer
//! from THIS process and then calls `std::process::exit(0)`. Since v1.3.6
//! KAI assigns itself to a process-wide Job Object with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (the conhost backstop, see
//! `pty::job`). The installer inherits that job, so the exit killed the
//! installer before it wrote a single file — the 1.3.6→1.3.7 in-app
//! update died silently (exe and registry untouched, no crash logs).
//!
//! The plugin's `Builder` doesn't expose `on_before_exit` (that hook lives
//! on `UpdaterBuilder`, which the JS-side flow constructs internally), so
//! we rebuild the updater ourselves with the hook attached and expose one
//! command: `update_install`. The frontend calls it instead of
//! `update.downloadAndInstall` when the plugin's resource API can't reach
//! the hook. It performs the same download → verify → install steps as
//! `download_and_install`, plus the disarm.

use tauri::ipc::Channel;
use tauri_plugin_updater::Update;

#[derive(serde::Serialize, Clone)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    #[serde(rename_all = "camelCase")]
    Finished,
}

/// Download, verify, and install an update the JS side already checked via
/// the plugin's `check` command (the update travels through the plugin's
/// resources table, so signatures/URLs stay plugin-managed).
///
/// On Windows the install path spawns the installer and exits; the
/// `on_before_exit` hook disarms the process-wide kill-on-close job first
/// so the installer survives. On macOS/Linux the hook is a no-op and
/// behavior matches the plugin's `download_and_install`.
#[tauri::command]
pub async fn update_install(
    app: tauri::AppHandle,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    // Rebuild the updater with our hook, then re-check to obtain a fresh
    // `Update` bound to it. The plugin's JS `check` result is not reusable
    // across Rust-side builders (its Update lives in the JS resources
    // table with its own on_before_exit already baked in — cleanup only).
    let updater = app
        .updater_builder()
        .on_before_exit(|| {
            #[cfg(target_os = "windows")]
            crate::modules::pty::job::clear_kill_on_close();
        })
        .build()
        .map_err(|e| e.to_string())?;

    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no update available".to_string())?;

    let update: Update = update;
    let mut first_chunk = true;
    update
        .download_and_install(
            |chunk_length, content_length| {
                if first_chunk {
                    first_chunk = false;
                    let _ = on_event.send(DownloadEvent::Started { content_length });
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}