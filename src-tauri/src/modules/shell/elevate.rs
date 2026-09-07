//! Privilege-elevated one-shot command execution.
//!
//! The normal shell paths (`shell_run_command`, `shell_session_run`,
//! `shell_bg_spawn`) run at the app's own (non-elevated) privilege. Some
//! operations — installing system packages, editing `/etc/hosts`, `net start`,
//! writing to protected dirs — require admin/root. This module runs a single
//! command with a privilege prompt and captures its output + exit code, on a
//! worker thread so the Tauri runtime stays responsive.
//!
//! Elevation strategy per platform:
//!   - **Windows**: `ShellExecuteW` with the `runas` verb (UAC consent), the
//!     command wrapped in a temp PowerShell/batch script that redirects
//!     stdout/stderr to temp files (ShellExecute cannot give us pipes).
//!   - **macOS**: `osascript -e 'do shell script … with administrator
//!     privileges'` (native auth dialog). Limitation: `do shell script` only
//!     returns stdout; command stderr is folded into the error string on
//!     failure and the true exit code is not preserved.
//!   - **Linux**: `pkexec` (polkit GUI prompt), falling back to `sudo -n`
//!     (passwordless sudo only — never a hanging password prompt).
//!
//! WSL workspaces are rejected: an elevated Windows process cannot usefully
//! reach a WSL filesystem through the UNC share.

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use super::{CommandOutput, MAX_OUTPUT_BYTES};
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

pub fn run_elevated(
    command: String,
    cwd: Option<String>,
    workspace: &WorkspaceEnv,
    dur: Duration,
) -> Result<CommandOutput, String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    if workspace.is_wsl() {
        return Err(
            "elevated commands are not supported for WSL workspaces — run the command inside the WSL distro instead"
                .into(),
        );
    }

    // Resolve + validate cwd up front (only Local is meaningful here).
    let cwd_path: Option<PathBuf> = match cwd.as_deref().filter(|s| !s.is_empty()) {
        Some(dir) => {
            let p = resolve_path(dir, workspace);
            if !p.is_dir() {
                return Err(format!("cwd is not a directory: {}", p.display()));
            }
            Some(p)
        }
        None => None,
    };

    platform::run(trimmed, cwd_path, dur)
}

// ── Unix shared helpers (macOS + Linux) ────────────────────────────────────

#[cfg(unix)]
fn drain_limited<R: Read>(reader: &mut R) -> (Vec<u8>, bool) {
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

#[cfg(unix)]
fn kill_tree(child: &std::process::Child) {
    let pid = child.id() as libc::pid_t;
    // SAFETY: the child leads its own process group (process_group(0) below).
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
}

#[cfg(unix)]
fn run_child_with_timeout(
    mut child: std::process::Child,
    dur: Duration,
) -> Result<CommandOutput, String> {
    use std::thread;
    use std::time::Instant;

    let mut stdout_pipe = child.stdout.take().ok_or("no stdout pipe")?;
    let mut stderr_pipe = child.stderr.take().ok_or("no stderr pipe")?;

    // Drain both pipes on background threads so a full pipe buffer can't
    // deadlock the elevated child.
    let stdout_handle = thread::spawn(move || drain_limited(&mut stdout_pipe));
    let stderr_handle = thread::spawn(move || drain_limited(&mut stderr_pipe));

    let started = Instant::now();
    let mut timed_out = false;
    let exit_code: Option<i32> = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {}
            Err(e) => return Err(e.to_string()),
        }
        if started.elapsed() >= dur {
            kill_tree(&child);
            let _ = child.kill();
            let _ = child.wait();
            timed_out = true;
            break None;
        }
        thread::sleep(Duration::from_millis(50));
    };

    let (stdout_bytes, stdout_truncated) =
        stdout_handle.join().unwrap_or((Vec::new(), false));
    let (stderr_bytes, stderr_truncated) =
        stderr_handle.join().unwrap_or((Vec::new(), false));

    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        exit_code,
        timed_out,
        truncated: stdout_truncated || stderr_truncated,
    })
}

