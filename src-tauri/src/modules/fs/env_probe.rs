//! Verified environment inventory — probed once per process launch, cached in
//! Tauri state, injected into the agent's <env> block.
//!
//! Why: every agent session used to burn 3-6 shell calls probing "what's
//! installed?", and the answers were sometimes WRONG (winget exists but
//! wasn't on a preview-shell PATH; the agent shell is pwsh 7 while the prompt
//! said 5.1). A wrong assumption poisons every downstream decision — worse
//! than the wasted calls. The Rust side is ground truth: it probes the real
//! PATH and the real shell binaries.

use std::sync::Mutex;
use tauri::State;

#[derive(Clone, serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolProbe {
    pub name: String,
    pub present: bool,
    pub version: Option<String>,
    /// Resolved absolute path, when present.
    pub path: Option<String>,
}

#[derive(Clone, serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EnvInventory {
    /// The shell binary name the ONE-SHOT agent shell will actually use
    /// (pwsh / powershell / cmd on Windows, $SHELL basename on Unix).
    pub shell: String,
    /// `$PSVersionTable.PSVersion` for PowerShell shells, else the binary's
    /// --version first line.
    pub shell_version: Option<String>,
    pub tools: Vec<ToolProbe>,
    /// Wall-clock ms the probe took (diagnostics).
    pub probe_ms: u64,
}

/// Tools whose presence changes what the agent should attempt. Short list —
/// each probe spawns a process for the version string, so keep it to things
/// that genuinely alter behavior.
const PROBED_TOOLS: &[&str] = &[
    "git", "node", "npm", "pnpm", "python", "pip", "cargo", "rustc", "go",
    "docker", "ffmpeg", "uv", "deno", "bun", "7z",
];

/// First line of a command's output, trimmed. `None` on spawn failure or
/// timeout. Uses a short timeout — a hung probe must not stall launch.
fn run_capture(exe: &str, args: &[&str], timeout_ms: u64) -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW — probing must not flash consoles on Windows.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().ok()?;

    let start = Instant::now();
    // Drain both pipes on this thread until exit or deadline. The processes
    // are tiny (--version); read_to_end on stdout then stderr is enough,
    // guarded by the timeout poll.
    let mut out: Vec<u8> = Vec::new();
    let mut err_buf: Vec<u8> = Vec::new();
    loop {
        if let Some(stdout) = child.stdout.as_mut() {
            let _ = stdout.read_to_end(&mut out);
        }
        if let Some(stderr) = child.stderr.as_mut() {
            let _ = stderr.read_to_end(&mut err_buf);
        }
        if start.elapsed().as_millis() as u64 > timeout_ms {
            let _ = child.kill();
            return None;
        }
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(15)),
            Err(_) => return None,
        }
    }

    let text = if !out.is_empty() { out } else { err_buf };
    let first = String::from_utf8_lossy(&text).lines().next()?.trim().to_string();
    if first.is_empty() { None } else { Some(first) }
}

/// Windows uses PATHEXT-aware lookup; fall back to `.exe` only. On Unix,
/// plain `which`-style lookup against the PATH KAI actually runs with.
fn which(name: &str) -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    {
        for ext in [".exe", ".cmd", ".bat", ""] {
            let try_name = if ext.is_empty() { name.to_string() } else { format!("{name}{ext}") };
            if let Some(p) = which_in_path(&try_name) {
                return Some(p);
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        which_in_path(name)
    }
}

fn which_in_path(name: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// The shell the agent one-shot commands run through — mirrors the
/// pty::shell_init selection chain (pwsh → powershell → cmd) so the env
/// block reports the shell the AGANT uses, not the user's interactive one.
fn agent_shell() -> (String, Option<String>) {
    #[cfg(windows)]
    {
        if let Some(p) = which("pwsh") {
            let ver = run_capture(
                &p.to_string_lossy(),
                &["-NoProfile", "-NoLogo", "-Command", "$PSVersionTable.PSVersion.ToString()"],
                3_000,
            );
            return ("pwsh".into(), ver);
        }
        let sys = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| "C:\\Windows".into());
        let winps = sys.join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
        if winps.is_file() {
            let ver = run_capture(
                &winps.to_string_lossy(),
                &["-NoProfile", "-NoLogo", "-Command", "$PSVersionTable.PSVersion.ToString()"],
                3_000,
            );
            return ("powershell".into(), ver);
        }
        ("cmd".into(), None)
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let base = std::path::Path::new(&shell)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "bash".into());
        let ver = run_capture(&shell, &["--version"], 3_000);
        (base, ver)
    }
}

fn probe() -> EnvInventory {
    let start = std::time::Instant::now();
    let (shell, shell_version) = agent_shell();
    let mut tools = Vec::with_capacity(PROBED_TOOLS.len());
    for name in PROBED_TOOLS {
        match which(name) {
            Some(p) => {
                // Version args per tool family — `--version` covers almost
                // everything; `go` and `pip` prefer subcommands.
                let ver_args: &[&str] = match *name {
                    "go" => &["version"],
                    "python" | "python3" => &["--version"],
                    _ => &["--version"],
                };
                let version = run_capture(&p.to_string_lossy(), ver_args, 2_500);
                tools.push(ToolProbe {
                    name: (*name).into(),
                    present: true,
                    version,
                    path: Some(p.to_string_lossy().into_owned()),
                });
            }
            None => tools.push(ToolProbe {
                name: (*name).into(),
                present: false,
                version: None,
                path: None,
            }),
        }
    }
    EnvInventory {
        shell,
        shell_version,
        tools,
        probe_ms: start.elapsed().as_millis() as u64,
    }
}

/// Caches the probe result per process lifetime. First call runs the probe
/// (a few hundred ms); every later call is instant.
#[tauri::command]
pub fn fs_env_inventory(cache: State<'_, Mutex<Option<EnvInventory>>>) -> EnvInventory {
    let mut guard = crate::modules::lock::mutex_lock(&cache);
    if let Some(inv) = guard.clone() {
        return inv;
    }
    let inv = probe();
    *guard = Some(inv.clone());
    inv
}
