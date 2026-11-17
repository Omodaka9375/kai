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

// ── Registry-merged child PATH ────────────────────────────────────────
//
// 2026-11-17 user report (v3.1.4): "after the auto-update restart, all node
// projects and commands couldn't execute; killing and restarting KAI fixed
// it." The updater's auto-restart parents KAI to the NSIS installer process,
// which hands the child a TRUNCATED (machine-only) PATH: every user-PATH
// entry is gone. The 3.1.4 Redirection Guard relaunch does not catch this
// shape (no mitigation policy is inherited), so every PTY shell, agent shell
// session, and one-shot command spawned from the auto-restarted instance
// inherits the stripped PATH and node/pnpm/uvx etc. vanish until the user
// manually restarts.
//
// The repair that shipped for MCP spawns in 3.1.2 (read the live registry
// PATH and append missing entries) now lives here and is applied at EVERY
// Windows child-spawn site (PTY shells, one-shot commands — which agent
// shell sessions and background processes also route through, and MCP).
// Additive-only and deduped: a normally-launched KAI gains nothing (the set
// diff is empty), a truncated-environment KAI gets its user entries back.

/// NUL-terminated UTF-16 for the W-suffix registry APIs.
#[cfg(target_os = "windows")]
fn utf16z_reg(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Decode a registry string value's UTF-16 buffer into a clean Rust string.
///
/// Strips ALL trailing nuls (a value stored with a double terminator — or a
/// corrupted one — would otherwise leak a `\0` into the merged PATH, and
/// `Command::env` refuses nul bytes, which killed EVERY stdio MCP spawn with
/// "nul byte found in provided data"), and returns None for any INTERIOR
/// nul (the value is unusable — a nul inside a PATH entry can never be
/// right).
#[cfg(target_os = "windows")]
fn decode_reg_sz(buf: &[u16]) -> Option<String> {
    let mut end = buf.len();
    while end > 0 && buf[end - 1] == 0 {
        end -= 1;
    }
    let s = String::from_utf16_lossy(&buf[..end]);
    if s.contains('\0') {
        return None;
    }
    Some(s)
}

/// Read a REG_SZ / REG_EXPAND_SZ string value from the registry.
///
/// 2026-11-17 (v3.1.3 report): ALL of a user's MCP servers died at spawn with
/// "nul byte found in provided data" after updating. Two defects in this
/// reader fed a nul byte into the merged PATH:
///  1. only ONE trailing nul was stripped — a value stored with a double
///     terminator (or an interior nul, which corrupted values carry)
///     survived into the string;
///  2. an RRF_RT_REG_SZ-only restriction rejected REG_EXPAND_SZ values —
///     the type Windows writes for the USER Path whenever it contains %
///     references — so the user PATH was silently never merged at all.
///
/// Both string types are accepted (RegGetValueW auto-expands REG_EXPAND_SZ
/// unless RRF_NOEXPAND is set), the read retries once on ERROR_MORE_DATA
/// (the value grew between the size probe and the read), and `decode_reg_sz`
/// strips all trailing nuls / refuses interior ones.
#[cfg(target_os = "windows")]
fn reg_path_value(
    hkey: windows_sys::Win32::System::Registry::HKEY,
    subkey: &str,
) -> Option<String> {
    use windows_sys::Win32::Foundation::ERROR_MORE_DATA;
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
    };

    let sub = utf16z_reg(subkey);
    let val = utf16z_reg("Path");
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
    let mut ty: u32 = 0;
    let mut len: u32 = 0;
    // Size probe (pvData = null) then the real read; one retry when the value
    // grew in between (ERROR_MORE_DATA updates lpcbData with the needed size).
    for _ in 0..2 {
        let rc = unsafe {
            RegGetValueW(
                hkey,
                sub.as_ptr(),
                val.as_ptr(),
                flags,
                &mut ty,
                std::ptr::null_mut(),
                &mut len,
            )
        };
        if rc == ERROR_MORE_DATA || rc != 0 || len < 2 {
            continue;
        }
        let mut buf = vec![0u16; (len / 2) as usize];
        let rc = unsafe {
            RegGetValueW(
                hkey,
                sub.as_ptr(),
                val.as_ptr(),
                flags,
                &mut ty,
                buf.as_mut_ptr().cast(),
                &mut len,
            )
        };
        if rc != 0 {
            continue;
        }
        return decode_reg_sz(&buf[..(len / 2) as usize]).or_else(|| {
            log::warn!(
                "registry PATH value under {subkey} contains an interior nul \
                 — skipping it (a nul byte in PATH kills every child spawn)"
            );
            None
        });
    }
    None
}

/// The PATH every child KAI spawns should see: the inherited PATH plus any
/// registry (machine, then user) entries missing from it.
///
/// A normally-launched KAI gets its own PATH back untouched (every registry
/// entry is already present — the set diff is empty). An auto-restart /
/// installer-launched KAI with a machine-only PATH gets the user entries
/// appended, so PTY shells, agent commands and MCP spawns all resolve
/// node/pnpm/uvx/python like a Start-menu launch would. Failures return the
/// inherited PATH unchanged.
#[cfg(target_os = "windows")]
pub fn merged_windows_path() -> String {
    use std::collections::HashSet;
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    fn norm(e: &str) -> String {
        // Windows path lookup is case-insensitive; ignore trailing separator.
        e.trim_end_matches('\\').to_lowercase()
    }

    let current = std::env::var("PATH").unwrap_or_default();
    // Nul hygiene: an inherited PATH carrying a nul byte anywhere (corrupted
    // parent env) would kill every child spawn via Command::env. Entries
    // before the first nul are kept.
    let current = current.split('\0').next().unwrap_or_default().to_string();
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
            "child spawn: inherited PATH was missing {added} registry PATH \
             entries (auto-restart/installer launch?) — merged them back in"
        );
    }
    merged
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    // decode_reg_sz is the pure decode half of reg_path_value; its registry
    // half needs the real API. Pin the nul hygiene: 2026-11-17 report had ALL
    // MCP servers dead with "nul byte found in provided data" because a nul
    // survived this decode into Command::env("PATH", ...).

    #[test]
    fn decode_reg_sz_strips_all_trailing_nuls() {
        // Single terminator: normal case.
        let buf: Vec<u16> = "C:\\bin".encode_utf16().chain(Some(0)).collect();
        assert_eq!(decode_reg_sz(&buf).as_deref(), Some("C:\\bin"));
        // DOUBLE terminator: the exact corrupted shape that leaked a nul and
        // killed every MCP spawn — all trailing nuls must go.
        let buf: Vec<u16> = "C:\\bin".encode_utf16().chain([0, 0]).collect();
        assert_eq!(decode_reg_sz(&buf).as_deref(), Some("C:\\bin"));
        // No terminator at all: fine.
        let buf: Vec<u16> = "C:\\bin".encode_utf16().collect();
        assert_eq!(decode_reg_sz(&buf).as_deref(), Some("C:\\bin"));
    }

    #[test]
    fn decode_reg_sz_rejects_interior_nuls() {
        // A nul INSIDE the value can never be a valid PATH entry — refuse the
        // whole value instead of truncating silently.
        let s = "C:\\bin\0C:\\evil";
        let buf: Vec<u16> = s.encode_utf16().collect();
        assert_eq!(decode_reg_sz(&buf), None);
    }
}
