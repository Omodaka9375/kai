mod da_filter;
#[cfg(windows)]
mod job;
mod session;
pub(crate) mod shell_init;

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};
use std::thread;

use portable_pty::PtySize;
use tauri::ipc::{Channel, Response};

use crate::modules::lock::{mutex_lock, rwlock_read, rwlock_write};
use crate::modules::workspace::WorkspaceEnv;
use session::Session;

pub struct PtyState {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    // Starts at 1 so freshly-handed-out ids are never 0, which the frontend
    // sometimes treats as "unset". Increments monotonically; never reused.
    next_id: AtomicU32,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_open(
    state: tauri::State<PtyState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    shell: Option<String>,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let (session, _) =
        session::spawn(cols, rows, cwd, workspace, shell, on_data, on_exit).map_err(|e| {
            log::error!("pty_open failed: {e}");
            e
        })?;
    // Wrapping add — after 4 billion opens, wraps to 0. Skip 0 (frontend
    // treats it as "unset") and any id that collides with a live session.
    // Bound at 1024 attempts so a pathological collision storm returns an
    // error instead of spinning forever.
    const ID_ALLOC_BOUND: u32 = 1024;
    let mut id = None;
    for _ in 0..ID_ALLOC_BOUND {
        let candidate = state.next_id.fetch_add(1, Ordering::Relaxed);
        if candidate != 0 && !rwlock_read(&state.sessions).contains_key(&candidate) {
            id = Some(candidate);
            break;
        }
    }
    let id = id.ok_or_else(|| {
        format!("failed to allocate pty id after {ID_ALLOC_BOUND} attempts — too many live sessions?")
    })?;
    rwlock_write(&state.sessions).insert(id, session);
    log::info!("pty opened id={id} cols={cols} rows={rows}");
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyState>, id: u32, data: String) -> Result<(), String> {
    let session = rwlock_read(&state.sessions)
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_write: unknown id={id}");
            "no session".to_string()
        })?;
    // Bind to a local so the MutexGuard temporary drops before `session` —
    // see rustc note on tail-expression temporary drop order.
    let result = mutex_lock(&session.writer)
        .write_all(data.as_bytes())
        .map_err(|e| {
            // EPIPE is expected if the child already exited.
            log::debug!("pty_write id={id} failed: {e}");
            e.to_string()
        });
    result
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = rwlock_read(&state.sessions)
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_resize: unknown id={id}");
            "no session".to_string()
        })?;
    let result = mutex_lock(&session.master)
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            log::warn!("pty_resize id={id} failed: {e}");
            e.to_string()
        });
    result
}

#[tauri::command]
pub fn pty_close(state: tauri::State<PtyState>, id: u32) -> Result<(), String> {
    let session = rwlock_write(&state.sessions).remove(&id);
    if let Some(s) = session {
        if let Err(e) = mutex_lock(&s.killer).kill() {
            // Non-fatal: the child may already have exited on its own (e.g. the
            // user ran `exit`). Log so this isn't invisible during debugging.
            log::debug!("pty_close: kill id={id} returned {e}");
        }
        log::info!("pty closed id={id}");
        // Drop the Arc on a detached thread. On Windows `MasterPty`'s Drop
        // calls `ClosePseudoConsole`, which can block until conhost finishes
        // draining its output buffer. Doing it here would freeze the Tauri
        // worker thread that handled this command — and on Windows that
        // sometimes manifests as the closed pane refusing to disappear from
        // the React tree because subsequent IPC stalls behind it.
        thread::Builder::new()
            .name(format!("KAI-pty-drop-{id}"))
            .spawn(move || {
                let t0 = std::time::Instant::now();
                drop(s);
                log::info!(
                    "pty session id={id} dropped in {}ms",
                    t0.elapsed().as_millis()
                );
            })
            .expect("spawn pty drop thread");
    } else {
        log::debug!("pty_close: unknown id={id}");
    }
    Ok(())
}
