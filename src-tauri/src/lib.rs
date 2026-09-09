mod modules;

use modules::lock::mutex_lock;
use modules::{diagnostics, fs, git, gpg, mcp, net, pty, secrets, shell, whisper, workspace};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::StateFlags;

/// Grant MICROPHONE (and CAMERA) permissions on a WebView2 webview.
///
/// wry's built-in `PermissionRequested` handler only auto-approves
/// `CLIPBOARD_READ`; every other permission (including microphone, which
/// `navigator.mediaDevices.getUserMedia` needs for voice dictation) is left
/// denied. Register an additional handler here that explicitly allows
/// MICROPHONE / CAMERA so in-app dictation works on the packaged app.
#[cfg(target_os = "windows")]
fn grant_media_permissions(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    let _ = window.with_webview(move |webview| {
        let controller = webview.controller();
        // SAFETY: these calls happen on the main thread that owns the webview,
        // matching WebView2's COM apartment requirements.
        unsafe {
            let Ok(core) = controller.CoreWebView2() else {
                return;
            };
            // Keep `token` alive for the lifetime of `core` (the handler is
            // only invoked synchronously by us; registration outlives the
            // webview because WebView2 owns the handler).
            let mut token = Default::default();
            let _ = core.add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                        let _ = args.PermissionKind(&mut kind);
                        if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                            || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                        {
                            let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                        }
                    }
                    Ok(())
                })),
                &mut token,
            );
        }
    });
}

/// Drained on first read so HMR / re-mounts can't replay the launch dir.
#[derive(Default)]
struct LaunchDir(Mutex<Option<String>>);

/// Identifies this process instance for per-instance isolation of otherwise-
/// shared app resources (log file, crash snapshots). Two KAI processes running
/// on different projects must not trample each other's logs/crash dumps.
#[derive(Clone)]
pub struct InstanceId(pub String);

/// Window-state filename keyed by launch project (`null`/no-arg → shared).
fn lib_state_filename(launch_dir: Option<&str>) -> String {
    match launch_dir {
        Some(dir) => format!(".window-state-{}.json", project_key(dir)),
        None => ".window-state.json".to_string(),
    }
}

/// Per-instance WebView2 user-data directory. Two KAI processes must not share
/// the WebView2 browser-process user-data folder (it holds a singleton lock on
/// startup — sharing it can yield a blank window or a failed second launch).
fn webview_data_dir(app: &tauri::AppHandle, instance_id: &str) -> PathBuf {
    webview_data_root(app).join(instance_id)
}

/// The container holding every per-PID WebView2 profile dir.
fn webview_data_root(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("webview2")
}

/// True when a process with `pid` is still alive. Used to GC only profiles of
/// dead instances (a live sibling's profile has it held open / locks files, so
/// removing it would fail or corrupt it).
#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // SAFETY: `kill(pid, 0)` performs an existence check only — it sends no
    // signal and never terminates anything.
    let res = unsafe { libc::kill(pid as libc::pid_t, 0) };
    res == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(target_os = "windows")]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // SAFETY: `handle` is validated before use and closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE as u32
    }
}

/// Best-effort GC of stale per-PID WebView2 profiles left by previous KAI
/// launches. Removes only directories named after a PID whose process is gone;
/// a live instance's profile is always skipped (and also holds file locks that
/// would make removal fail anyway on Windows).
fn gc_stale_webview_profiles(root: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let current = std::process::id();
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if pid == current || pid_alive(pid) {
            continue;
        }
        let _ = std::fs::remove_dir_all(entry.path());
    }
}

#[tauri::command]
fn get_launch_dir(state: State<'_, LaunchDir>) -> Option<String> {
    mutex_lock(&state.0).take()
}

fn parse_launch_dir() -> Option<String> {
    for arg in std::env::args().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        let Ok(canon) = std::fs::canonicalize(&arg) else { continue };
        if !canon.is_dir() {
            continue;
        }
        let s = canon.to_string_lossy();
        return Some(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string());
    }
    None
}

/// Stable 64-bit FNV-1a (base36) of a workspace path — mirrors the frontend
/// `projectKey()` in `src/modules/ai/lib/sessions.ts` (UTF-16 code units,
/// lowercased), so project-scoped files share one keying scheme across
/// subsystems. The lowercase keeps `D:/Code/KAI` and `d:/code/kai` (the same
/// project on a case-insensitive filesystem) on the same key.
fn project_key(root: &str) -> String {
    let norm = root.replace('\\', "/");
    let norm = norm.trim_end_matches('/').to_lowercase();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for code in norm.encode_utf16() {
        hash ^= code as u64;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }

    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut n = hash;
    if n == 0 {
        return "0".to_string();
    }
    let mut out = Vec::with_capacity(13);
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    // SAFETY: DIGITS is ASCII, so the output is valid UTF-8.
    String::from_utf8(out).expect("base36 of ASCII digits is valid UTF-8")
}

