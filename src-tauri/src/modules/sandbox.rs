//! Agent sandbox — per-project execution policy for AI tools.
//!
//! Layered design (see KAI.md "Sandbox"):
//!   L1 policy      — this module: profiles (off/readOnly/workspaceOnly) that
//!                    gate fs mutations and annotate shell approvals.
//!   L2 OS-confinement — Landlock (Linux), sandbox-exec (macOS), WSL distro
//!                    (Windows). Detected by `sandbox_status`, enforced later.
//!   L3 shadow worktree, L4 devcontainer — future.
//!
//! Configuration lives in the project at `.kai/sandbox.json` (versioned,
//! user-authored — same philosophy as `.kai/rules`).

use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};

pub mod exec;
pub mod wsl;

use crate::modules::workspace::{resolve_path, WorkspaceEnv};

/// Sandboxing mode for the current project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SandboxMode {
    /// No sandboxing — current behavior.
    Off,
    /// Tools may read anywhere the security layer allows, but no writes
    /// outside the project. Agent shell commands get path analysis.
    ReadOnly,
    /// Reads AND writes confined to the project directory. Anything outside
    /// is rejected before the approval card.
    WorkspaceOnly,
}

impl SandboxMode {
    fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "off" | "" => Some(Self::Off),
            "readonly" | "read-only" => Some(Self::ReadOnly),
            "workspaceonly" | "workspace-only" => Some(Self::WorkspaceOnly),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::ReadOnly => "readOnly",
            Self::WorkspaceOnly => "workspaceOnly",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxConfig {
    pub mode: SandboxMode,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxStatus {
    /// Landlock LSM available (Linux, kernel >= 5.13) — L2 filesystem
    /// confinement without root.
    pub landlock: bool,
    /// bubblewrap available (Linux fallback for L2).
    pub bwrap: bool,
    /// sandbox-exec present (macOS Seatbelt, deprecated-but-functional).
    pub sandbox_exec: bool,
    /// WSL is installed with at least one distro (Windows L2 vehicle).
    pub wsl: bool,
    /// Docker present (L4 devcontainer vehicle).
    pub docker: bool,
    /// Kernel version string (Linux) for diagnostics.
    pub kernel: Option<String>,
}

fn probe(program: &str, arg: &str) -> bool {
    let mut cmd = Command::new(program);
    cmd.arg(arg);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

#[tauri::command]
pub fn sandbox_status() -> SandboxStatus {
    #[cfg(target_os = "linux")]
    let kernel = std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .ok()
        .map(|s| s.trim().to_string());
    #[cfg(not(target_os = "linux"))]
    let kernel = None;

    #[cfg(target_os = "linux")]
    let landlock = kernel
        .as_deref()
        .and_then(parse_kernel_version)
        .map(|(major, minor)| (major, minor) >= (5, 13))
        .unwrap_or(false);
    #[cfg(not(target_os = "linux"))]
    let landlock = false;

    #[cfg(target_os = "linux")]
    let bwrap = probe("bwrap", "--version");
    #[cfg(not(target_os = "linux"))]
    let bwrap = false;

    #[cfg(target_os = "macos")]
    let sandbox_exec = std::path::Path::new("/usr/bin/sandbox-exec").exists();
    #[cfg(not(target_os = "macos"))]
    let sandbox_exec = false;

    #[cfg(windows)]
    let wsl = probe("wsl.exe", "--status");
    #[cfg(not(windows))]
    let wsl = false;

    let docker = probe("docker", "--version");

    SandboxStatus {
        landlock,
        bwrap,
        sandbox_exec,
        wsl,
        docker,
        kernel,
    }
}

#[cfg(target_os = "linux")]
fn parse_kernel_version(s: &str) -> Option<(u32, u32)> {
    let first = s.split('-').next()?;
    let mut it = first.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    Some((major, minor))
}

fn config_path(root: &str, workspace: &WorkspaceEnv) -> PathBuf {
    resolve_path(&format!("{}/.kai/sandbox.json", root.trim_end_matches(['/','\\'])), workspace)
}

/// Load the project sandbox config. Missing file = Off. Malformed file = Off
/// plus a logged warning (never fail the boot over a bad config).
#[tauri::command]
pub fn sandbox_load_config(root: String, workspace: WorkspaceEnv) -> SandboxConfig {
    let path = config_path(&root, &workspace);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return SandboxConfig { mode: SandboxMode::Off };
    };
    #[derive(Deserialize)]
    struct Raw {
        mode: String,
    }
    match serde_json::from_str::<Raw>(&raw) {
        Ok(r) => match SandboxMode::parse(&r.mode) {
            Some(mode) => SandboxConfig { mode },
            None => {
                log::warn!("sandbox: unknown mode {:?} in {}", r.mode, path.display());
                SandboxConfig { mode: SandboxMode::Off }
            }
        },
        Err(e) => {
            log::warn!("sandbox: malformed {} — {e}", path.display());
            SandboxConfig { mode: SandboxMode::Off }
        }
    }
}

/// Persist the project sandbox config. Creates `.kai/` as needed.
#[tauri::command]
pub fn sandbox_save_config(root: String, mode: SandboxMode, workspace: WorkspaceEnv) -> Result<(), String> {
    let path = config_path(&root, &workspace);
    let parent = path
        .parent()
        .ok_or_else(|| format!("no parent dir: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    let json = format!("{{\n  \"mode\": \"{}\"\n}}\n", mode.as_str());
    std::fs::write(&path, json).map_err(|e| format!("write {}: {e}", path.display()))
}
