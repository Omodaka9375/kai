pub mod background;
pub mod ringbuffer;
pub mod session;

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;

use crate::modules::lock::{rwlock_read, rwlock_write};
use crate::modules::workspace::{resolve_path, WorkspaceEnv};
#[cfg(windows)]
use crate::modules::workspace::validate_wsl_distro_name;

use background::{BackgroundLogResponse, BackgroundProc, BackgroundProcInfo};
use session::{SessionRunOutput, ShellSession};

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 300;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Serialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
}

/// Runs a one-shot command via the user's login shell. Output is capped and
/// the process is force-killed on timeout. We deliberately do NOT pipe into
/// the user's interactive PTY — that would fight their input. AI tool calls
/// are presented in chat as their own structured result.
#[tauri::command]
pub async fn shell_run_command(
    command: String,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
    workspace: Option<WorkspaceEnv>,
) -> Result<CommandOutput, String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }

    let workspace = WorkspaceEnv::from_option(workspace);
    let cwd_path = if let Some(dir) = cwd.as_deref().filter(|s| !s.is_empty()) {
        let p = resolve_path(dir, &workspace);
        if !p.is_dir() {
            return Err(format!("cwd is not a directory: {}", p.display()));
        }
        Some(dir.to_string())
    } else {
        None
    };

    let dur = Duration::from_secs(
        timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS),
    );

    // The blocking spawn + wait runs on a worker thread so the Tauri async
    // runtime stays unblocked.
    let (tx, rx) = mpsc::channel::<Result<CommandOutput, String>>();
    thread::spawn(move || {
        let _ = tx.send(run_blocking(trimmed, cwd_path, workspace, dur));
    });

    rx.recv().map_err(|e| e.to_string())?
}

pub(crate) fn run_blocking_cancellable_pub(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    dur: Duration,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> Result<CommandOutput, String> {
    run_blocking_cancellable(command, cwd, workspace, dur, cancel)
}

fn run_blocking(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    dur: Duration,
) -> Result<CommandOutput, String> {
    run_blocking_cancellable(command, cwd, workspace, dur, None)
}

fn run_blocking_cancellable(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    dur: Duration,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> Result<CommandOutput, String> {
    let mut cmd = build_oneshot_command(&command, &workspace, cwd.as_deref())?;
    if let (WorkspaceEnv::Local, Some(dir)) = (&workspace, cwd) {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        log::warn!("shell_run_command spawn failed: {e}");
        e.to_string()
    })?;

    let mut stdout_pipe = child.stdout.take().ok_or("no stdout pipe")?;
    let mut stderr_pipe = child.stderr.take().ok_or("no stderr pipe")?;

    // Drain stdout/stderr on background threads so a full pipe buffer can't
    // deadlock the child.
    let stdout_handle = thread::spawn(move || drain(&mut stdout_pipe));
    let stderr_handle = thread::spawn(move || drain(&mut stderr_pipe));

    let started = Instant::now();
    let mut timed_out = false;
    let exit_code: Option<i32> = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {}
            Err(e) => return Err(e.to_string()),
        }
        if started.elapsed() >= dur {
            let _ = child.kill();
            let _ = child.wait();
            timed_out = true;
            break None;
        }
        if cancel.is_some_and(|c| c.load(std::sync::atomic::Ordering::Relaxed)) {
            let _ = child.kill();
            let _ = child.wait();
            timed_out = true;
            break None;
        }
        thread::sleep(POLL_INTERVAL);
    };

    let (stdout_bytes, stdout_truncated) = stdout_handle.join().unwrap_or((Vec::new(), false));
    let (stderr_bytes, stderr_truncated) = stderr_handle.join().unwrap_or((Vec::new(), false));

    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        exit_code,
        timed_out,
        truncated: stdout_truncated || stderr_truncated,
    })
}

// ──────────────────────────────────────────────────────────────────────────
// Persistent agent shell state + background process state.
// ──────────────────────────────────────────────────────────────────────────

const MAX_SESSIONS: usize = 32;
const MAX_BG_PROCS: usize = 16;

