//! Internal credential vault — project-independent secrets (tokens, keys,
//! passwords, env values) the agent can USE without ever SEEING them.
//!
//! DESIGN (2026-11-18, minimal implementation per user spec):
//!
//! - **Storage**: OS keyring via the proven `secrets.rs` machinery — one
//!   keyring entry per vault name under the dedicated service `kai-vault`
//!   (never `kai`, so vault entries can't collide with provider API keys).
//!   Windows Credential Manager / macOS Keychain encrypt at rest; Linux rides
//!   the Secret Service with the file fallback (same honest reporting via
//!   `secrets_backend_info`).
//! - **Index**: a tiny JSON file (`vault-index.json`, app-local-data) holds
//!   ONLY names + timestamps — never values. Keyring enumeration is
//!   unavailable cross-platform (the Linux file backend has no list op and
//!   Credential Manager enumeration is Win32-only), so an explicit index is
//!   the portable way to list entries for the Security panel and `vault_list`.
//! - **Value flow — the core invariant**: values are resolved in THIS
//!   process, at child-spawn time, into the child's environment. They NEVER
//!   cross the IPC boundary toward the webview on any agent-facing path.
//!   The agent only ever sees the literal reference string `vault:NAME`.
//! - **Writes are UI-ONLY** (user decision, 2026-11-18): there is NO
//!   vault_set/vault_delete tool and no agent-writable path — a secret the
//!   agent could store would also live in the chat transcript on disk. The
//!   user adds/edits entries in Settings → Security; the agent can only
//!   discover NAMES (metadata) and reference them.
//! - **Echo masking**: if a command prints a vault value (`env`, `set -x`,
//!   a leaked URL), the stdout/stderr of that child is masked IN RUST before
//!   the result returns to the webview — the same invariant, one layer below
//!   the JS redaction table.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const VAULT_SERVICE: &str = "kai-vault";

/// Reference prefix agents write in `env` values: `vault:HF_TOKEN`.
pub const VAULT_REF_PREFIX: &str = "vault:";

// ── Index (names + timestamps only — NEVER values) ─────────────────────────

#[derive(Serialize, Deserialize, Default)]
struct VaultIndex {
    /// name → unix-ms updated-at.
    entries: HashMap<String, u64>,
}

pub struct VaultState {
    index: Mutex<VaultIndex>,
    /// Resolved values cached for the process lifetime (spawn-path latency
    /// stays one map lookup; a user edit requires an app restart to take
    /// effect — acceptable for the minimal implementation, and the set path
    /// can bump entries later if staleness ever matters).
    cache: Mutex<HashMap<String, String>>,
}

impl Default for VaultState {
    fn default() -> Self {
        Self {
            index: Mutex::new(VaultIndex::default()),
            cache: Mutex::new(HashMap::new()),
        }
    }
}

fn index_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("vault-index.json"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load_index(state: &VaultState, app: &AppHandle) -> Result<(), String> {
    let mut guard = crate::modules::lock::mutex_lock(&state.index);
    if !guard.entries.is_empty() {
        return Ok(());
    }
    let path = index_path(app)?;
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(());
    };
    match serde_json::from_slice::<VaultIndex>(&bytes) {
        Ok(idx) => *guard = idx,
        // Corrupt index: names can be re-added by the user; values are safe
        // in the keyring. Never hard-fail the app over an index read.
        Err(e) => log::warn!("[kai:vault] index unreadable, starting empty: {e}"),
    }
    Ok(())
}