#[tauri::command]
async fn open_settings_window(app: tauri::AppHandle, tab: Option<String>) -> Result<(), String> {
    let url_path = match tab.as_deref() {
        Some(t) if !t.is_empty() => format!("settings.html?tab={}", t),
        _ => "settings.html".to_string(),
    };

    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.set_focus();
        if let Some(t) = tab.as_deref().filter(|s| !s.is_empty()) {
            // emit() serializes via JSON — no string-escape footgun, unlike
            // eval() with format!(). Frontend listens via Tauri event API.
            let _ = window.emit("KAI:settings-tab", t);
        }
        return Ok(());
    }

    let instance_id = app.state::<InstanceId>().0.clone();
    let mut builder = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App(url_path.into()))
        .title("Settings")
        .inner_size(860.0, 640.0)
        .min_inner_size(720.0, 520.0)
        .resizable(true)
        .visible(false)
        .shadow(false)
        .data_directory(webview_data_dir(&app, &instance_id));

    // Tie lifecycle to the main window so settings minimizes/closes with it.
    if let Some(main) = app.get_webview_window("main") {
        builder = builder.parent(&main).map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    // On Linux/Windows we render our own titlebar, so drop native chrome
    // and make the window transparent.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let builder = builder.decorations(false).transparent(true);

    let window = builder.build().map_err(|e| e.to_string())?;

    // Grant microphone/camera access on the settings webview too (WebView2
    // denies media by default — only clipboard is auto-approved by wry).
    #[cfg(target_os = "windows")]
    grant_media_permissions(&window);

    // Some Linux compositors (GNOME/Mutter with CSD-by-default) ignore the
    // builder-time decorations flag — re-assert it after realize.
    #[cfg(target_os = "linux")]
    {
        let _ = window.set_decorations(false);
    }
    let _ = window;
    Ok(())
}

