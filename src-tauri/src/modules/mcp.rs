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
    let needs_quote = arg.contains([' ', '\t', ',', ';', '=']);
    if !needs_quote {
        return arg.to_string();
    }
    let escaped = arg.replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// NUL-terminated UTF-16 for the W-suffix registry APIs.
#[cfg(target_os = "windows")]
fn utf16z(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Read the `Path` value under `hkey\subkey` as a string. RegGetValueW
/// expands REG_EXPAND_SZ values automatically (RRF_RT_REG_SZ accepts both
/// REG_SZ and the expanded form of REG_EXPAND_SZ), so `%SystemRoot%`-style
/// entries come back expanded. Returns None on any failure — callers fall
/// back to the inherited PATH for that source.
#[cfg(target_os = "windows")]
fn reg_path_value(
    hkey: windows_sys::Win32::System::Registry::HKEY,
    subkey: &str,
) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_SZ};
    let sub = utf16z(subkey);
    let val = utf16z("Path");
    let mut ty: u32 = 0;
    let mut len: u32 = 0;
    // Size probe (pvData = null) then the real read.
    let rc = unsafe {
        RegGetValueW(
            hkey,
            sub.as_ptr(),
            val.as_ptr(),
            RRF_RT_REG_SZ,
            &mut ty,
            std::ptr::null_mut(),
            &mut len,
        )
    };
    if rc != 0 || len < 2 {
        return None;
    }
    let mut buf = vec![0u16; (len / 2) as usize];
    let rc = unsafe {
        RegGetValueW(
            hkey,
            sub.as_ptr(),
            val.as_ptr(),
            RRF_RT_REG_SZ,
            &mut ty,
            buf.as_mut_ptr().cast(),
            &mut len,
        )
    };
    if rc != 0 {
        return None;
    }
    let n = (len / 2) as usize;
    // Strip the trailing NUL if present (len includes it).
    let end = if n > 0 && buf[n - 1] == 0 { n - 1 } else { n };
    Some(String::from_utf16_lossy(&buf[..end]))
}

/// Rebuild the PATH a NORMAL login launch would have, for children KAI
/// spawns when KAI itself was launched with a truncated environment.
///
/// 2026-11-16 (v3.1.x report): a KAI started from the MSI finish page
/// (parent msiexec) — or from any elevated parent — inherits a
/// MACHINE-ONLY PATH: every user-PATH entry is stripped, so MCP servers
/// configured with bare commands (`uvx`, `npx` shims in `~\.local\bin`,
/// Python `Scripts\`, nvm) die at spawn with "Connection closed" even
/// though the binaries exist. The fix mirrors what Explorer does for a
/// normal launch: read the live registry (HKLM machine PATH, then HKCU
/// user PATH) and append the entries missing from the inherited PATH.
/// Current-PATH order is untouched (only additions), failures return the
/// inherited PATH unchanged, and a normally-launched KAI gains nothing
/// (every registry entry is already present, so the set diff is empty).
#[cfg(target_os = "windows")]
fn merged_windows_path() -> String {
    use std::collections::HashSet;
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    fn norm(e: &str) -> String {
        // Windows path lookup is case-insensitive; ignore trailing separator.
        e.trim_end_matches('\\').to_lowercase()
    }

    let current = std::env::var("PATH").unwrap_or_default();
    let mut have: HashSet<String> = current.split(';').map(norm).collect();
    let mut merged = current.clone();
    let mut added = 0usize;

    // Machine first, then user — the same order the OS merges them, so a
    // shadowing entry (same dir in both) keeps its machine position.
    let machine = reg_path_value(
        HKEY_LOCAL_MACHINE,
        "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    );
    let user = reg_path_value(HKEY_CURRENT_USER, "Environment");
    for source in [machine, user].into_iter().flatten() {
        for entry in source.split(';') {
            let key = norm(entry);
            if key.is_empty() || have.contains(&key) {
                continue;
            }
            have.insert(key);
            merged.push(';');
            merged.push_str(entry);
            added += 1;
        }
    }
    if added > 0 {
        log::info!(
            "mcp spawn: inherited PATH was missing {added} registry PATH \
             entries (installer/elevated launch?) — merged them back in"
        );
    }
    merged
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
        // INSTALLER-LAUNCH FIX: cmd.exe inherits KAI's PATH, which for an
        // installer/elevation-launched KAI is machine-only (user entries
        // stripped). Give the resolver the registry-merged PATH instead so
        // bare commands (uvx, npx shims, python Scripts) resolve like they
        // do in a normal login launch. No-op when nothing is missing.
        c.env("PATH", merged_windows_path());
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
                        log::info!(
                            "mcp id={id} stderr: {}",
                            truncate(&trimmed, MAX_STDERR_LINE)
                        );
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
pub fn mcp_stdio_close(state: tauri::State<'_, McpState>, id: u32) -> Result<(), String> {
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