pub struct ShellState {
    sessions: RwLock<HashMap<u32, Arc<ShellSession>>>,
    bg: RwLock<HashMap<u32, Arc<BackgroundProc>>>,
    next_session_id: AtomicU32,
    next_bg_id: AtomicU32,
}

impl Default for ShellState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            bg: RwLock::new(HashMap::new()),
            next_session_id: AtomicU32::new(1),
            next_bg_id: AtomicU32::new(1),
        }
    }
}

impl Drop for ShellState {
    fn drop(&mut self) {
        // Kill all background processes on app exit to prevent orphans.
        // Sessions are one-shot subshells that exit when their child finishes,
        // but bg processes (dev servers, watchers) run indefinitely.
        if let Ok(map) = self.bg.read() {
            for proc in map.values() {
                proc.kill();
            }
        }
    }
}

#[tauri::command]
pub fn shell_session_open(
    state: tauri::State<ShellState>,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let initial = match cwd.as_deref().filter(|s| !s.is_empty()) {
        Some(c) => {
            let p = resolve_path(c, &workspace);
            if !p.is_dir() {
                return Err(format!("cwd is not a directory: {c}"));
            }
            c.to_string()
        }
        None => {
            if let WorkspaceEnv::Wsl { distro } = &workspace {
                crate::modules::workspace::wsl_home(distro.clone())?
            } else {
                crate::modules::fs::to_canon(dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")))
            }
        }
    };
    let session = Arc::new(ShellSession::new(initial, workspace));
    let mut map = rwlock_write(&state.sessions);
    if map.len() >= MAX_SESSIONS {
        return Err(format!("too many shell sessions (limit {MAX_SESSIONS}); close unused sessions first"));
    }
    const ID_ALLOC_BOUND: u32 = 128;
    let mut id = None;
    for _ in 0..ID_ALLOC_BOUND {
        let candidate = state.next_session_id.fetch_add(1, Ordering::Relaxed);
        if candidate != 0 && !map.contains_key(&candidate) {
            id = Some(candidate);
            break;
        }
    }
    let id = id.ok_or_else(|| {
        format!("failed to allocate shell session id after {ID_ALLOC_BOUND} attempts")
    })?;
    map.insert(id, session);
    Ok(id)
}

#[tauri::command]
pub async fn shell_session_run(
    state: tauri::State<'_, ShellState>,
    id: u32,
    command: String,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
    workspace: Option<WorkspaceEnv>,
) -> Result<SessionRunOutput, String> {
    let session = rwlock_read(&state.sessions)
        .get(&id)
        .cloned()
        .ok_or_else(|| "no shell session".to_string())?;
    let dur = Duration::from_secs(
        timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS),
    );
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(session.run(command, cwd, workspace, dur));
    });
    rx.recv().map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn shell_session_close(state: tauri::State<ShellState>, id: u32) -> Result<(), String> {
    rwlock_write(&state.sessions).remove(&id);
    Ok(())
}