#[tauri::command]
async fn pick_project_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .pick_folder(move |p| {
            let _ = tx.send(p.map(|pb| pb.to_string().replace("\\", "/")));
        });
    rx.await.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Distinguish concurrent instances so their mutable app-global artifacts
    // (log rotation, crash snapshots) never collide.
    let instance_id = format!("{}", std::process::id());
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        // Skip restoring VISIBLE — frontend calls window.show() after first
        // paint so the user never sees a transparent window-shadow flash on
        // Windows/Linux.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                // Key window geometry per project so two instances on different
                // projects don't fight over one last-closer-wins state file.
                // Same keyspace as the frontend sessions scoping.
                .with_filename(lib_state_filename(parse_launch_dir().as_deref()))
                .build(),
        )
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                .max_file_size(2_000_000)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some(format!("kai-{instance_id}")),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            // Build the main window manually so we control the WebView2 user-data
            // dir (per-instance, in setup where we can compute the instance id).
            // The app has no `create: true` windows — otherwise Tauri would have
            // already built them against the shared default data dir before this
            // hook ran, locking the second instance out of a fresh profile.
            let main_config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .expect("main window config missing");
            let data_dir = webview_data_dir(&app.handle().clone(), &instance_id);
            let handle = app.handle().clone();
            // Reap orphaned profiles from prior launches before starting this
            // one (skips live sibling processes).
            gc_stale_webview_profiles(&webview_data_root(&handle));
            let window = WebviewWindowBuilder::from_config(&handle, &main_config)
                .and_then(|b| b.data_directory(data_dir).build())
                .map_err(|e| format!("failed to build main window: {e}"))?;

            // Grant microphone/camera access on WebView2 (media is denied by
            // default — only clipboard is auto-approved by wry).
            #[cfg(target_os = "windows")]
            grant_media_permissions(&window);
            // `window` is otherwise only consumed by the Windows-only grant
            // above; keep the binding live on every platform.
            #[cfg(not(target_os = "windows"))]
            let _ = &window;

            // Resolve the log dir once and install the crash-snapshot panic
            // hook + record the dir for diagnostics_collect.
            let log_dir = app
                .path()
                .app_log_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            let _ = std::fs::create_dir_all(&log_dir);
            diagnostics::install_panic_hook(log_dir.clone(), instance_id.clone());
            app.manage(diagnostics::CrashDir(Mutex::new(Some(log_dir))));
            app.manage(InstanceId(instance_id.clone()));
            Ok(())
        })
        .manage(pty::PtyState::default())
        .manage(shell::ShellState::default())
        .manage(secrets::SecretsState::default())
        .manage({
            let registry = workspace::WorkspaceRegistry::default();
            workspace::bootstrap_registry(&registry);
            registry
        })
        .manage(mcp::McpState::default())
        .manage(whisper::WhisperManager::default())
        .manage(LaunchDir(Mutex::new(parse_launch_dir())))
        .invoke_handler(tauri::generate_handler![
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            fs::tree::list_subdirs,
            fs::tree::fs_read_dir,
            fs::file::fs_read_changelog,
            fs::file::fs_read_file,
            fs::file::fs_write_file,
            fs::file::fs_stat,
            fs::file::fs_read_file_bytes,
            fs::file::fs_write_file_bytes,
            fs::file::fs_canonicalize,
            fs::mutate::fs_create_file,
            fs::mutate::fs_create_dir,
            fs::mutate::fs_rename,
            fs::mutate::fs_delete,
            fs::search::fs_search,
            fs::search::fs_list_files,
            fs::grep::fs_grep,
            fs::grep::fs_glob,
            git::commands::git_resolve_repo,
            git::commands::git_panel_snapshot,
            git::commands::git_status,
            git::commands::git_diff,
            git::commands::git_diff_content,
            git::commands::git_stage,
            git::commands::git_unstage,
            git::commands::git_discard,
            git::commands::git_stash_list,
            git::commands::git_stash_push,
            git::commands::git_stash_pop,
            git::commands::git_stash_apply,
            git::commands::git_stash_drop,
            git::commands::git_commit,
            git::commands::git_fetch,
            git::commands::git_pull_ff_only,
            git::commands::git_pull,
            git::commands::git_push,
            git::commands::git_log,
            git::commands::git_show_commit,
            git::commands::git_commit_files,
            git::commands::git_commit_file_diff,
            git::commands::git_remote_url,
            git::commands::git_config_get,
            git::commands::git_config_set,
            git::commands::git_config_unset,
            gpg::gpg_status,
            gpg::gpg_list_keys,
            gpg::gpg_export_public,
            shell::shell_run_command,
            shell::shell_run_elevated,
            shell::shell_session_open,
            shell::shell_session_run,
            shell::shell_session_close,
            shell::shell_session_cancel,
            shell::shell_bg_spawn,
            shell::shell_bg_logs,
            shell::shell_bg_kill,
            shell::shell_bg_reap,
            shell::shell_bg_list,
            workspace::wsl_list_distros,
            workspace::wsl_default_distro,
            workspace::wsl_home,
            workspace::workspace_authorize,
            workspace::workspace_current_dir,
            diagnostics::diagnostics_collect,
            get_launch_dir,
            open_settings_window,
            pick_project_folder,
            secrets::secrets_get,
            secrets::secrets_set,
            secrets::secrets_delete,
            secrets::secrets_get_all,
            mcp::mcp_stdio_open,
            mcp::mcp_stdio_send,
            mcp::mcp_stdio_close,
            net::lm_ping,
            net::lm_list_models,
            net::openrouter_list_models,
            net::ai_http_request,
            net::ai_http_stream,
            whisper::whisper_model_status,
            whisper::whisper_download_model,
            whisper::whisper_cancel_download,
            whisper::whisper_delete_model,
            whisper::whisper_transcribe,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::project_key;

    #[test]
    fn project_key_matches_frontend_fnv1a_base36() {
        // These expected values are produced by projectKey() in
        // src/modules/ai/lib/sessions.ts (JS BigInt FNV-1a 64, base36, over
        // the lowercased path). The two implementations MUST stay in lockstep
        // or sessions and window-state would target different files.
        assert_eq!(project_key("C:/Users/Valsinarb/dev/project-a"), "2tjl23iqw8hpi");
        assert_eq!(project_key("D:/Code/2026/KAI"), "1jdnajs935bfk");
        assert_eq!(project_key("D:\\Code\\2026\\KAI"), "1jdnajs935bfk");
        assert_eq!(project_key("d:/code/2026/kai"), "1jdnajs935bfk");
        assert_eq!(project_key("/home/user/repo"), "2alyr4jga8r3e");
        assert_eq!(project_key("C:\\Users\\foo\\bar"), "3jdxwoglhxj6e");
    }
}
