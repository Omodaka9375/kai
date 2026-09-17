use std::io::Read;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::SystemTime;

use serde::Serialize;
use shared_child::SharedChild;

use super::ringbuffer::BoundedRingBuffer;
use crate::modules::lock::mutex_lock;
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const RING_CAP: usize = 4 * 1024 * 1024;

pub struct BackgroundProc {
    pub command: String,
    pub cwd: Option<String>,
    pub started_at_ms: u64,
    pub child: Arc<SharedChild>,
    pub buffer: Mutex<BoundedRingBuffer>,
    pub exited: AtomicBool,
    pub exit_code: AtomicI32,
    pub exit_unknown: AtomicBool,
    /// Owning chat session ID — when the session closes, all owned processes
    /// are reaped so parallel agents don't cross-contaminate.
    pub owner: Option<String>,
    /// Human-readable label for listing / status display.
    pub label: Option<String>,
    /// Windows sandbox distro only: in-distro path of the pidfile the
    /// confined leader wrote. kill() reaps the in-distro process through it —
    /// killing the wsl.exe client alone does not reach in-distro processes.
    #[cfg(windows)]
    pub sandbox_pid_file: Option<String>,
    /// Windows only: KILL_ON_JOB_CLOSE Job holding the wrapper shell.
    /// Terminating it reaps the whole tree (see `shell::job`).
    #[cfg(windows)]
    job: Option<super::job::KillJob>,
}

/// Monotonic per-process counter for unique sandbox pidfile names.
#[cfg_attr(not(windows), allow(dead_code))]
fn started_counter() -> u64 {
    static CTR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    CTR.fetch_add(1, Ordering::Relaxed)
}

#[derive(Serialize)]
pub struct BackgroundLogResponse {
    pub bytes: String,
    pub next_offset: u64,
    pub dropped: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

#[derive(Serialize)]
pub struct BackgroundProcInfo {
    pub handle: u32,
    pub command: String,
    pub cwd: Option<String>,
    pub started_at_ms: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub owner: Option<String>,
    pub label: Option<String>,
}

impl BackgroundProc {
    pub fn read_logs(&self, since: u64) -> BackgroundLogResponse {
        let (bytes, next_offset, dropped) = mutex_lock(&self.buffer).read_from(since);
        let exited = self.exited.load(Ordering::Acquire);
        let exit_code = if exited && !self.exit_unknown.load(Ordering::Acquire) {
            Some(self.exit_code.load(Ordering::Acquire))
        } else {
            None
        };
        BackgroundLogResponse {
            bytes: String::from_utf8_lossy(&bytes).into_owned(),
            next_offset,
            dropped,
            exited,
            exit_code,
        }
    }

    pub fn has_exited(&self) -> bool {
        self.exited.load(Ordering::Acquire)
    }

    /// Kill the wrapper shell AND its descendants.
    ///
    /// Killing only the wrapper is not enough: grandchildren (dev servers,
    /// compilers) survive, and because they inherit the stdout/stderr write
    /// ends the drain threads never see EOF — so the ring buffer keeps growing
    /// with output from a process the user believes is stopped.
    pub fn kill(&self) {
        #[cfg(windows)]
        {
            // Sandboxed (WSL distro) procs first: the Job only holds the
            // wsl.exe client — the confined process survives it.
            if let Some(ref pf) = self.sandbox_pid_file {
                crate::modules::sandbox::wsl::kill_in_distro(pf);
            }
            if let Some(ref job) = self.job {
                job.terminate();
            }
        }
        #[cfg(unix)]
        {
            // The child is spawned with `process_group(0)`, so its pid is also
            // its process-group id. Signalling the negated pid reaps the group.
            let pid = self.child.id() as libc::pid_t;
            // SAFETY: negated pid targets only the group this child leads.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
        let _ = self.child.kill();
    }

    pub fn info(&self, handle: u32) -> BackgroundProcInfo {
        let exited = self.exited.load(Ordering::Acquire);
        let exit_code = if exited && !self.exit_unknown.load(Ordering::Acquire) {
            Some(self.exit_code.load(Ordering::Acquire))
        } else {
            None
        };
        BackgroundProcInfo {
            handle,
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            started_at_ms: self.started_at_ms,
            exited,
            exit_code,
            owner: self.owner.clone(),
            label: self.label.clone(),
        }
    }
}

impl Drop for BackgroundProc {
    fn drop(&mut self) {
        self.kill();
    }
}

pub fn spawn(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    owner: Option<String>,
    label: Option<String>,
    sandbox_root: Option<String>,
) -> Result<Arc<BackgroundProc>, String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    #[cfg(windows)]
    let mut sandbox_pid_file: Option<String> = None;
    if let Some(ref dir) = cwd {
        if !resolve_path(dir, &workspace).is_dir() {
            return Err(format!("cwd is not a directory: {dir}"));
        }
    }

