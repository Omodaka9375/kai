use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::Duration;
use tauri::ipc::Channel;

use crate::modules::lock::rwlock_write;

/// Max length of a single stderr line forwarded to the log. Prevents a
/// pathological MCP server from flooding Kai.log with one massive line.
const MAX_STDERR_LINE: usize = 2000;

/// Events streamed back to the frontend for a stdio MCP session.
#[derive(Clone, Serialize)]
#[serde(tag = "kind")]
pub enum McpEvent {
    /// A complete JSON-RPC line read from the child's stdout.
    #[serde(rename = "message")]
    Message { data: String },
    /// A line read from the child's stderr (diagnostics, not JSON-RPC).
    #[serde(rename = "stderr")]
    Stderr { data: String },
    /// The child process exited.
    #[serde(rename = "exit")]
    Exit { code: Option<i32> },
    /// An IO error reading from stdout/stderr.
    #[serde(rename = "error")]
    Error { message: String },
}

struct McpSession {
    stdin: ChildStdin,
    child: Arc<Mutex<Child>>,
    _id: u32,
}

/// Quote a single argument for cmd.exe `/C` command line.
/// Paths containing spaces, commas, semicolons, or `=` are wrapped in
/// double quotes; internal double quotes are escaped as `\"`.
/// This mirrors the quoting logic `Command::new` uses internally, but
/// cmd.exe itself needs the string to be pre-quoted when passed as a
/// single `/C` argument.
#[cfg(target_os = "windows")]
fn quote_cmd_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "\"\"".to_string();
    }
    let needs_quote = arg.contains(|c: char| {
        c == ' ' || c == '\t' || c == ',' || c == ';' || c == '='
    });
    if !needs_quote {
        return arg.to_string();
    }
    let escaped = arg.replace('"', "\\\"");
    format!("\"{escaped}\"")
}

#[derive(Default)]
pub struct McpState {
    sessions: RwLock<HashMap<u32, McpSession>>,
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// Spawn a stdio MCP server child process.
///
/// Returns a session id. Incoming JSON-RPC messages from stdout are streamed
/// through `on_message`. The caller writes to stdin via `mcp_stdio_send`.
#[tauri::command]
pub fn mcp_stdio_open(
    state: tauri::State<'_, McpState>,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    cwd: Option<String>,
    on_message: Channel<McpEvent>,
) -> Result<u32, String> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

    // On Windows, spawn through cmd.exe /C so .cmd/.bat wrappers (npx, etc.)
    // and the full system PATH are resolved correctly. Direct Command::new
    // only finds .exe files.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd.exe");
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        // Build a single command line with each component quoted for cmd.exe.
        // The previous `command arg1 arg2` join misparsed paths with spaces
        // (e.g. `C:\Program Files\nodejs\npx.cmd`) and let `&`/`|`/`>` in
        // arguments act as cmd metacharacters.
        let mut full = quote_cmd_arg(&command);
        for a in &args {
            full.push(' ');
            full.push_str(&quote_cmd_arg(a));
        }
        c.args(["/D", "/S", "/C", &full]);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(&command);
        c.args(&args);
        c
    };

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(ref d) = cwd {
        cmd.current_dir(d);
    }
    if let Some(ref e) = env {
        for (k, v) in e {
            cmd.env(k, v);
        }
    }

    let mut child = cmd.spawn().map_err(|e| {
        log::error!(
            "mcp id={id} spawn failed command={} args={:?}: {e}",
            command,
            args
        );
        format!("spawn failed: {e}")
    })?;
    let pid = child.id();
    log::info!("mcp id={id} pid={pid} command={} args={:?}", command, args);

    // Take all three stdio streams. stdin stays in the session (so the
    // frontend can write JSON-RPC requests); stdout/stderr are consumed by
    // reader threads; the Child handle is shared with a waiter thread that
    // reports the real exit code.
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to capture stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture stderr".to_string())?;

    let child = Arc::new(Mutex::new(child));

    // stdout reader → JSON-RPC messages.
    let stdout_ch = on_message.clone();
    let _ = thread::Builder::new()
        .name("KAI-mcp-stdout".into())
        .spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(data) => {
                        let trimmed = data.trim().to_string();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let _ = stdout_ch.send(McpEvent::Message { data: trimmed });
                    }
                    Err(e) => {
                        let _ = stdout_ch.send(McpEvent::Error {
                            message: format!("stdout read failed: {e}"),
                        });
                        break;
                    }
                }
            }
        });

    // stderr reader → forwarded to frontend + logged for diagnosis.
    let stderr_ch = on_message.clone();
    let _ = thread::Builder::new()
        .name("KAI-mcp-stderr".into())
        .spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(data) => {
                        let trimmed = data.trim().to_string();
                        if trimmed.is_empty() {
                            continue;
                        }
                        log::info!("mcp id={id} stderr: {}", truncate(&trimmed, MAX_STDERR_LINE));
                        let _ = stderr_ch.send(McpEvent::Stderr { data: trimmed });
                    }
                    Err(_) => break,
                }
            }
        });

    // waiter thread → polls the reaped status so the frontend sees the real
    // exit code (not just "stdout closed").
    let exit_ch = on_message.clone();
    let waiter_child = child.clone();
    let _ = thread::Builder::new()
        .name("KAI-mcp-waiter".into())
        .spawn(move || {
            loop {
                let status = {
                    let mut c = match waiter_child.lock() {
                        Ok(c) => c,
                        Err(_) => break,
                    };
                    match c.try_wait() {
                        Ok(Some(status)) => Some(status),
                        Ok(None) => None,
                        Err(_) => None, // already reaped by mcp_stdio_close
                    }
                };
                if let Some(status) = status {
                    let code = status.code();
                    log::info!("mcp id={id} exited code={code:?}");
                    let _ = exit_ch.send(McpEvent::Exit { code });
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        });

    let session = McpSession {
        stdin,
        child,
        _id: id,
    };
    rwlock_write(&state.sessions).insert(id, session);

    Ok(id)
}

/// Send a JSON-RPC message to a stdio MCP session's stdin.
#[tauri::command]
pub fn mcp_stdio_send(
    state: tauri::State<'_, McpState>,
    id: u32,
    message: String,
) -> Result<(), String> {
    let mut sessions = rwlock_write(&state.sessions);
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("no mcp session {id}"))?;
    // MCP stdio protocol: newline-delimited JSON.
    writeln!(session.stdin, "{message}").map_err(|e| format!("write failed: {e}"))?;
    session
        .stdin
        .flush()
        .map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
}

/// Close a stdio MCP session, killing the child process.
#[tauri::command]
pub fn mcp_stdio_close(
    state: tauri::State<'_, McpState>,
    id: u32,
) -> Result<(), String> {
    let mut sessions = rwlock_write(&state.sessions);
    if let Some(session) = sessions.remove(&id) {
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(())
}

fn truncate(s: &str, max: usize) -> &str {
    if s.len() <= max {
        s
    } else {
        // floor_char_boundary avoids panicking when `max` splits a multi-byte
        // char (e.g. €, emoji) — a panic would kill the stderr reader thread.
        &s[..s.floor_char_boundary(max)]
    }
}
