use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::RwLock;
use tauri::ipc::Channel;

/// Events streamed back to the frontend for a stdio MCP session.
#[derive(Clone, Serialize)]
#[serde(tag = "kind")]
pub enum McpEvent {
    /// A complete JSON-RPC line read from the child's stdout.
    #[serde(rename = "message")]
    Message { data: String },
    /// The child process exited.
    #[serde(rename = "exit")]
    Exit { code: Option<i32> },
    /// An IO error reading from stdout.
    #[serde(rename = "error")]
    Error { message: String },
}

struct McpSession {
    child: Child,
    /// Flag to signal the reader thread to stop.
    _id: u32,
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
        // Build a single command line: command arg1 arg2 ...
        let full = if args.is_empty() {
            command.clone()
        } else {
            format!("{} {}", command, args.join(" "))
        };
        c.args(["/C", &full]);
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
        .stderr(Stdio::null());

    if let Some(ref d) = cwd {
        cmd.current_dir(d);
    }
    if let Some(ref e) = env {
        for (k, v) in e {
            cmd.env(k, v);
        }
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;

    // Take stdout and spawn a reader thread that forwards lines to the channel.
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture stdout".to_string())?;

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(data) => {
                    let trimmed = data.trim().to_string();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let _ = on_message.send(McpEvent::Message { data: trimmed });
                }
                Err(e) => {
                    let _ = on_message.send(McpEvent::Error {
                        message: e.to_string(),
                    });
                    break;
                }
            }
        }
        // stdout closed — child likely exited.
        let _ = on_message.send(McpEvent::Exit { code: None });
    });

    let session = McpSession { child, _id: id };
    state
        .sessions
        .write()
        .expect("McpState lock poisoned")
        .insert(id, session);

    Ok(id)
}

/// Send a JSON-RPC message to a stdio MCP session's stdin.
#[tauri::command]
pub fn mcp_stdio_send(state: tauri::State<'_, McpState>, id: u32, message: String) -> Result<(), String> {
    let mut sessions = state.sessions.write().expect("McpState lock poisoned");
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("no mcp session {id}"))?;
    let stdin = session
        .child
        .stdin
        .as_mut()
        .ok_or_else(|| "stdin not available".to_string())?;
    // MCP stdio protocol: newline-delimited JSON.
    writeln!(stdin, "{message}").map_err(|e| format!("write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
}

/// Close a stdio MCP session, killing the child process.
#[tauri::command]
pub fn mcp_stdio_close(state: tauri::State<'_, McpState>, id: u32) -> Result<(), String> {
    let mut sessions = state.sessions.write().expect("McpState lock poisoned");
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}
