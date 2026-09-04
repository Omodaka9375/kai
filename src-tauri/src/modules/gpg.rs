//! GPG signing-key discovery for git commit signing.
//!
//! KAI never generates or reads private key material. This module only:
//!   - detects the `gpg` binary (host or inside WSL),
//!   - lists secret keys already present in the user's keyring,
//!   - exports a key's PUBLIC armored block for pasting into GitHub.
//!
//! Day-to-day unlocking is delegated to `gpg-agent` / pinentry, exactly like
//! signing from a terminal. Commands thread `WorkspaceEnv` so a WSL repo
//! resolves its gpg inside the WSL distro while a local repo uses the host gpg.

use std::process::{Command, Output};

use serde::Serialize;

use crate::modules::workspace::{validate_wsl_distro_name, WorkspaceEnv};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpgStatus {
    pub available: bool,
    pub program: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpgKey {
    pub fingerprint: String,
    pub key_id: String,
    pub name: String,
    pub emails: Vec<String>,
}

fn decode(bytes: Vec<u8>) -> String {
    #[cfg(windows)]
    {
        crate::modules::workspace::decode_command_output(&bytes)
    }
    #[cfg(not(windows))]
    {
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

fn run_gpg(workspace: &WorkspaceEnv, program: &str, args: &[&str]) -> Result<Output, String> {
    let mut cmd = if let WorkspaceEnv::Wsl { distro } = workspace {
        #[cfg(windows)]
        validate_wsl_distro_name(distro)?;
        let mut c = Command::new("wsl.exe");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        c.arg("-d").arg(distro).arg("--exec").arg(program);
        c
    } else {
        let mut c = Command::new(program);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        c
    };
    cmd.args(args)
        .env("LC_ALL", "C")
        .output()
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn detect_local_program() -> Option<String> {
    const CANDIDATES: &[&str] = &[
        "gpg",
        r"C:\Program Files\Git\usr\bin\gpg.exe",
        r"C:\Program Files\GnuPG\bin\gpg.exe",
        r"C:\Program Files (x86)\GnuPG\bin\gpg.exe",
    ];
    for candidate in CANDIDATES {
        if let Ok(out) = Command::new(candidate).arg("--version").output() {
            if out.status.success() {
                return Some((*candidate).to_string());
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn detect_local_program() -> Option<String> {
    Command::new("gpg")
        .arg("--version")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|_| "gpg".to_string())
}

fn resolve_program(workspace: &WorkspaceEnv) -> Option<String> {
    if workspace.is_wsl() {
        Some("gpg".to_string())
    } else {
        detect_local_program()
    }
}

fn parse_version(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .find(|l| !l.trim().is_empty())
        .and_then(|l| l.split_whitespace().last())
        .map(|s| s.trim_end_matches('.').to_string())
}

fn is_fingerprint(s: &str) -> bool {
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    cleaned.len() == 40 && cleaned.chars().all(|c| c.is_ascii_hexdigit())
}

fn parse_uid(raw: &str) -> (String, String) {
    let email = raw
        .rsplit('<')
        .next()
        .and_then(|s| s.split('>').next())
        .unwrap_or("")
        .trim()
        .to_string();
    let name = raw
        .split('<')
        .next()
        .unwrap_or(raw)
        .trim()
        .trim_matches(|c| c == '(' || c == ')')
        .trim()
        .to_string();
    (name, email)
}

fn parse_keys(stdout: &str) -> Vec<GpgKey> {
    let mut keys: Vec<GpgKey> = Vec::new();
    let mut current: Option<GpgKey> = None;

    for line in stdout.lines() {
        let fields: Vec<&str> = line.split(':').collect();
        let typ = fields.first().copied().unwrap_or("");
        if typ == "sec" || typ.starts_with("sec#") {
            if let Some(k) = current.take() {
                keys.push(k);
            }
            let key_id = fields.get(4).copied().unwrap_or("").to_string();
            current = Some(GpgKey {
                fingerprint: String::new(),
                key_id,
                name: String::new(),
                emails: Vec::new(),
            });
        } else if typ == "fpr" {
            if let Some(k) = current.as_mut() {
                if k.fingerprint.is_empty() {
                    k.fingerprint = fields.get(9).copied().unwrap_or("").to_string();
                }
            }
        } else if typ == "uid" {
            if let Some(k) = current.as_mut() {
                let raw = fields.get(9).copied().unwrap_or("");
                let (name, email) = parse_uid(raw);
                if !name.is_empty() && k.name.is_empty() {
                    k.name = name;
                }
                if !email.is_empty() && !k.emails.iter().any(|e| e == &email) {
                    k.emails.push(email);
                }
            }
        }
    }
    if let Some(k) = current {
        keys.push(k);
    }
    keys.retain(|k| !k.fingerprint.is_empty());
    keys
}

#[tauri::command]
pub async fn gpg_status(workspace: Option<WorkspaceEnv>) -> Result<GpgStatus, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    tauri::async_runtime::spawn_blocking(move || status_inner(&workspace))
        .await
        .map_err(|e| e.to_string())?
}

fn status_inner(workspace: &WorkspaceEnv) -> Result<GpgStatus, String> {
    let Some(program) = resolve_program(workspace) else {
        return Ok(GpgStatus {
            available: false,
            program: None,
            version: None,
            error: Some(
                "gpg not found. Install GnuPG (Gpg4win on Windows, `brew install gnupg` on macOS)."
                    .into(),
            ),
        });
    };
    match run_gpg(workspace, &program, &["--version"]) {
        Ok(out) if out.status.success() => Ok(GpgStatus {
            available: true,
            program: Some(program),
            version: parse_version(&decode(out.stdout)),
            error: None,
        }),
        Ok(out) => Ok(GpgStatus {
            available: false,
            program: Some(program),
            version: None,
            error: Some(decode(out.stderr).trim().to_string()),
        }),
        Err(e) => Ok(GpgStatus {
            available: false,
            program: Some(program),
            version: None,
            error: Some(e),
        }),
    }
}

#[tauri::command]
pub async fn gpg_list_keys(workspace: Option<WorkspaceEnv>) -> Result<Vec<GpgKey>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    tauri::async_runtime::spawn_blocking(move || list_keys_inner(&workspace))
        .await
        .map_err(|e| e.to_string())?
}

fn list_keys_inner(workspace: &WorkspaceEnv) -> Result<Vec<GpgKey>, String> {
    let program = resolve_program(workspace)
        .ok_or_else(|| "gpg not found".to_string())?;
    let out = run_gpg(workspace, &program, &["--list-secret-keys", "--with-colons"])?;
    if !out.status.success() {
        return Err(decode(out.stderr).trim().to_string());
    }
    Ok(parse_keys(&decode(out.stdout)))
}

#[tauri::command]
pub async fn gpg_export_public(
    fingerprint: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<String, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    tauri::async_runtime::spawn_blocking(move || export_public_inner(&fingerprint, &workspace))
        .await
        .map_err(|e| e.to_string())?
}

fn export_public_inner(fingerprint: &str, workspace: &WorkspaceEnv) -> Result<String, String> {
    if !is_fingerprint(fingerprint) {
        return Err("invalid fingerprint".to_string());
    }
    let program = resolve_program(workspace)
        .ok_or_else(|| "gpg not found".to_string())?;
    let out = run_gpg(workspace, &program, &["--armor", "--export", fingerprint])?;
    if !out.status.success() {
        return Err(decode(out.stderr).trim().to_string());
    }
    Ok(decode(out.stdout))
}

#[cfg(test)]
mod tests {
    use super::{is_fingerprint, parse_keys, parse_uid, parse_version};

    #[test]
    fn validates_fingerprints() {
        assert!(is_fingerprint("0123456789ABCDEF0123456789ABCDEF01234567"));
        assert!(is_fingerprint(" 0123 4567 89AB CDEF 0123 4567 89AB CDEF 0123 4567 "));
        assert!(!is_fingerprint("short"));
        assert!(!is_fingerprint("zzzz456789ABCDEF0123456789ABCDEF01234567"));
    }

    #[test]
    fn parses_version_line() {
        assert_eq!(parse_version("gpg (GnuPG) 2.4.5"), Some("2.4.5".into()));
        assert_eq!(parse_version("gpg (GnuPG) 2.4.5\nlibgcrypt 1.10.3"), Some("2.4.5".into()));
    }

    #[test]
    fn parses_uid() {
        let (name, email) = parse_uid("Alice Example <alice@example.com>");
        assert_eq!(name, "Alice Example");
        assert_eq!(email, "alice@example.com");
    }

    #[test]
    fn parses_secret_key_listing() {
        let stdout = concat!(
            "sec:u:255:22:1A2B3C4D5E6F7081:1690000000::u:::cESCA:::#::ed25519:::\n",
            "fpr:::::::::0123456789ABCDEF0123456789ABCDEF01234567:\n",
            "uid:u::::1690000000::HASH::Alice <alice@example.com>:\n",
            "ssb:u:255:22:AAAAAAAAAAAAAAAA:1690000000:::::cESCA:::s::ed25519:::\n",
            "fpr:::::::::9999999999999999999999999999999999999999:\n",
        );
        let keys = parse_keys(stdout);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].fingerprint, "0123456789ABCDEF0123456789ABCDEF01234567");
        assert_eq!(keys[0].key_id, "1A2B3C4D5E6F7081");
        assert_eq!(keys[0].name, "Alice");
        assert_eq!(keys[0].emails, vec!["alice@example.com".to_string()]);
    }
}
