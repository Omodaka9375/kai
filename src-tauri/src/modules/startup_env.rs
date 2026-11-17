//! Windows startup-environment sanitizer.
//!
//! 2026-11-17 user report: "If I reinstall the app in place and it auto
//! restarts, Windows has problems when KAI runs bash commands, tests, etc:
//! module resolution is broken globally for junctioned node_modules (same
//! WinError 448 class). Killing that instance and starting a new one fixes
//! all commands."
//!
//! Root cause (same family as the 2026-11-16 msiexec reports): the NSIS
//! installer's finish page / the updater's auto-restart parents KAI to an
//! ELEVATED process (msiexec.exe or the installer's elevated copy). That
//! parent carries the ProcessRedirectionTrustPolicy mitigation in ENFORCE
//! mode ("Redirection Guard") — inherited by KAI and by EVERY child KAI
//! spawns. ENFORCE mode makes CreateProcess/others refuse to traverse
//! "untrusted mount points" (junctions/symlinks), so pnpm-style junctioned
//! node_modules break with WinError 448 no matter which command runs.
//! A mitigation policy CANNOT be removed from a running process: the only
//! fix is to relaunch under a non-mitigated parent.
//!
//! KILL-ON-CLOSE NOTE: relaunching via ShellExecuteW hands process creation
//! to the SHELL (the same trick tauri-plugin-updater uses for the installer
//! itself), so the new KAI is NOT a child of this process — the process-wide
//! kill-on-close job cannot kill it. We still disarm it before exiting for
//! symmetry with the updater path.

/// Command-line marker the relaunched instance carries. Prevents an
/// infinite relaunch loop if the shell itself were ever mitigated.
/// Windows-only: every consumer is cfg'd to windows.
#[cfg(target_os = "windows")]
const RELAUNCH_ARG: &str = "--kai-relaunched-clean-token";

/// True when this process carries Redirection Trust Policy in ENFORCE mode.
///
/// The policy union is a 32-bit Flags word; the Enforcement field is the
/// low 2 bits: 0 = NOTSET, 1 = AUDIT, 2 = ENFORCE (see winnt.h
/// PROCESS_MITIGATION_REDIRECTION_TRUST_POLICY). ENFORCE is the mode that
/// blocks junction traversal (AUDIT only logs).
#[cfg(target_os = "windows")]
fn redirection_guard_enforced() -> bool {
    use windows_sys::Win32::System::Threading::{
        GetProcessMitigationPolicy, ProcessRedirectionTrustPolicy,
    };

    // GetCurrentProcess() pseudo-handle: query ourselves, no access rights
    // needed beyond holding the process. (windows-sys 0.59's HANDLE is a
    // *mut c_void; the pseudo-handle is -1.)
    let current: windows_sys::Win32::Foundation::HANDLE =
        -1isize as *mut core::ffi::c_void;
    let mut policy: u32 = 0;
    let ok = unsafe {
        GetProcessMitigationPolicy(
            current,
            ProcessRedirectionTrustPolicy,
            &mut policy as *mut u32 as *mut core::ffi::c_void,
            std::mem::size_of::<u32>(),
        )
    };
    if ok == 0 {
        // Not every Windows build knows this policy (older Win10): absent
        // support means not enforced — do not relaunch.
        return false;
    }
    (policy & 0x3) == 2
}

/// Launch a fresh KAI instance through the shell and terminate this one.
///
/// ShellExecuteW delegates creation to the shell process (explorer.exe),
/// which does NOT carry this process's mitigation policy — the new instance
/// runs with a clean token, exactly like a Start-menu launch. Returns false
/// (and keeps the current instance alive) when the relaunch cannot be
/// performed, so a failure here degrades to the status quo instead of
/// exiting into nothing.
#[cfg(target_os = "windows")]
fn relaunch_via_shell() -> bool {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let Some(exe) = exe.to_str() else {
        return false;
    };

    // UTF-16 builders (no shared helper here — this file is the only user).
    fn utf16z(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let verb = utf16z("open");
    let file = utf16z(exe);
    let params = utf16z(RELAUNCH_ARG);
    let dir = utf16z(
        &std::env::current_dir()
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_default(),
    );
    let rc = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            params.as_ptr(),
            if dir.len() <= 1 { std::ptr::null() } else { dir.as_ptr() },
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW returns a value > 32 on success.
    rc as usize > 32
}

/// Entry point, called FIRST in tauri setup on Windows. Detects a poisoned
/// inherited environment (Redirection Guard ENFORCE) and swaps this process
/// for a cleanly-parented one. No-op on non-Windows and on healthy launches
/// (the policy query is one syscall; a normal launch reads NOTSET).
#[cfg(target_os = "windows")]
pub fn ensure_clean_process_token() {
    if !redirection_guard_enforced() {
        return;
    }
    // Loop guard: a relaunched instance that is STILL enforced must not
    // relaunch again (the shell should never be mitigated, but a broken
    // enterprise policy could be) — log loudly and run degraded instead.
    if std::env::args().any(|a| a == RELAUNCH_ARG) {
        log::error!(
            "Redirection Guard is ENFORCED even after a clean relaunch — \
             junctioned paths (pnpm node_modules) will keep failing with \
             WinError 448. Start KAI from the Start menu / a shortcut to fix."
        );
        return;
    }
    log::warn!(
        "Redirection Guard ENFORCE inherited from the launcher \
         (installer/updated auto-restart?) — every child would fail \
         junctioned-path traversal (WinError 448). Relaunching KAI \
         through the shell with a clean process token."
    );
    if relaunch_via_shell() {
        // Disarm the kill-on-close job before exit: the shell-created
        // child is not ours to kill, but symmetric disarm matches the
        // updater exit path and cannot hurt.
        crate::modules::pty::job::clear_kill_on_close();
        std::process::exit(0);
    }
    log::error!(
        "Clean-token relaunch failed — continuing with Redirection Guard \
         ENFORVED inherited from the launcher. Junctioned node_modules will \
         fail (WinError 448) until KAI is restarted from the Start menu."
    );
}

#[cfg(not(target_os = "windows"))]
pub fn ensure_clean_process_token() {}
