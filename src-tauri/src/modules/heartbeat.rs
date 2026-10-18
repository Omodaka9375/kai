//! Rust-side 1-second heartbeat for the watch scheduler.
//!
//! WHY THIS EXISTS: the frontend watch system used to drive polls with
//! `setInterval` in the WebView. WebView2 is Chromium — a hidden/minimized
//! (or fully occluded) window gets its page marked invisible and hidden-page
//! timers are intensively throttled: after ~5 minutes, timers wake at most
//! once per minute. A 5s-interval watch on a CI build (the exact moment the
//! user has KAI in the background) silently degraded to one poll per minute
//! or worse — "watches often don't fire". IPC message delivery into the
//! WebView is NOT subject to timer throttling, so the watch scheduler now
//! subscribes to a tick emitted by this thread instead of owning a JS timer.
//!
//! Cost: one thread that sleeps 1s and sends an empty event to each
//! registered channel — negligible, and it only starts once the first watch
//! subscribes (the frontend calls this command lazily on first watch_create).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};

use tauri::ipc::Channel;

static CHANNELS: LazyLock<Mutex<Vec<Channel<()>>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Register a tick channel and (once) start the heartbeat thread. Called by
/// the frontend once per app run, when the first watch is created. Channels
/// whose send fails (webview gone) are dropped INDIVIDUALLY on the next
/// tick — healthy channels are never discarded with them.
#[tauri::command]
pub fn watch_heartbeat(on_tick: Channel<()>) {
    {
        let mut list = crate::modules::lock::mutex_lock(&CHANNELS);
        // Cap registrations: remounts/HMR would otherwise double-fire ticks
        // (harmless — the scheduler is idempotent — but wasteful).
        if list.len() >= 4 {
            list.remove(0);
        }
        list.push(on_tick);
    }
    if !RUNNING.swap(true, Ordering::SeqCst) {
        std::thread::spawn(|| {
            loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
                // Drop ONLY channels whose send fails (their webview is gone).
                // One dead webview used to clear the whole list — including
                // healthy channels — so every live watch stalled until the
                // next watch_create re-registered. Now survivors keep ticking.
                let mut list = crate::modules::lock::mutex_lock(&CHANNELS);
                list.retain(|c| c.send(()).is_ok());
            }
        });
    }
}
