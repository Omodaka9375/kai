use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;

#[cfg(windows)]
use base64::Engine as _;

use crate::modules::lock::mutex_lock;
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
        Self {
            cwd: Mutex::new(initial_cwd),
            workspace,
            pristine: AtomicBool::new(true),
            cancel: Arc::new(AtomicBool::new(false)),
            sentinel: new_sentinel(),
        }
    }

    pub fn current_cwd(&self) -> String {
        mutex_lock(&self.cwd).clone()
    }

    pub fn run(
        &self,
        command: String,
        cwd_hint: Option<String>,
        workspace_hint: Option<WorkspaceEnv>,
        timeout: Duration,
        sandbox_root: Option<&str>,
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
                    *mutex_lock(&self.cwd) = hint;
                }
            }
        }
        let cwd = self.current_cwd();
        let effective_workspace = workspace_hint.unwrap_or_else(|| self.workspace.clone());
        // When OS-confined (workspaceOnly), the command may run inside a
        // non-PowerShell runner (busybox sh in the WSL sandbox distro) — the
        // sentinel tail must then be POSIX, not the PowerShell wrapper the
        // Windows-local path normally emits.
        let sandboxed = sandbox_root.is_some_and(|r| !r.is_empty());
        let wrapped = if sandboxed {
            wrap_posix_with_sentinel(&trimmed, &self.sentinel)
        } else {
            wrap_with_sentinel(&trimmed, &effective_workspace, &self.sentinel)
        };

        self.cancel.store(false, Ordering::Release);
        let cancel = self.cancel.clone();
        let (tx, rx) = mpsc::channel::<Result<super::CommandOutput, String>>();
        let cwd_for_thread = cwd.clone();
        let sandbox_root = sandbox_root.map(|s| s.to_string());
        thread::spawn(move || {
            let _ = tx.send(super::run_blocking_cancellable_pub(
                wrapped,
                Some(cwd_for_thread),
                effective_workspace,
                timeout,
                Some(&cancel),
                sandbox_root.as_deref(),
            ));
        });
        let raw = rx.recv().map_err(|e| e.to_string())??;
        self.pristine.store(false, Ordering::Release);

        let (stdout_clean, cwd_after) = strip_cwd_sentinel(&raw.stdout, &self.sentinel);
        if let Some(ref new_cwd) = cwd_after {
            let p = resolve_path(new_cwd, &self.workspace);
            if p.is_dir() {
                *mutex_lock(&self.cwd) = new_cwd.clone();
            }
        }
        let resolved_cwd = self.current_cwd().replace('\\', "/");

        // Backstop for dialect mangling. With the user command deferred to
        // Invoke-Expression (see wrap_with_sentinel), the WRAPPER can no longer
        // fail to parse — a syntax error in the agent's command now surfaces as
        // the command's own error on stderr while the sentinel + `exit` still
        // run, so cwd and exit code stay honest. We still coach the most common
        // root cause: bash-style escaping / unterminated strings / 5.1's
        // rejection of `&&`, all of which survive repair_bash_style_quotes or
        // reflect genuine PowerShell grammar the model got wrong.
        //
        // Two variants of coaching matter and are not interchangeable:
        //  - `not a valid statement separator` is Windows PowerShell 5.1's
        //    ONLY way to say "install pwsh 7 or use `;` to chain"; the general
        //    bash-vs-PS hint doesn't help there (5.1 has no `&&` in any form).
        //  - Everything else (ParserError / unexpected-token / missing-
        //    terminator / etc.) is the general bash-escape/syntax case.
        //
        // Verified empirically against real 5.1 + 7.7 (see the commit history):
        // iex+catch turns 5.1's && parse error into a NON-terminating error,
        // so CategoryInfo is NotSpecified, not ParserError — the plain
        // "parsererror" substring would MISS the && case. Detect it by its
        // unique message instead.
        let stderr = match parse_failure_hint(raw.exit_code, &raw.stderr) {
            Some(hint) => format!("{}\n{}", raw.stderr, hint),
            None => raw.stderr,
        };

        Ok(SessionRunOutput {
            stdout: stdout_clean,
            stderr,
            exit_code: raw.exit_code,
            timed_out: raw.timed_out,
            truncated: raw.truncated,
            cwd_after: resolved_cwd,
        })
    }
}

