//! Windows Job Object with KILL_ON_JOB_CLOSE for one-shot + background
//! shell children.
//!
//! Killing a wrapper shell (`cmd /C`, `pwsh -EncodedCommand`, `sh -lc`)
//! only terminates that immediate process — any grandchild it spawned
//! (compilers, dev servers, watchers) keeps running and, worse, keeps the
//! stdout/stderr pipe write-ends open so our drain threads never see EOF.
//! Assigning the wrapper to a Job Object and terminating the Job kills the
//! whole tree deterministically.

use std::io;
use std::mem::{size_of, zeroed};

use windows_sys::Win32::Foundation::{CloseHandle, FALSE, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

pub struct KillJob {
    handle: HANDLE,
}

// SAFETY: HANDLE is a pointer-sized value used only from the thread that
// performs kill/terminate; the OS serializes handle operations. Matching
// the pattern already used by `pty::job::PtyJob`.
unsafe impl Send for KillJob {}
unsafe impl Sync for KillJob {}

impl KillJob {
    /// Create a KILL_ON_JOB_CLOSE Job and assign `pid` to it.
    ///
    /// Returns `Ok(None)`-style failure via `io::Result`: callers should
    /// treat any error as "fall back to killing only the direct child" —
    /// most commonly because the parent is already inside a non-nestable
    /// Job (e.g. launched from a CI runner).
    pub fn assign(pid: u32) -> io::Result<Self> {
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

            let process = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, FALSE, pid);
            if process.is_null() {
                let e = io::Error::last_os_error();
                CloseHandle(job);
                return Err(e);
            }

            let assign = AssignProcessToJobObject(job, process);
            CloseHandle(process);
            if assign == 0 {
                let e = io::Error::last_os_error();
                CloseHandle(job);
                return Err(e);
            }

            Ok(Self { handle: job })
        }
    }

    /// Terminate every process in the Job (the wrapper + its descendants).
    pub fn terminate(&self) {
        unsafe {
            TerminateJobObject(self.handle, 1);
        }
    }
}

impl Drop for KillJob {
    fn drop(&mut self) {
        // Closing the handle with KILL_ON_JOB_CLOSE set kills the tree even
        // if the app crashes and Drop for the owning struct never runs.
        if !self.handle.is_null() && self.handle != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.handle) };
        }
    }
}