    let mut cmd = match sandbox_root.as_deref().filter(|r| !r.is_empty()) {
        Some(root) => {
            // workspaceOnly: OS confinement (Layer 2); falls through to the
            // plain command when the platform runner is unavailable. No
            // watchdog (long-lived by design); instead the in-distro leader
            // writes a pid file under the project mount so kill() can reap
            // it — killing the wsl.exe client alone does not reach it.
            let spec = crate::modules::sandbox::exec::SandboxSpec {
                root: std::path::PathBuf::from(root),
            };
            // In-distro pidfile (under the project mount, drvfs rw). The
            // background record keeps the IN-DISTRO path — kill_in_distro
            // reads it from inside the distro.
            #[cfg(windows)]
            {
                let mp = crate::modules::sandbox::wsl::mountpoint_for(root);
                let pid_name = format!("kai-bg-{}-{}.pid", std::process::id(), started_counter());
                let pid_file = format!("{mp}/.kai-bg/{pid_name}");
                match crate::modules::sandbox::exec::try_wrap(
                    &trimmed,
                    &spec,
                    &workspace,
                    cwd.as_deref(),
                    None,
                    Some(&pid_file),
                )? {
                    Some(wrapped) => {
                        sandbox_pid_file = Some(pid_file);
                        wrapped
                    }
                    None => super::build_oneshot_command(&trimmed, &workspace, cwd.as_deref())?,
                }
            }
            #[cfg(not(windows))]
            {
                match crate::modules::sandbox::exec::try_wrap(
                    &trimmed,
                    &spec,
                    &workspace,
                    cwd.as_deref(),
                    None,
                    None,
                )? {
                    Some(wrapped) => wrapped,
                    None => super::build_oneshot_command(&trimmed, &workspace, cwd.as_deref())?,
                }
            }
        }
        None => super::build_oneshot_command(&trimmed, &workspace, cwd.as_deref())?,
    };
    if let (WorkspaceEnv::Local, Some(ref dir)) = (&workspace, &cwd) {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Give the wrapper its own process group so `kill()` can reap the subtree.
    // `process_group(0)` runs setpgid in the child before exec; if that fails
    // the spawn fails, so a successful spawn guarantees pid == pgid.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        cmd.process_group(0);
    }

    let shared = SharedChild::spawn(&mut cmd).map_err(|e| e.to_string())?;

    // Assign to the Job immediately: any grandchild spawned before assignment
    // would escape it and survive the kill.
    #[cfg(windows)]
    let job = super::job::KillJob::assign(shared.id()).ok();

    let stdout_pipe = shared.take_stdout().ok_or("no stdout pipe")?;
    let stderr_pipe = shared.take_stderr().ok_or("no stderr pipe")?;
    let child = Arc::new(shared);

    let started_at_ms = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let proc = Arc::new(BackgroundProc {
        command: trimmed,
        cwd,
        started_at_ms,
        child,
        buffer: Mutex::new(BoundedRingBuffer::new(RING_CAP)),
        exited: AtomicBool::new(false),
        exit_code: AtomicI32::new(0),
        exit_unknown: AtomicBool::new(false),
        owner,
        label,
        #[cfg(windows)]
        sandbox_pid_file,
        #[cfg(windows)]
        job,
    });

    {
        let proc_ref = proc.clone();
        let mut pipe = stdout_pipe;
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => mutex_lock(&proc_ref.buffer).push(&buf[..n]),
                    Err(_) => break,
                }
            }
        });
    }
    {
        let proc_ref = proc.clone();
        let mut pipe = stderr_pipe;
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => mutex_lock(&proc_ref.buffer).push(&buf[..n]),
                    Err(_) => break,
                }
            }
        });
    }
    {
        let proc_ref = proc.clone();
        let child_for_wait = proc.child.clone();
        thread::spawn(move || {
            match child_for_wait.wait() {
                Ok(status) => match status.code() {
                    Some(code) => proc_ref.exit_code.store(code, Ordering::Release),
                    None => proc_ref.exit_unknown.store(true, Ordering::Release),
                },
                Err(_) => proc_ref.exit_unknown.store(true, Ordering::Release),
            }
            proc_ref.exited.store(true, Ordering::Release);
        });
    }

    Ok(proc)
}
