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
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PRIORITY_CLASS,
};
use windows_sys::Win32::System::Threading::{
    BELOW_NORMAL_PRIORITY_CLASS, OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
};

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
            info.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_PRIORITY_CLASS;
            // CPU-YIELD (2026-11-04 report: "some commands halt the whole app
            // like pnpm exec / vitest - project switching still lags"):
            // agent-run commands (builds, tests, package managers) spawn
            // multi-core child trees that saturate every logical core at
            // NORMAL priority. At equal priority the scheduler splits CPU
            // evenly between that tree and KAI's webview renderer + UI
            // thread + IPC runtime, so the whole app - input, paint, project
            // switching - starves for the length of the run. BELOW_NORMAL
            // makes the whole child tree (pwsh -> pnpm -> node -> vitest
            // workers, cargo, tsc) yield to the app ONLY under contention;
            // on an idle machine it still gets full CPU, so build/test
            // durations are unaffected. The user's own PTY children are NOT
            // in this job and keep normal priority.
            info.BasicLimitInformation.PriorityClass = BELOW_NORMAL_PRIORITY_CLASS;
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use windows_sys::Win32::System::Threading::{
        GetPriorityClass, NORMAL_PRIORITY_CLASS,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// CPU-YIELD behavioral pin (2026-11-04): a process assigned to the
    /// KillJob must actually run BELOW normal priority — the whole point of
    /// the change. Spawns a real child, assigns it, then queries the OS for
    /// its effective priority class. Without JOB_OBJECT_LIMIT_PRIORITY_CLASS
    /// in the job limits, the child stays NORMAL and this fails.
    #[test]
    fn assigned_children_run_below_normal_priority() {
        let mut child = Command::new("cmd")
            .args(["/C", "ping -n 8 -w 1000 127.0.0.1 > nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn cmd");
        let job = KillJob::assign(child.id()).expect("assign job");
        // Give the OS a beat to apply the job's priority class.
        std::thread::sleep(std::time::Duration::from_millis(300));
        let handle =
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, child.id()) };
        assert!(
            !handle.is_null() && handle != INVALID_HANDLE_VALUE,
            "open child process"
        );
        let class = unsafe { GetPriorityClass(handle) };
        unsafe { CloseHandle(handle) };
        let _ = child.kill();
        let _ = child.wait();
        drop(job);
        assert_ne!(
            class, 0,
            "GetPriorityClass failed: {}",
            io::Error::last_os_error()
        );
        assert_eq!(
            class,
            BELOW_NORMAL_PRIORITY_CLASS,
            "child must be BELOW_NORMAL (got {class}; NORMAL = {NORMAL_PRIORITY_CLASS})"
        );
    }
}
