//! Diagnostics bundle for one-click bug reporting.
//!
//! KAI keeps a rotating log file (via `tauri-plugin-log`) and writes a crash
//! snapshot on panic. `diagnostics_collect` returns the pieces the About page
//! needs to pre-fill a GitHub issue without the user copying anything by hand.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, State};

use crate::modules::lock::mutex_lock;

/// Capped sizes keep the payload small enough to embed in an issue body/URL
/// while still carrying the useful tail of a crash.
const LOG_TAIL_BYTES: usize = 8 * 1024;
const CRASH_BYTES: usize = 16 * 1024;

/// Resolved process memory usage, in bytes. On Windows this is the working
/// set + private commit (the two numbers Task Manager shows); elsewhere we
/// fall back to /proc (Linux) and rusage (macOS) so the field is populated
/// on every platform without pulling in a crate.
fn process_memory_bytes() -> (u64, u64) {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::ProcessStatus::{
            GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
        };
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        let mut pmc: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
        pmc.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        // SAFETY: pmc is a correctly-sized, zero-initialized struct and its
        // size is passed in cb, per the API contract.
        let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut pmc, pmc.cb) };
        if ok != 0 {
            (
                pmc.WorkingSetSize as u64,
                pmc.PagefileUsage as u64, // private commit
            )
        } else {
            (0, 0)
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Best-effort non-Windows fallbacks; (0, 0) is fine — the health
        // panel then simply shows the counters it does have.
        #[cfg(target_os = "linux")]
        {
            let status = fs::read_to_string("/proc/self/status").unwrap_or_default();
            let rss = status
                .lines()
                .find(|l| l.starts_with("VmRSS:"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|v| v.parse::<u64>().ok())
                .map(|kb| kb * 1024)
                .unwrap_or(0);
            (rss, 0)
        }
        #[cfg(not(target_os = "linux"))]
        (0, 0)
    }
}

/// Where the panic hook writes crash snapshots. Set in `Builder::setup`.
#[derive(Default)]
pub struct CrashDir(pub Mutex<Option<PathBuf>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsBundle {
    pub version: String,
    pub os: String,
    pub arch: String,
    pub log_dir: String,
    pub log_tail: String,
    pub crash: Option<String>,
}

/// Live counters surfaced in the About page health section. These exist so a
/// "KAI slows down after hours" report can distinguish Rust-side accumulation
/// (session maps growing, PTYs never reaped) from frontend-side issues — the
/// counts should stay flat when the user isn't opening/closing tabs.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HealthCounts {
    pub pid: u32,
    pub uptime_secs: u64,
    pub rss_bytes: u64,
    pub private_bytes: u64,
    pub pty_sessions: usize,
    pub shell_sessions: usize,
    pub bg_processes: usize,
}

/// Process start time, used for the uptime in `health_counts`.
static PROCESS_START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// Capture the process start time as early as possible (called from
/// `Builder::setup`) so `health_counts` uptime reflects true process uptime
/// instead of time-since-first-About-visit (a lazy init on the first
/// `health_counts` call always read 0h 0m).
pub fn init_process_start() {
    PROCESS_START.get_or_init(std::time::Instant::now);
}

#[tauri::command]
pub fn health_counts(app: tauri::AppHandle) -> HealthCounts {
    let (rss, private) = process_memory_bytes();
    let pty_sessions = app.state::<crate::pty::PtyState>().count();
    let (shell_sessions, bg_processes) = app.state::<crate::shell::ShellState>().counts();
    HealthCounts {
        pid: std::process::id(),
        uptime_secs: PROCESS_START
            .get_or_init(std::time::Instant::now)
            .elapsed()
            .as_secs(),
        rss_bytes: rss,
        private_bytes: private,
        pty_sessions,
        shell_sessions,
        bg_processes,
    }
}

fn tail_bytes(path: &std::path::Path, max: usize) -> String {
    let Ok(bytes) = fs::read(path) else {
        return String::new();
    };
    let start = bytes.len().saturating_sub(max);
    // Start at a UTF-8 boundary so we don't split a codepoint.
    let mut start = start;
    while start > 0 && !bytes[start].is_ascii() {
        start -= 1;
    }
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

/// Read the tail of the most recently written `.log` file in `log_dir`.
/// Scans across instances by mtime so diagnostics also surface a crash from a
/// sibling process that has since exited.
fn read_latest_log_tail(log_dir: &std::path::Path) -> String {
    let Ok(entries) = fs::read_dir(log_dir) else {
        return String::new();
    };

    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("log") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        if newest.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
            newest = Some((modified, path));
        }
    }

    match newest {
        Some((_, path)) => tail_bytes(&path, LOG_TAIL_BYTES),
        None => String::new(),
    }
}

/// Read the most recent crash snapshot, if any.
fn read_latest_crash(log_dir: &std::path::Path) -> Option<String> {
    let Ok(entries) = fs::read_dir(log_dir) else {
        return None;
    };

    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("crash-") || !name.ends_with(".log") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        if newest.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
            newest = Some((modified, entry.path()));
        }
    }

    newest.map(|(_, path)| tail_bytes(&path, CRASH_BYTES))
}

#[tauri::command]
pub fn diagnostics_collect(app: tauri::AppHandle, state: State<'_, CrashDir>) -> DiagnosticsBundle {
    let version = app.package_info().version.to_string();
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();

    let log_dir = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir());

    // The crash hook may have recorded a directory we couldn't derive here
    // (e.g. before `app_log_dir` resolved); prefer that fallback.
    let log_dir = mutex_lock(&state.0)
        .clone()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(log_dir);

    let log_tail = read_latest_log_tail(&log_dir);
    let crash = read_latest_crash(&log_dir);

    DiagnosticsBundle {
        version,
        os,
        arch,
        log_dir: log_dir.to_string_lossy().into_owned(),
        log_tail,
        crash,
    }
}

/// Install a panic hook that snapshots the panic + backtrace to a file, so a
/// crash can still be reported even though `panic = "abort"` tears the process
/// down immediately after.
pub fn install_panic_hook(log_dir: PathBuf, instance_id: String) {
    let hook_dir = log_dir.clone();
    std::panic::set_hook(Box::new(move |info| {
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic payload".to_string()
        };

        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());

        let backtrace = std::backtrace::Backtrace::force_capture();
        let text = format!("panic at {location}\n{payload}\n\n--- backtrace ---\n{backtrace}");

        // Best-effort snapshot; a panic is already fatal, so never panic here.
        if let Ok(()) = fs::create_dir_all(&hook_dir) {
            let unix = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let path = hook_dir.join(format!("crash-{instance_id}-{unix}.log"));
            let _ = fs::write(&path, &text);
        }

        // Also push into the normal log stream so it lands in the rotating file.
        log::error!("{text}");
    }));
}