// ── Windows: ShellExecuteW "runas" ─────────────────────────────────────────

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, TerminateProcess, WaitForSingleObject,
    };
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    fn to_wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn unique_token() -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        format!("{}_{:x}", std::process::id(), nanos)
    }

    fn read_capped(path: &PathBuf) -> (String, bool) {
        let mut f = match std::fs::File::open(path) {
            Ok(f) => f,
            Err(_) => return (String::new(), false),
        };
        let mut buf = Vec::new();
        let mut truncated = false;
        let mut chunk = [0u8; 8192];
        loop {
            match f.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    if buf.len() >= MAX_OUTPUT_BYTES {
                        truncated = true;
                        continue;
                    }
                    let take = (MAX_OUTPUT_BYTES - buf.len()).min(n);
                    buf.extend_from_slice(&chunk[..take]);
                    if take < n {
                        truncated = true;
                    }
                }
                Err(_) => break,
            }
        }
        (String::from_utf8_lossy(&buf).into_owned(), truncated)
    }

    pub fn run(
        command: String,
        cwd: Option<PathBuf>,
        dur: Duration,
    ) -> Result<CommandOutput, String> {
        let base = dirs::cache_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("kai")
            .join("elevated");
        std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
        let dir = base.join(unique_token());
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

        let shell = crate::modules::pty::shell_init::windows_shell_path();
        let shell_name = shell
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let is_cmd = shell_name == "cmd.exe";

        let out_file = dir.join("stdout.txt");
        let err_file = dir.join("stderr.txt");
        let script_file = dir.join(if is_cmd { "run.cmd" } else { "run.ps1" });

        let out_s = out_file.to_string_lossy().replace('/', "\\");
        let err_s = err_file.to_string_lossy().replace('/', "\\");

        let script = if is_cmd {
            format!(
                "@echo off\r\n{command} > \"{out_s}\" 2> \"{err_s}\"\r\nexit /b %errorlevel%\r\n"
            )
        } else {
            // UTF-8 BOM so PowerShell 5.1 (which otherwise assumes the ANSI
            // codepage) reads non-ASCII bytes correctly.
            format!(
                "\u{FEFF}& {{\r\n{command}\r\n}} 1> '{out_s}' 2> '{err_s}'\r\n$__KAI_rc = if ($null -ne $LASTEXITCODE) {{ $LASTEXITCODE }} elseif ($?) {{ 0 }} else {{ 1 }}\r\nexit $__KAI_rc\r\n"
            )
        };
        std::fs::write(&script_file, script).map_err(|e| e.to_string())?;

        let script_arg = format!("\"{}\"", script_file.to_string_lossy().replace('/', "\\"));
        let params = if is_cmd {
            format!("/D /S /C {script_arg}")
        } else {
            format!("-NoProfile -ExecutionPolicy Bypass -File {script_arg}")
        };

        let verb = to_wide("runas");
        let file = to_wide(&shell.to_string_lossy());
        let params = to_wide(&params);
        let cwd_wide = cwd.as_ref().map(|p| to_wide(&p.to_string_lossy()));

        let mut sei: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        sei.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        sei.fMask = SEE_MASK_NOCLOSEPROCESS;
        sei.lpVerb = verb.as_ptr();
        sei.lpFile = file.as_ptr();
        sei.lpParameters = params.as_ptr();
        sei.lpDirectory = cwd_wide.as_ref().map(|w| w.as_ptr()).unwrap_or(std::ptr::null());
        sei.nShow = SW_HIDE;

        let ok = unsafe { ShellExecuteExW(&mut sei) };
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            // ERROR_CANCELLED (1223) = the user clicked "No" on the UAC prompt.
            if err.raw_os_error() == Some(1223) {
                return Err("elevation cancelled by user".into());
            }
            return Err(format!("elevation failed: {err}"));
        }
        if sei.hProcess.is_null() {
            return Err("elevation did not return a process handle".into());
        }
        let handle = sei.hProcess;

        let wait_ms = dur.as_millis().min(u32::MAX as u128) as u32;
        let wait = unsafe { WaitForSingleObject(handle, wait_ms) };

        let mut exit_code: u32 = 1;
        let timed_out = if wait == WAIT_TIMEOUT {
            unsafe { TerminateProcess(handle, 1) };
            true
        } else {
            unsafe {
                let _ = GetExitCodeProcess(handle, &mut exit_code);
            }
            false
        };
        unsafe { CloseHandle(handle) };

        let (stdout, stdout_truncated) = read_capped(&out_file);
        let (stderr, stderr_truncated) = read_capped(&err_file);

        // Best-effort cleanup; temp dir is under cache_dir so leftovers are
        // harmless and cleaned by the OS eventually.
        let _ = std::fs::remove_dir_all(&dir);

        Ok(CommandOutput {
            stdout,
            stderr,
            exit_code: Some(exit_code as i32),
            timed_out,
            truncated: stdout_truncated || stderr_truncated,
        })
    }
}

