//! Loopback HTTP listener for MCP OAuth 2.1 authorization-code flows
//! (MCP spec, 2025 auth revision).
//!
//! The webview cannot bind TCP ports, so the host (this Rust process) runs
//! the temporary `http://localhost:<port>/callback` endpoint: it accepts the
//! browser redirect, answers with a "you can close this tab" page, and
//! forwards the query parameters (code/state/error) to the frontend via a
//! global Tauri event `Kai://mcp-oauth-callback`.
//!
//! Security notes:
//! - Binds loopback only (`127.0.0.1`), never `0.0.0.0`.
//! - One listener per flow, random port, auto-expires (default 5 min) and is
//!   explicitly cancellable so no port is left dangling.
//! - The frontend validates `state` (unguessable, generated with
//!   `crypto.getRandomValues`) before using `code` — CSRF-safe per RFC 6749
//!   §10.12. This module transports parameters only; it does not trust them.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// How long a listener waits for the browser redirect before giving up.
const DEFAULT_TIMEOUT_SECS: u64 = 300;

#[derive(Default)]
pub struct McpOAuthState {
    /// Cancel flags per live listener. Removing the entry cancels it.
    listeners: Mutex<HashMap<u32, Arc<AtomicBool>>>,
    next_id: AtomicU32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerInfo {
    pub listener_id: u32,
    pub port: u16,
}

#[tauri::command]
pub fn mcp_oauth_start(
    app: AppHandle,
    state: State<'_, McpOAuthState>,
    timeout_secs: Option<u64>,
) -> Result<ListenerInfo, String> {
    // Loopback only — the callback must never be reachable off-machine.
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("bind loopback: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?
        .port();
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("set_nonblocking: {e}"))?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let cancelled = Arc::new(AtomicBool::new(false));
    mutex_lock(&state.listeners).insert(id, cancelled.clone());

    let deadline = Instant::now() + Duration::from_secs(timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS));
    std::thread::Builder::new()
        .name(format!("KAI-mcp-oauth-{id}"))
        .spawn(move || run_listener(app, listener, id, cancelled, deadline))
        .map_err(|e| format!("spawn listener thread: {e}"))?;

    Ok(ListenerInfo { listener_id: id, port })
}

/// Cancel a pending listener. Idempotent — a finished listener is already
/// gone from the map.
#[tauri::command]
pub fn mcp_oauth_cancel(state: State<'_, McpOAuthState>, listener_id: u32) -> Result<(), String> {
    if let Some(flag) = mutex_lock(&state.listeners).remove(&listener_id) {
        flag.store(true, Ordering::Release);
    }
    Ok(())
}

fn mutex_lock(m: &Mutex<HashMap<u32, Arc<AtomicBool>>>) -> std::sync::MutexGuard<'_, HashMap<u32, Arc<AtomicBool>>> {
    // Recover from poisoning like the rest of the codebase — a panicking
    // thread must not break OAuth entirely.
    match m.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn run_listener(
    app: AppHandle,
    listener: TcpListener,
    id: u32,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
) {
    // Always clean our map entry up on exit so `mcp_oauth_cancel` and
    // repeated flows don't accumulate dead flags.
    let _cleanup = scopeguard_like(&app, id);
    loop {
        if cancelled.load(Ordering::Acquire) {
            return;
        }
        if Instant::now() >= deadline {
            emit_callback(&app, id, HashMap::new(), Some("timeout"));
            return;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                match read_request(stream) {
                    Some(query) => {
                        let params = parse_query(&query);
                        let finalizes =
                            params.contains_key("code") || params.contains_key("error");
                        if finalizes {
                            emit_callback(&app, id, params, None);
                            return;
                        }
                        // Prefetches (favicon etc.) — answer and keep waiting.
                    }
                    None => {
                        // Unreadable/garbage request — drop and keep waiting.
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return, // listener is broken; nothing to do
        }
    }
}

/// Runs on scope exit to remove the listener's map entry.
struct CleanupOnDrop<'a> {
    app: &'a AppHandle,
    id: u32,
}

impl Drop for CleanupOnDrop<'_> {
    fn drop(&mut self) {
        if let Some(state) = self.app.try_state::<McpOAuthState>() {
            mutex_lock(&state.listeners).remove(&self.id);
        }
    }
}

fn scopeguard_like<'a>(app: &'a AppHandle, id: u32) -> CleanupOnDrop<'a> {
    CleanupOnDrop { app, id }
}

/// Read one HTTP request off the socket and answer it. Returns the query
/// string (without the leading `?`) of the request target.
fn read_request(mut stream: TcpStream) -> Option<String> {
    // Bounded read: 16 KiB covers any sane callback request with cookies.
    stream.set_read_timeout(Some(Duration::from_millis(1500))).ok();
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).ok()? == 0 {
        respond(&mut stream, 400, "Bad Request");
        return None;
    }
    // Drain headers (bounded) so the browser sees a complete response
    // instead of a connection reset mid-request.
    let mut total = 0usize;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                total += n;
                if line.trim_end().is_empty() || total > 16 * 1024 {
                    break;
                }
            }
        }
    }
    // "GET /callback?code=...&state=... HTTP/1.1"
    let target = request_line.split_whitespace().nth(1)?.to_string();
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), Some(q.to_string())),
        None => (target, None),
    };
    let _ = path;
    respond(
        &mut stream,
        200,
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>KAI</title>\
         <style>body{font:14px system-ui,sans-serif;display:flex;align-items:center;\
         justify-content:center;height:100vh;margin:0;color:#333;background:#fafafa}\
         b{font-size:18px}</style></head><body><div style=\"text-align:center\">\
         <b>KAI connected.</b><br>You can close this tab and return to the app.\
         </div></body></html>",
    );
    query
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        _ => "Not Found",
    };
    let msg = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(msg.as_bytes());
    let _ = stream.flush();
    // Half-close so the browser finishes reading before we drop.
    let _ = stream.shutdown(std::net::Shutdown::Write);
}

/// Minimal `application/x-www-form-urlencoded` parser with percent-decoding.
fn parse_query(query: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        out.insert(percent_decode(k), percent_decode(v));
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = hex_val(bytes[i + 1]);
                let lo = hex_val(bytes[i + 2]);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h << 4) | l);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn emit_callback(
    app: &AppHandle,
    listener_id: u32,
    params: HashMap<String, String>,
    error: Option<&str>,
) {
    let _ = app.emit(
        "Kai://mcp-oauth-callback",
        serde_json::json!({
            "listenerId": listener_id,
            "params": params,
            "error": error,
        }),
    );
}