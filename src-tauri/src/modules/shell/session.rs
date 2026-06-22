use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;

use crate::modules::workspace::{resolve_path, WorkspaceEnv};

/// A persistent agent shell session. Each `run` call executes through the
/// user's login shell with the session's tracked cwd. Cwd persists across
/// calls; environment overrides via `export` do not (this is an agent shell,
/// not an interactive REPL — interactive tools must NOT be invoked here, use
/// the background process API for long-running work).
pub struct ShellSession {
    pub cwd: Mutex<String>,
    pub workspace: WorkspaceEnv,
    /// While pristine (no `run` yet), caller-provided cwd hints reseed `cwd`.
    pub pristine: AtomicBool,
    /// Set to true to abort the currently running command.
    pub cancel: Arc<AtomicBool>,
    /// Per-session sentinel string used to extract cwd from command output.
    sentinel: String,
    #[allow(dead_code)]
    pub started_at_ms: u64,
}

#[derive(Serialize)]
pub struct SessionRunOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
    pub cwd_after: String,
}

/// Per-session sentinel prefix. A random hex suffix is appended at session
/// creation so that command output containing the literal `__KAI_CWD__` can
/// never accidentally (or maliciously) corrupt cwd tracking.
const CWD_SENTINEL_PREFIX: &str = "__KAI_CWD_";

fn new_sentinel() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    // Mix pid + timestamp + counter for uniqueness without pulling in a UUID crate.
    static CTR: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let c = CTR.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    format!("{CWD_SENTINEL_PREFIX}{t:x}_{pid:x}_{c:x}__")
}

impl ShellSession {
    pub fn new(initial_cwd: String, workspace: WorkspaceEnv) -> Self {
        let started_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Self {
            cwd: Mutex::new(initial_cwd),
            workspace,
            pristine: AtomicBool::new(true),
            cancel: Arc::new(AtomicBool::new(false)),
            sentinel: new_sentinel(),
            started_at_ms,
        }
    }

    pub fn current_cwd(&self) -> String {
        self.cwd.lock().unwrap().clone()
    }

    pub fn run(
        &self,
        command: String,
        cwd_hint: Option<String>,
        workspace_hint: Option<WorkspaceEnv>,
        timeout: Duration,
    ) -> Result<SessionRunOutput, String> {
        let trimmed = command.trim().to_string();
        if trimmed.is_empty() {
            return Err("empty command".into());
        }
        if self.pristine.load(Ordering::Acquire) {
            if let Some(hint) = cwd_hint.filter(|s| !s.is_empty()) {
                let effective_workspace = workspace_hint.as_ref().unwrap_or(&self.workspace);
                let p = resolve_path(&hint, effective_workspace);
                if p.is_dir() {
                    *self.cwd.lock().unwrap() = hint;
                }
            }
        }
        let cwd = self.current_cwd();
        let effective_workspace = workspace_hint.unwrap_or_else(|| self.workspace.clone());
        let wrapped = wrap_with_sentinel(&trimmed, &effective_workspace, &self.sentinel);

        self.cancel.store(false, Ordering::Release);
        let cancel = self.cancel.clone();
        let (tx, rx) = mpsc::channel::<Result<super::CommandOutput, String>>();
        let cwd_for_thread = cwd.clone();
        thread::spawn(move || {
            let _ = tx.send(super::run_blocking_cancellable_pub(
                wrapped,
                Some(cwd_for_thread),
                effective_workspace,
                timeout,
                Some(&cancel),
            ));
        });
        let raw = rx.recv().map_err(|e| e.to_string())??;
        self.pristine.store(false, Ordering::Release);

        let (stdout_clean, cwd_after) = strip_cwd_sentinel(&raw.stdout, &self.sentinel);
        if let Some(ref new_cwd) = cwd_after {
            let p = resolve_path(new_cwd, &self.workspace);
            if p.is_dir() {
                *self.cwd.lock().unwrap() = new_cwd.clone();
            }
        }
        let resolved_cwd = self.current_cwd().replace('\\', "/");

        Ok(SessionRunOutput {
            stdout: stdout_clean,
            stderr: raw.stderr,
            exit_code: raw.exit_code,
            timed_out: raw.timed_out,
            truncated: raw.truncated,
            cwd_after: resolved_cwd,
        })
    }
}

fn wrap_posix_with_sentinel(command: &str, sentinel: &str) -> String {
    format!(
        "{command}\n__KAI_rc=$?\nprintf '\\n%s%s\\n' '{sentinel}' \"$(pwd)\"\nexit $__KAI_rc\n",
    )
}

fn wrap_with_sentinel(command: &str, workspace: &WorkspaceEnv, sentinel: &str) -> String {
    if workspace.is_wsl() {
        return wrap_posix_with_sentinel(command, sentinel);
    }
    #[cfg(unix)]
    {
        wrap_posix_with_sentinel(command, sentinel)
    }
    #[cfg(windows)]
    {
        format!(
        "{command}\n$__KAI_rc = if ($null -ne $LASTEXITCODE) {{ $LASTEXITCODE }} elseif ($?) {{ 0 }} else {{ 1 }}\n\"`n{sentinel}$($PWD.Path)\"\nexit $__KAI_rc\n",
    )
    }
}

fn strip_cwd_sentinel(stdout: &str, sentinel: &str) -> (String, Option<String>) {
    if let Some(idx) = stdout.rfind(sentinel) {
        let before = &stdout[..idx];
        let after = &stdout[idx + sentinel.len()..];
        let cwd_line = after.lines().next().unwrap_or("").trim();
        let cleaned = before.trim_end_matches('\n').to_string();
        return (cleaned, Some(cwd_line.to_string()));
    }
    (stdout.to_string(), None)
}