// ── macOS: osascript "do shell script … with administrator privileges" ─────

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::process::Stdio;

    /// Build an AppleScript string literal with backslash + quote escaping.
    fn applescript_string(s: &str) -> String {
        let mut out = String::with_capacity(s.len() + 2);
        out.push('"');
        for c in s.chars() {
            match c {
                '\\' => out.push_str("\\\\"),
                '"' => out.push_str("\\\""),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                _ => out.push(c),
            }
        }
        out.push('"');
        out
    }

    fn posix_quote(s: &str) -> String {
        format!("'{}'", s.replace('\'', "'\\''"))
    }

    pub fn run(
        command: String,
        cwd: Option<PathBuf>,
        dur: Duration,
    ) -> Result<CommandOutput, String> {
        let mut script = String::new();
        if let Some(cwd) = &cwd {
            script.push_str(&format!("cd {} && ", posix_quote(&cwd.to_string_lossy())));
        }
        script.push_str(&command);

        let osa = format!(
            "do shell script {} with administrator privileges",
            applescript_string(&script)
        );

        let mut cmd = std::process::Command::new("osascript");
        cmd.arg("-e")
            .arg(osa)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let child = cmd.spawn().map_err(|e| e.to_string())?;
        let out = super::run_child_with_timeout(child, dur)?;

        // `do shell script` returns command stdout on success; command stderr
        // only surfaces inside osascript's own error text on failure. We keep
        // stdout as the primary result and leave stderr to carry any osascript
        // error (which the wrapper below does not — so stderr is empty here).
        Ok(out)
    }
}

// ── Linux: pkexec → sudo -n fallback ───────────────────────────────────────

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    use super::*;
    use std::process::{Command, Stdio};

    fn posix_quote(s: &str) -> String {
        format!("'{}'", s.replace('\'', "'\\''"))
    }

    pub fn run(
        command: String,
        cwd: Option<PathBuf>,
        dur: Duration,
    ) -> Result<CommandOutput, String> {
        let mut wrapped = String::new();
        if let Some(cwd) = &cwd {
            wrapped.push_str(&format!("cd {} && ", posix_quote(&cwd.to_string_lossy())));
        }
        wrapped.push_str(&command);

        // pkexec runs the target with cwd reset to `/`, so the `cd` above is
        // the only way to honor the caller's cwd. polkit's auth prompt appears
        // on the desktop; cancel → non-zero exit.
        let mut pk = Command::new("pkexec");
        pk.arg("sh").arg("-c").arg(&wrapped)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        {
            use std::os::unix::process::CommandExt;
            pk.process_group(0);
        }

        match pk.spawn() {
            Ok(child) => super::run_child_with_timeout(child, dur),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Fall back to passwordless sudo. `-n` is essential: without it
                // sudo would block on a password prompt against a null stdin.
                let mut sd = Command::new("sudo");
                sd.arg("-n").arg("sh").arg("-c").arg(&wrapped)
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                {
                    use std::os::unix::process::CommandExt;
                    sd.process_group(0);
                }
                match sd.spawn() {
                    Ok(child) => super::run_child_with_timeout(child, dur),
                    Err(e2) => Err(format!(
                        "no privilege-elevation helper available (need pkexec or passwordless sudo): {e2}"
                    )),
                }
            }
            Err(e) => Err(format!("pkexec spawn failed: {e}")),
        }
    }
}
