use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, MasterPty, PtySize};
use tauri::ipc::{Channel, Response};

use super::da_filter::DaFilter;
use super::shell_init;
use crate::modules::lock::mutex_lock;
use crate::modules::workspace::WorkspaceEnv;

const FLUSH_INTERVAL: Duration = Duration::from_millis(4);
const READ_BUF: usize = 16 * 1024;
// Cap on buffered-but-not-yet-flushed bytes. On overflow we discard the
// entire pending buffer and emit an SGR-reset + notice in its place.
// Dropping a partial prefix would slice a CSI sequence in half and corrupt
// xterm's screen state. 4 MiB is ~1000 full 80x24 screens.
const MAX_PENDING: usize = 4 * 1024 * 1024;
// Hard reset (ESC c) + dim notice. Written verbatim into the stream when
// we're forced to discard backlog.
const OVERFLOW_NOTICE: &[u8] =
    b"\x1bc\x1b[2m[KAI: dropped output due to backpressure]\x1b[0m\r\n";

pub struct Session {
    // Field drop order is intentional. Rust drops fields top-to-bottom:
    //   1. `_job` — on Windows, closing the Job HANDLE fires
    //      KILL_ON_JOB_CLOSE, terminating the pwsh tree before the master
    //      pipe drops. Without this, ClosePseudoConsole in `master`'s Drop
    //      can block waiting for conhost to drain pending output, freezing
    //      the Tauri worker thread that triggered the close.
    //   2. `killer` — best-effort kill (redundant on Windows once Job
    //      closed, but harmless and required on Unix where there is no Job).
    //   3. `writer` — closes the input side of the master pipe.
    //   4. `master` — last; ClosePseudoConsole on Windows. By now the child
    //      is dead and conhost has nothing left to drain.
    #[cfg(windows)]
    _job: Option<super::job::PtyJob>,
    pub killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub master: Mutex<Box<dyn MasterPty + Send>>,
}

impl Drop for Session {
    fn drop(&mut self) {
        // If the session Arc is dropped without an explicit pty_close (e.g.
        // frontend disconnected, window crashed, dev HMR), the reader/flusher
        // threads would otherwise stay alive forever holding the child. Kill
        // the child here so the reader hits EOF and the threads unwind.
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }
}
static SPAWN_LOCK: Mutex<()> = Mutex::new(());

const CONPTY_SETTLE_MS: u64 = 50;