/// Coach the two PowerShell dialect failures the deferred-iex wrapper still
/// lets the MODEL see (the wrapper itself can no longer fail to parse).
/// Returns the hint to append to stderr, or None when the command failed for
/// some ordinary reason (a real nonzero exit, an application error) that must
/// NOT be relabeled a syntax problem.
///
/// Only meaningful on a failed exit (Some(nonzero)); a timed-out run (None
/// exit_code) gets no hint. Verified empirically against real Windows
/// PowerShell 5.1 + pwsh 7.7 (see commit history): iex + our catch turns 5.1's
/// `&&` error into a NON-terminating error, so CategoryInfo is `NotSpecified`,
/// NOT `ParserError` — the plain "parsererror" substring would MISS the &&
/// case, which is why it's matched by its unique "not a valid statement
/// separator" message and given a distinct, actionable hint (5.1 has no `&&`
/// in any form; the fix is `;` / split / `if ($?)`, not quoting).
fn parse_failure_hint(exit_code: Option<i32>, stderr: &str) -> Option<&'static str> {
    if !exit_code.map(|c| c != 0).unwrap_or(false) {
        return None;
    }
    let lower = stderr.to_lowercase();
    if lower.contains("not a valid statement separator") {
        return Some("[Kai hint: this is Windows PowerShell 5.1, which does not support `&&` or `||` as statement separators (pwsh 7+ does). Rewrite the chained command as either: (a) separate statements with `;` — but that runs the second command UNCONDITIONALLY (no short-circuit on failure), or (b) split into multiple bash_run calls, checking the first's exit_code before the second, or (c) `if ($?) { <next> }` to emulate short-circuit. Do NOT try to quote your way around it.]");
    }
    let general = lower.contains("parsererror")
        || lower.contains("parse error")
        || lower.contains("unexpected token")
        || lower.contains("unexpectedtoken")
        || lower.contains("missing the terminator")
        || lower.contains("an expression was expected")
        || lower.contains("you must provide a value");
    if general {
        return Some("[Kai hint: PowerShell failed to parse the command. It runs under PowerShell, NOT bash: use PowerShell syntax (backtick-quote (`\") for a literal quote in a double-quoted string, a doubled backtick for a literal backtick; never bash \\\" or \\` escapes — that is the usual cause). Prefer single-quoted strings, keep each command to one responsibility instead of chaining long ;/&& pipelines, and use the grep/glob/edit tools instead of PowerShell text-wrangling.]");
    }
    None
}