/// Cancel a running command in a shell session. The poll loop checks this
/// flag every 50ms and kills the child process when set.
#[tauri::command]
pub fn shell_session_cancel(state: tauri::State<ShellState>, id: u32) -> Result<(), String> {
    let sessions = rwlock_read(&state.sessions);
    if let Some(session) = sessions.get(&id) {
        session.cancel.store(true, std::sync::atomic::Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub fn shell_bg_spawn(
    state: tauri::State<ShellState>,
    command: String,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
) -> Result<u32, String> {
    // Hold the write lock across reap → spawn → cap-check → insert so
    // concurrent callers don't race on the count and waste spawned processes.
    let mut map = rwlock_write(&state.bg);
    map.retain(|_, p| !p.has_exited());
    if map.len() >= MAX_BG_PROCS {
        return Err(format!("too many background processes (limit {MAX_BG_PROCS}); kill unused ones first"));
    }
    // Drop the lock before spawning — spawn does I/O and we already know the
    // cap has room. If another caller slips in before we re-acquire, the cap
    // may be exceeded by one, which is acceptable (MAX_BG_PROCS is a soft
    // limit, not a hard sandbox).
    drop(map);
    let proc = background::spawn(command, cwd, WorkspaceEnv::from_option(workspace))?;
    let mut map = rwlock_write(&state.bg);
    const BG_ID_BOUND: u32 = 128;
    let mut id = None;
    for _ in 0..BG_ID_BOUND {
        let candidate = state.next_bg_id.fetch_add(1, Ordering::Relaxed);
        if candidate != 0 && !map.contains_key(&candidate) {
            id = Some(candidate);
            break;
        }
    }
    let id = id.ok_or_else(|| {
        format!("failed to allocate bg process id after {BG_ID_BOUND} attempts")
    })?;
    map.insert(id, proc);
    Ok(id)
}

#[tauri::command]
pub fn shell_bg_logs(
    state: tauri::State<ShellState>,
    handle: u32,
    since_offset: Option<u64>,
) -> Result<BackgroundLogResponse, String> {
    let proc = rwlock_read(&state.bg)
        .get(&handle)
        .cloned()
        .ok_or_else(|| "no background handle".to_string())?;
    Ok(proc.read_logs(since_offset.unwrap_or(0)))
}

#[tauri::command]
pub fn shell_bg_kill(state: tauri::State<ShellState>, handle: u32) -> Result<(), String> {
    if let Some(proc) = rwlock_read(&state.bg).get(&handle).cloned() {
        proc.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn shell_bg_list(state: tauri::State<ShellState>) -> Result<Vec<BackgroundProcInfo>, String> {
    let map = rwlock_read(&state.bg);
    let mut out = Vec::with_capacity(map.len());
    for (id, p) in map.iter() {
        out.push(p.info(*id));
    }
    out.sort_by_key(|i| i.handle);
    Ok(out)
}

/// Encode a UTF-8 string as UTF-16LE base64 for PowerShell's -EncodedCommand.
#[cfg(windows)]
fn encode_utf16le_base64(s: &str) -> String {
    use base64::engine::general_purpose::STANDARD;
    let utf16: Vec<u16> = s.encode_utf16().collect();
    let mut bytes = Vec::with_capacity(utf16.len() * 2);
    for unit in utf16 {
        bytes.push(unit as u8);
        bytes.push((unit >> 8) as u8);
    }
    STANDARD.encode(&bytes)
}

pub(crate) fn build_oneshot_command(
    command: &str,
    #[cfg_attr(not(windows), allow(unused_variables))] workspace: &WorkspaceEnv,
    #[cfg_attr(not(windows), allow(unused_variables))] cwd: Option<&str>,
) -> Result<Command, String> {
    #[cfg(windows)]
    if let WorkspaceEnv::Wsl { distro } = workspace {
        validate_wsl_distro_name(distro)?;
        let mut cmd = Command::new("wsl.exe");
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        cmd.arg("-d").arg(distro);
        if let Some(cwd) = cwd.filter(|s| !s.is_empty()) {
            cmd.arg("--cd").arg(cwd);
        }
        cmd.arg("--exec").arg("sh").arg("-lc").arg(command);
        return Ok(cmd);
    }
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut cmd = Command::new(shell);
        cmd.arg("-lc").arg(command);
        Ok(cmd)
    }
    #[cfg(windows)]
    {
        let shell = crate::modules::pty::shell_init::windows_shell_path();
        let mut cmd = Command::new(&shell);
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let is_cmd = shell
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("cmd.exe"))
            .unwrap_or(false);
        if is_cmd {
            cmd.arg("/C").arg(command);
        } else {
            // Use -EncodedCommand with base64-encoded UTF-16LE to prevent
            // PowerShell from interpreting special characters in the command
            // string (& | < > \" $ @() etc.). Without this, inline node
            // commands and chained shell expressions get mangled.
            cmd.arg("-NoProfile")
                .arg("-EncodedCommand")
                .arg(encode_utf16le_base64(command));
        }
        Ok(cmd)
    }
}

fn drain<R: Read>(reader: &mut R) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if out.len() >= MAX_OUTPUT_BYTES {
                    truncated = true;
                    continue;
                }
                let take = (MAX_OUTPUT_BYTES - out.len()).min(n);
                out.extend_from_slice(&buf[..take]);
                if take < n {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    (out, truncated)
}