/// Tracks the last PTY spawn timestamp to avoid racing ConPTY.
/// Used instead of holding SPAWN_LOCK during the settle sleep.
static LAST_SPAWN_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn spawn(
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    shell: Option<String>,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<(Arc<Session>, PtySize), String> {
    // Serialize concurrent pty_open calls. Without this, rapid sequential
    // ConPTY spawns can leave the second PTY's output pipe stalled (conhost
    // hasn't finished wiring the first session's pipes).
    let _spawn_guard = mutex_lock(&SPAWN_LOCK);

    let pty_system = native_pty_system();
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    let cmd = shell_init::build_command(cwd, workspace, shell)?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    // Release spawn lock before the settle sleep so other PTY operations
    // (resize, write) are never blocked by a concurrent spawn.
    drop(_spawn_guard);

    // ponytail: ConPTY settle — rapid sequential ConPTY spawns can leave the
    // second PTY's output pipe stalled. A lock-free throttle based on last
    // spawn timestamp prevents the race without blocking the whole executor.
    #[cfg(windows)]
    {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let prev = LAST_SPAWN_AT.load(Ordering::Acquire);
        let elapsed = now.saturating_sub(prev);
        if elapsed < CONPTY_SETTLE_MS {
            std::thread::sleep(Duration::from_millis(CONPTY_SETTLE_MS - elapsed));
        }
        LAST_SPAWN_AT.store(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            Ordering::Release,
        );
    }

    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(
        pair.master.take_writer().map_err(|e| e.to_string())?,
    ));

    #[cfg(windows)]
    let job = match child.process_id() {
        Some(pid) => match super::job::PtyJob::create_for(pid) {
            Ok(j) => Some(j),
            Err(e) => {
                log::warn!("pty job-object setup failed for pid={pid}: {e}");
                None
            }
        },
        None => None,
    };

    let session = Arc::new(Session {
        #[cfg(windows)]
        _job: job,
        killer: Mutex::new(killer),
        writer: writer.clone(),
        master: Mutex::new(pair.master),
    });

    let pending: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::with_capacity(READ_BUF)));
    let done = Arc::new(AtomicBool::new(false));
    let spawn_at = Instant::now();

    let pending_r = pending.clone();
    let writer_for_da = writer.clone();
    let reader_thread = thread::Builder::new()
        .name("KAI-pty-reader".into())
        .spawn(move || {
            let mut buf = [0u8; READ_BUF];
            let mut filtered: Vec<u8> = Vec::with_capacity(READ_BUF);
            let mut da_filter = DaFilter::new();
            let mut dropped_bytes: u64 = 0;
            let mut logged_first = false;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if !logged_first {
                            logged_first = true;
                            log::info!("pty first byte after {}ms", spawn_at.elapsed().as_millis());
                        }
                        filtered.clear();
                        da_filter.process(&buf[..n], &mut filtered, |reply| {
                            if let Ok(mut w) = writer_for_da.lock() {
                                let _ = w.write_all(reply);
                            }
                        });
                        if filtered.is_empty() {
                            continue;
                        }
                        let mut g = mutex_lock(&pending_r);
                        if g.len() + filtered.len() > MAX_PENDING {
                            dropped_bytes += g.len() as u64;
                            g.clear();
                            g.extend_from_slice(OVERFLOW_NOTICE);
                        }
                        g.extend_from_slice(&filtered);
                    }
                    Err(e) => {
                        log::debug!("pty reader ended: {e}");
                        break;
                    }
                }
            }
            if dropped_bytes > 0 {
                log::warn!("pty backpressure: dropped {dropped_bytes} bytes (cap {MAX_PENDING})");
            }
        })
        .map_err(|e| format!("spawn pty reader thread: {e}"))?;

    let on_data_flush = on_data.clone();
    let pending_f = pending.clone();
    let done_f = done.clone();
    let flusher_thread = thread::Builder::new()
        .name("KAI-pty-flusher".into())
        .spawn(move || loop {
            thread::sleep(FLUSH_INTERVAL);
            let chunk = {
                let mut g = mutex_lock(&pending_f);
                if g.is_empty() {
                    if done_f.load(Ordering::Acquire) {
                        break;
                    }
                    continue;
                }
                std::mem::take(&mut *g)
            };
            if let Err(e) = on_data_flush.send(Response::new(chunk)) {
                log::debug!("pty flusher exiting, channel closed: {e}");
                break;
            }
        })
        .map_err(|e| format!("spawn pty flusher thread: {e}"))?;

    let on_data_exit = on_data;
    let pending_e = pending;
    let done_e = done;
    thread::Builder::new()
        .name("KAI-pty-waiter".into())
        .spawn(move || {
            let code = match child.wait() {
                Ok(status) => {
                    let c = status.exit_code() as i32;
                    log::info!("pty child exited with code={c} after {}ms", spawn_at.elapsed().as_millis());
                    c
                }
                Err(e) => {
                    log::warn!("pty child wait failed: {e}");
                    -1
                }
            };
            // Wait for the reader to hit EOF before taking a final snapshot of
            // `pending`, so the last line of output never races the Exit event.
            #[cfg(windows)]
            {
                // On Windows, ConPTY's ClosePseudoConsole (inside the reader's
                // EOF path) can occasionally block for hundreds of ms. We spin
                // with a generous deadline first, then fall back to a full join
                // so we never silently drop the reader thread or final output.
                let deadline = Instant::now() + Duration::from_millis(500);
                while Instant::now() < deadline && !reader_thread.is_finished() {
                    thread::sleep(Duration::from_millis(5));
                }
                if reader_thread.is_finished() {
                    let _ = reader_thread.join();
                } else {
                    log::warn!("pty reader thread still alive after 500ms; joining (may block)");
                    if let Err(e) = reader_thread.join() {
                        log::error!("pty reader thread panicked: {e:?}");
                    }
                }
            }
            #[cfg(not(windows))]
            if let Err(e) = reader_thread.join() {
                log::error!("pty reader thread panicked: {e:?}");
            }
            // Join the flusher so panics are observed (the flusher exits
            // when `done` is set to true after the reader finishes).
            if let Err(e) = flusher_thread.join() {
                log::error!("pty flusher thread panicked: {e:?}");
            }
            let tail = std::mem::take(&mut *mutex_lock(&pending_e));
            if !tail.is_empty() {
                if let Err(e) = on_data_exit.send(Response::new(tail)) {
                    log::debug!("pty final-data send failed (channel closed): {e}");
                }
            }
            done_e.store(true, Ordering::Release);
            if let Err(e) = on_exit.send(code) {
                log::debug!("pty exit send failed (channel closed): {e}");
            }
        })
        .map_err(|e| format!("spawn pty waiter thread: {e}"))?;

    Ok((session, size))
}