fn wrap_posix_with_sentinel(command: &str, sentinel: &str) -> String {
    format!("{command}\n__KAI_rc=$?\nprintf '\\n%s%s\\n' '{sentinel}' \"$(pwd)\"\nexit $__KAI_rc\n",)
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
        // Parse-isolation. The user command is base64-embedded and executed
        // at RUNTIME via Invoke-Expression, so the wrapper's OWN static parse
        // never sees a bad token. Previously the command was spliced in as
        // literal top-level script, so an unterminated string / stray pipe in
        // a model-written pipeline (very common in long "combined" Windows
        // commands) made the ENTIRE file — cwd sentinel and exit-code epilogue
        // included — fail to parse: the agent got a `ParserError` pointing at
        // lines it never wrote, AND lost cwd tracking + the exit code. With the
        // command deferred to runtime, a malformed command raises its OWN
        // error on stderr while the sentinel + `exit` still run, so the result
        // is honest and the next command still starts in the right directory.
        //
        // Invoke-Expression runs in the CURRENT scope, so `cd` and variable
        // assignment behave exactly as the old inline top-level form (a
        // scriptblock call operator `& {}` would run the body in a child
        // scope, silently breaking cwd persistence). A bad command raises a
        // TERMINATING parse error, so the iex is wrapped in try/catch: the
        // error is written to stderr (the model sees exactly what broke in
        // ITS command) and $__KAI_err forces rc=1 — but crucially the sentinel
        // line + `exit` still run, so cwd tracking and the exit code survive a
        // malformed command instead of the whole script dying. Non-terminating
        // errors (a normal failing external command) aren't caught; $? /
        // $LASTEXITCODE compute rc for those as before.
        //
        // `| Out-Default` is load-bearing, not decoration: a command that
        // leaves a pending Format-Table pipeline (Get-Location, Get-ChildItem,
        // Select-Object …) is buffered by the formatter, and PowerShell's
        // `exit` truncates that un-rendered output. Without the explicit flush,
        // BOTH the command's own results AND the following cwd-sentinel line
        // vanish (silently losing the agent's tracked directory). Piping to
        // Out-Default forces the formatter to render before the sentinel. This
        // latent bug predated the iex change (the old top-level splice hit it
        // too) — verified empirically across 7 cases including cd-persistence.
        //
        // repair_bash_style_quotes is applied BEFORE encoding — the same
        // bash→PS escape coaching the `-File` path applies (see
        // write_shell_script in mod.rs), so double-escaped `\"` still becomes
        // the PS literal-quote form. The sentinel line keeps its leading
        // newline so strip_cwd_sentinel still isolates the cwd cleanly.
        let repaired = super::repair_bash_style_quotes(command);
        let b64 = base64::engine::general_purpose::STANDARD.encode(repaired.as_bytes());
        format!(
            "$__KAI_s = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{b64}'))\n$__KAI_err = $false\ntry {{ Invoke-Expression $__KAI_s | Out-Default }}\ncatch {{ $__KAI_err = $true; Write-Error ($_.Exception.Message + \"`n\" + $_.InvocationInfo.PositionMessage) }}\nif ($__KAI_err) {{ $__KAI_rc = 1 }}\nelseif ($null -ne $LASTEXITCODE) {{ $__KAI_rc = $LASTEXITCODE }}\nelseif ($?) {{ $__KAI_rc = 0 }}\nelse {{ $__KAI_rc = 1 }}\n\"`n{sentinel}$($PWD.Path)\"\nexit $__KAI_rc\n",
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    // The Windows sentinel wrapper is load-bearing for parse-isolation +
    // cwd/output survival. These pin its SHAPE so a refactor can't silently
    // regress the behavior verified empirically against real pwsh (see
    // commit history): a malformed command must not take down the sentinel.
    fn windows_wrap(cmd: &str) -> String {
        wrap_with_sentinel(cmd, &WorkspaceEnv::Local, "__KAI_CWD_x__")
    }

    #[test]
    fn wrapper_defers_parse_via_iex_and_flushes_via_out_default() {
        let w = windows_wrap("Get-Location");
        // Base64-embedded command (parse deferred to runtime).
        assert!(w.contains("[Convert]::FromBase64String("), "{w}");
        assert!(w.contains("Invoke-Expression"), "{w}");
        // The formatter flush — WITHOUT this, `exit` swallows table output AND
        // the cwd sentinel (the latent bug). Non-negotiable.
        assert!(w.contains("Invoke-Expression $__KAI_s | Out-Default"), "{w}");
        // try/catch so a terminating parse error still reaches the sentinel.
        assert!(w.contains("try {") && w.contains("catch {"), "{w}");
        // The command text never appears raw on the top level (it's encoded).
        assert!(!w.contains("Get-Location\n"), "raw command leaked into wrapper: {w}");
    }

    #[test]
    fn wrapper_emits_exit_and_sentinel_after_the_body() {
        let w = windows_wrap("Write-Output hi");
        assert!(w.contains("__KAI_CWD_x__$($PWD.Path)"), "{w}");
        assert!(w.contains("exit $__KAI_rc"), "{w}");
        // rc precedence: parse-error flag > native exit > $? success.
        assert!(w.contains("if ($__KAI_err) { $__KAI_rc = 1 }"), "{w}");
        assert!(w.contains("$null -ne $LASTEXITCODE"), "{w}");
    }

    #[test]
    fn repair_runs_before_encoding_so_specials_are_safe() {
        // A bash-style \" must be repaired to the PS literal-quote form, and
        // the whole (repaired) string base64'd — so no raw quote ever sits on
        // the wrapper's top-level parse path.
        let w = windows_wrap("python -c \"print(1)\"");
        assert!(w.contains("[Convert]::FromBase64String("), "{w}");
        // The literal double-quote of the child's arg must NOT appear raw.
        let top = w.split_once("FromBase64String('").unwrap().1;
        let embedded = top.split_once("')").unwrap().0;
        assert!(
            !embedded.contains('"'),
            "wrapper substitution line should carry only base64: {embedded}"
        );
        // Base64 alphabet only.
        assert!(
            embedded
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='),
            "not base64: {embedded}"
        );
    }

    #[test]
    fn strip_sentinel_still_works_on_the_new_shape() {
        // Front of a captured session stdout, mimic the real emitted tail.
        let stdout = "hi\r\n\r\n__KAI_CWD_x__D:\\Code\\KAI\r\n".to_string();
        let (clean, cwd) = strip_cwd_sentinel(&stdout, "__KAI_CWD_x__");
        assert_eq!(cwd.as_deref(), Some("D:\\Code\\KAI"));
        assert!(!clean.contains("__KAI_CWD_x__"));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn posix_wrapper_unchanged() {
        let w = wrap_posix_with_sentinel("ls", "__KAI_CWD_x__");
        assert!(w.contains("__KAI_CWD_x__"));
        assert!(w.contains("exit $__KAI_rc"));
        assert!(w.contains("ls\n__KAI_rc=$?"));
    }
}

// parse_failure_hint is a platform-independent pure function (string
// classification + &'static str pick), so its tests run on every OS — not just
// the platform that spawns the shell. These pin the dialect-failure taxonomy
// the wrapper depends on.
#[cfg(test)]
mod hint_tests {
    use super::parse_failure_hint;

    #[test]
    fn parse_failure_hint_51_and_chain() {
        let stderr = "At line:1 char:8\n+ echo a && echo b\n+        ~~\nThe token '&&' is not a valid statement separator in this version.";
        let h = parse_failure_hint(Some(1), stderr).expect("hint");
        assert!(h.contains("5.1"), "{h}");
        assert!(h.contains("`&&`"), "{h}");
        assert!(!h.contains("backtick-quote"), "5.1 hint must be distinct from general bash-escape coaching: {h}");
    }

    #[test]
    fn parse_failure_hint_bash_escape() {
        let h = parse_failure_hint(
            Some(1),
            "The string is missing the terminator: \".",
        )
        .expect("hint");
        assert!(h.contains("backtick-quote"), "{h}");
        assert!(h.contains("PowerShell, NOT bash"), "{h}");
    }

    #[test]
    fn parse_failure_hint_unexpected_token_iex_variant() {
        // iex+catch turns 5.1's ParserError into a non-terminating error with
        // the phrase "An expression was expected"; verify the detection still
        // catches it so the coaching fires.
        let h = parse_failure_hint(
            Some(1),
            "An expression was expected after '('.",
        )
        .expect("hint");
        assert!(h.contains("PowerShell failed to parse"), "{h}");
    }

    #[test]
    fn parse_failure_hint_ignores_normal_failures() {
        // Nonzero from a real application (tsc, cargo) is NOT a parse error.
        assert!(parse_failure_hint(Some(2), "test suite failed: 3 tests").is_none());
        // A zero exit never triggers, even with scary-looking text.
        assert!(parse_failure_hint(Some(0), "unexpected token nonsense").is_none());
        // Timed-out runs (None) skip coaching entirely — a truncated command
        // may have coincidentally emitted "parse error" in output.
        assert!(parse_failure_hint(None, "The token '&&' is not a valid statement separator").is_none());
    }
}
