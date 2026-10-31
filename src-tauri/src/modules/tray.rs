//! System-tray support: minimize-to-tray on window close, real quit from
//! the tray menu.
//!
//! Motivation (2026-10-31): the assistant / long-running agents should stay
//! alive with the KAI window closed — closing the window must NOT kill the
//! process. The tray icon is the escape hatch: right-click → "Quit KAI"
//! exits for real.
//!
//! Design:
//!  - The tray lives for the whole process; created once in setup. It is
//!    deliberately ALWAYS present while KAI runs — the user needs a way to
//!    quit the hidden process even if they never enabled a preference, and
//!    a missing tray turns a hide into an unreachable ghost process.
//!  - "Close → hide" is implemented with the `CloseRequested` guard in the
//!    JS layer (main.tsx): `preventClose()` + `hide()`. The Rust
//!    `on_window_event` handler is a BACKSTOP for windows whose frontend
//!    never loaded (crashed webview, dev server down) — without it the
//!    process would exit and take every running agent down with it while
//!    the user believes KAI keeps running in the tray.
//!  - Quit paths (tray menu item, tray double-click on platforms that map
//!    it, `app.exit(0)`) bypass the guard: they call `app.exit`, which does
//!    not route through CloseRequested.
//!  - First-hide notification: a one-shot toast ("KAI keeps running…")
//!    the first time the window is hidden per process. Prevents the
//!    "where did my app go" moment, says how to reach it again, and how to
//!    truly quit. The settings toggle then controls whether the WINDOW
//!    close hides at all.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

/// Wrapper matching the builder's handler shape: the listener receives
/// (&Window, &WindowEvent); the label is derived here once.
pub fn on_window_close_requested<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::Window<R>,
    api: &tauri::CloseRequestApi,
) {
    on_close_requested_inner(app, window.label(), api)
}

/// One-shot guard for the "KAI keeps running in the tray" toast.
static NOTIFIED_HIDE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Load the tray icon from the bundled default icon set. Falls back to
/// Tauri's embedded window icon if the file is missing (dev checkouts
/// always have it; belt-and-suspenders for unusual layouts).
fn load_tray_icon<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::image::Image<'static>> {
    for rel in ["icons/32x32.png", "icons/icon.png"] {
        if let Ok(path) = app.path().resolve(rel, tauri::path::BaseDirectory::Resource) {
            if let Ok(img) = tauri::image::Image::from_path(&path) {
                return Some(img);
            }
        }
    }
    app.default_window_icon().cloned().map(|i| i.to_owned())
}

/// Create the tray icon + menu. Called once from Builder::setup.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> Result<(), tauri::Error> {
    let show = MenuItem::with_id(app, "show", "Show KAI", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit KAI", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("kai-main")
        .menu(&menu)
        .tooltip("KAI")
        .show_menu_on_left_click(false);
    if let Some(icon) = load_tray_icon(app) {
        builder = builder.icon(icon);
    }

    builder
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "show" => {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.unminimize();
                        let _ = win.set_focus();
                    }
                }
                "quit" => {
                    // True exit: app.exit bypasses the CloseRequested guard,
                    // so the kill-on-close job and every PTY descends with us.
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(())
}

/// Notify once per process when the main window is hidden to the tray.
/// Called from the window-event backstop below. Fire-and-forget: a failed
/// notification must never break the hide.
pub fn notify_hidden_once<R: Runtime>(app: &AppHandle<R>) {
    if NOTIFIED_HIDE.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return; // already shown this process
    }
    let _ = app
        .notification()
        .builder()
        .title("KAI keeps running")
        .body("The window is closed but KAI is still active — agents keep working. Click the tray icon to reopen; right-click → Quit KAI to exit completely.")
        .show();
}

/// Window-event handler installed on the Tauri builder. Intercepts the OS
/// close (titlebar X, taskbar close, Alt+F4) for the MAIN window and hides
/// it instead, keeping the process (and every agent run) alive.
///
/// This is the BACKSTOP for the frontend's onCloseRequested guard — the JS
/// path normally handles this (and shows the first-hide toast via the same
/// notification plugin); this arm catches closes the webview can't answer
/// (crashed page, dev server down, JS exception before the listener
/// installed).
///
/// NOTE: because this handler runs on every `CloseRequested`, the ONLY way
/// the main window's close exits the process is an explicit `app.exit` —
/// i.e. the tray's Quit KAI item. That is the product contract: close =
/// keep running, tray Quit = really quit.
fn on_close_requested_inner<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    api: &tauri::CloseRequestApi,
) {
    if label != "main" {
        return; // settings panels and aux windows close for real
    }
    api.prevent_close();
    if let Some(win) = app.get_webview_window("main") {
        notify_hidden_once(app);
        let _ = win.hide();
    }
}

#[cfg(test)]
#[path = "tray.test-pin.rs"]
mod tray_test_pin;
