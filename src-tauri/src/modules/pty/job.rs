//! Windows Job Object with KILL_ON_JOB_CLOSE for ConPTY children.
//! Dropping the handle kills the whole tree — only reliable orphan guard
//! on Windows.

use std::io;
use std::mem::{size_of, zeroed};

use windows_sys::Win32::Foundation::{CloseHandle, FALSE, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

fn new_kill_on_close_job() -> io::Result<HANDLE> {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() || job == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            let e = io::Error::last_os_error();
            CloseHandle(job);
            return Err(e);
        }

        Ok(job)
    }
}

fn assign_to_job(job: HANDLE, pid: u32) -> io::Result<()> {
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, FALSE, pid);
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        let assign = AssignProcessToJobObject(job, process);
        CloseHandle(process);
        if assign == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// Process-wide orphan guard.
///
/// Creates a Job Object with KILL_ON_JOB_CLOSE, assigns THIS process to it,
/// and deliberately leaks the job handle for the process lifetime. Children
/// inherit the job automatically (no per-child assignment, no PID races),
/// so when KAI dies — crash, `panic=abort`, dev Ctrl-C, taskkill /F — the
/// kernel kills every descendant: PTY shells, ConPTY's conhost (which is
/// parented to KAI, NOT to the shell, so the per-session PtyJob never
/// covered it), and one-shot command shells. Without this, each abnormal
/// exit leaked one conhost per open tab (observed: months of accumulation).
///
/// Nested jobs (Win8+) keep the per-session PtyJob working unchanged.
/// If this process was already assigned to a job by its launcher (some
/// IDEs do), assignment fails — log and continue: the per-session jobs
/// still cover the shell trees, only the conhost backstop is lost.
/// The process-wide kill-on-close job, if installed. Held (never closed)
/// for the process lifetime; addressable so the updater can disarm it right
/// before an intentional exit. Raw HANDLE is not Send/Sync — wrap it.
static PROCESS_WIDE_JOB: std::sync::OnceLock<ProcessWideJob> = std::sync::OnceLock::new();

struct ProcessWideJob(HANDLE);
unsafe impl Send for ProcessWideJob {}
unsafe impl Sync for ProcessWideJob {}

/// Disarm KILL_ON_JOB_CLOSE before an intentional update exit.
///
/// tauri-plugin-updater launches the NSIS installer with `ShellExecuteW`
/// FROM THIS PROCESS and then calls `std::process::exit(0)`. The installer
/// inherits this job's membership, so the exit would kill the installer
/// mid-install (observed with 1.3.6→1.3.7: app closes, nothing happens, exe
/// untouched). Clearing the flag lets the installer survive our exit.
/// Per-session PtyJobs keep their own kill-on-close, so shell trees are still
/// reaped; only the conhost backstop is lost for this one exit.
pub fn clear_kill_on_close() {
    let Some(&ProcessWideJob(job)) = PROCESS_WIDE_JOB.get() else {
        return;
    };
    unsafe {
        // LimitFlags = 0 clears kill-on-close — the only flag we ever set.
        let info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            log::warn!(
                "failed to clear kill-on-close before update: {}",
                io::Error::last_os_error()
            );
        } else {
            log::info!("kill-on-close disarmed for update exit");
        }
    }
}

pub fn install_process_wide_kill_on_close() {
    let job = match new_kill_on_close_job() {
        Ok(h) => h,
        Err(e) => {
            log::warn!("process-wide kill-on-close job not created: {e}");
            return;
        }
    };
    if let Err(e) = assign_to_job(job, std::process::id()) {
        log::warn!(
            "process-wide kill-on-close job not assigned to self: {e} \
             (launcher may already job this process)"
        );
        unsafe { CloseHandle(job) };
        return;
    }
    // Intentionally never closed: the handle must stay open for the entire
    // process lifetime. The OS closes it on process death, which is the
    // exact trigger for KILL_ON_JOB_CLOSE. (HANDLE is a raw pointer — no
    // Drop, so nothing to forget; it stays open by not closing it.)
    let _ = PROCESS_WIDE_JOB.set(ProcessWideJob(job));
    log::info!("process-wide kill-on-close job active (pid={})", std::process::id());
}

pub struct PtyJob {
    handle: HANDLE,
}

unsafe impl Send for PtyJob {}
unsafe impl Sync for PtyJob {}

impl PtyJob {
    pub fn create_for(pid: u32) -> io::Result<Self> {
        let job = new_kill_on_close_job()?;
        if let Err(e) = assign_to_job(job, pid) {
            unsafe { CloseHandle(job) };
            return Err(e);
        }
        Ok(Self { handle: job })
    }
}

impl Drop for PtyJob {
    fn drop(&mut self) {
        if !self.handle.is_null() && self.handle != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.handle) };
        }
    }
}