fn write_index(state: &VaultState, app: &AppHandle) -> Result<(), String> {
    let guard = crate::modules::lock::mutex_lock(&state.index);
    let path = index_path(app)?;
    let bytes = serde_json::to_vec(&*guard).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

// ── Value resolution (in-process only) ─────────────────────────────────────

/// Resolve one vault name to its value, through the per-process cache.
/// Returns Err (not None) on a backend failure so callers can distinguish
/// "no such entry" from "keyring broken".
fn resolve_value(state: &VaultState, name: &str) -> Result<String, String> {
    {
        let cache = crate::modules::lock::mutex_lock(&state.cache);
        if let Some(v) = cache.get(name) {
            return Ok(v.clone());
        }
    }
    let entry = keyring::Entry::new(VAULT_SERVICE, name).map_err(|e| e.to_string())?;
    let value = entry.get_password().map_err(|e| e.to_string())?;
    crate::modules::lock::mutex_lock(&state.cache).insert(name.to_string(), value.clone());
    Ok(value)
}

/// Expand `env: { VAR: "vault:NAME" }` into literal values for a child.
/// Non-`vault:` values pass through untouched (the plain-env case). Unknown
/// names are an ERROR, not an empty string: silently exporting an unset var
/// makes the child fail in a way the model can't diagnose.
///
/// The AppHandle parameter is kept for signature stability with the Tauri
/// command layer even though resolution currently needs no app paths.
pub fn resolve_env_refs(
    _app: &AppHandle,
    state: &VaultState,
    env: Option<HashMap<String, String>>,
) -> Result<Option<HashMap<String, String>>, String> {
    let Some(env) = env else { return Ok(None) };
    if env.is_empty() {
        return Ok(None);
    }
    let mut out = HashMap::with_capacity(env.len());
    for (k, v) in env {
        if let Some(name) = v.strip_prefix(VAULT_REF_PREFIX) {
            out.insert(k, resolve_value(state, name)?);
        } else {
            out.insert(k, v);
        }
    }
    Ok(Some(out))
}

// ── Echo masking (stdout/stderr of a child that got vault values) ──────────

/// Replace every occurrence of every injected value in `text` with
/// `<vault:VAR>`. Applied to a child's captured streams when the command
/// ran with vault-injected env, so `env`/`set -x` style echoes never reach
/// the webview. Whole-value matching (not regex): vault values are opaque.
/// Stateless on purpose — the caller supplies the resolved values, so this
/// works from any spawn path without threading VaultState through the
/// worker threads.
///
/// Values shorter than 4 chars are skipped: blanket-replacing 1-3 char
/// strings mangles ordinary output for no secrecy gain.
pub fn mask_vault_values(text: &str, injected: &HashMap<String, String>) -> String {
    if text.is_empty() || injected.is_empty() {
        return text.to_string();
    }
    let mut out = text.to_string();
    for (var, value) in injected {
        // The literal value maps to the VAR name it was injected as — more
        // useful in output than the vault entry name.
        if value.len() >= 4 && out.contains(value.as_str()) {
            out = out.replace(value.as_str(), &format!("<vault:{var}>"));
        }
    }
    out
}

// ── Tauri commands ─────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct VaultEntryInfo {
    pub name: String,
    pub updated_at: u64,
}

/// List vault entries: NAMES + timestamps only. Values never leave Rust.
#[tauri::command]
pub async fn vault_list(
    app: AppHandle,
    state: tauri::State<'_, VaultState>,
) -> Result<Vec<VaultEntryInfo>, String> {
    load_index(&state, &app)?;
    let index = crate::modules::lock::mutex_lock(&state.index);
    let mut out: Vec<VaultEntryInfo> = index
        .entries
        .iter()
        .map(|(name, updated_at)| VaultEntryInfo {
            name: name.clone(),
            updated_at: *updated_at,
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Store a vault entry. UI-only path (Settings → Security); the agent has no
/// tool for this — secrets must not transit the chat transcript.
#[tauri::command]
pub async fn vault_set(
    app: AppHandle,
    state: tauri::State<'_, VaultState>,
    name: String,
    value: String,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("vault entry name is empty".into());
    }
    // Names become keyring accounts AND part of `vault:NAME` references the
    // model types — keep them identifier-safe so references never need
    // quoting in a shell.
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(
            "vault entry names may contain only letters, digits, _ and -".into(),
        );
    }
    if value.trim().is_empty() {
        return Err("vault entry value is empty".into());
    }
    let entry = keyring::Entry::new(VAULT_SERVICE, &name).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())?;
    crate::modules::lock::mutex_lock(&state.index)
        .entries
        .insert(name.clone(), now_ms());
    // Drop any cached stale value so a re-resolve reads the fresh one.
    crate::modules::lock::mutex_lock(&state.cache).remove(&name);
    write_index(&state, &app)
}

/// Delete a vault entry (UI-only path).
#[tauri::command]
pub async fn vault_delete(
    app: AppHandle,
    state: tauri::State<'_, VaultState>,
    name: String,
) -> Result<(), String> {
    let entry = keyring::Entry::new(VAULT_SERVICE, &name).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(e.to_string()),
    }
    crate::modules::lock::mutex_lock(&state.index).entries.remove(&name);
    crate::modules::lock::mutex_lock(&state.cache).remove(&name);
    write_index(&state, &app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_replaces_injected_values() {
        let injected = HashMap::from([
            ("HF_TOKEN".to_string(), "hf_secret123".to_string()),
        ]);
        let masked = mask_vault_values(
            "HF_TOKEN=hf_secret123 and standalone hf_secret123 too",
            &injected,
        );
        assert_eq!(masked, "HF_TOKEN=<vault:HF_TOKEN> and standalone <vault:HF_TOKEN> too");
    }

    #[test]
    fn mask_leaves_clean_text_untouched() {
        let injected = HashMap::from([("K".to_string(), "value9".to_string())]);
        let text = "nothing to see here";
        assert_eq!(mask_vault_values(text, &injected), text);
    }

    #[test]
    fn mask_skips_tiny_values() {
        // 3-char values are too collision-prone to blanket-replace.
        let injected = HashMap::from([("K".to_string(), "abc".to_string())]);
        let text = "abcdefg";
        assert_eq!(mask_vault_values(text, &injected), text);
    }
}
