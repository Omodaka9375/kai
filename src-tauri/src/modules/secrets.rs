//! Secret storage with platform-appropriate backends.
//!
//! - **macOS**: macOS Keychain (via `keyring` crate) — encrypted at rest.
//! - **Windows**: Credential Manager (via `keyring` crate) — encrypted per-user.
//! - **Linux**: native Secret Service (gnome-keyring / kwallet) when one is
//!   actually reachable, else a plaintext JSON file at `app_local_data_dir()/
//!   secrets.json`, mode 0600. We PROBE the real service before trusting it:
//!   the historical reason this module shipped a file backend is that the
//!   Secret Service silently fails on systems without a keyring daemon —
//!   constructing an Entry touches nothing, so the probe writes, reads back
//!   and deletes a canary credential against the live D-Bus service. Only a
//!   full round-trip counts as "reachable".
//!
//!   When the Secret Service answers, existing file-stored keys migrate into
//!   it and the plaintext file is deleted only after every entry migrated.
//!   Any migration error keeps the file (a stale file beats a lost key).
//!
//!   **SECURITY NOTE (Linux)**: when no keyring daemon is available, API keys
//!   are stored as plaintext JSON on disk; same-user processes can read them.
//!   `secrets_backend_info` lets the UI state which mode is active honestly.
//!
//! The frontend talks to `secrets_get`, `secrets_set`, `secrets_delete`,
//! `secrets_get_all`, and `secrets_backend_info` — no platform branching in JS.

use std::sync::Mutex;

use tauri::AppHandle;

#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "linux")]
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use tauri::Manager;

/// One-time Linux backend resolution. `Keyring` is only produced when the
/// canary credential genuinely round-tripped through the Secret Service.
#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
enum Backend {
    /// Secret Service verified reachable (canary write→read→delete succeeded).
    Keyring,
    /// No usable Secret Service — file fallback (pre-existing behavior).
    File,
}

#[derive(Default)]
pub struct SecretsState {
    #[cfg(target_os = "linux")]
    backend: Mutex<Option<Backend>>,
    #[cfg(target_os = "linux")]
    cache: Mutex<Option<HashMap<String, String>>>,
    #[cfg(not(target_os = "linux"))]
    _phantom: Mutex<()>,
}

#[cfg(target_os = "linux")]
fn key(service: &str, account: &str) -> String {
    format!("{}::{}", service, account)
}

/// "service::account" → parts. Tolerates legacy keys without "::" by
/// treating the whole string as an account under the default service.
#[cfg(target_os = "linux")]
fn split_key(k: &str) -> (String, String) {
    match k.split_once("::") {
        Some((service, account)) => (service.to_string(), account.to_string()),
        None => ("kai".to_string(), k.to_string()),
    }
}

#[cfg(target_os = "linux")]
fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("secrets.json"))
}

#[cfg(target_os = "linux")]
fn read_store(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    serde_json::from_slice::<HashMap<String, String>>(&bytes).map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn write_store(app: &AppHandle, map: &HashMap<String, String>) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let path = store_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(map).map_err(|e| e.to_string())?;

    // 0600: only the owning user can read or write the secrets file.
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn with_store<F, R>(app: &AppHandle, state: &SecretsState, f: F) -> Result<R, String>
where
    F: FnOnce(&mut HashMap<String, String>) -> R,
{
    let mut guard = state.cache.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(read_store(app)?);
    }
    let map = guard.as_mut().expect("cache initialized above");
    Ok(f(map))
}

/// Canary round-trip: write, read back, delete. Only a full cycle proves the
/// daemon actually answered — Entry::new alone proves nothing (it is pure
/// construction), and a get-only probe can succeed against a stale cache.
#[cfg(target_os = "linux")]
fn probe_secret_service() -> bool {
    const SERVICE: &str = "kai-backend-probe";
    const ACCOUNT: &str = "canary";
    const VALUE: &str = "kai-probe-value";
    let ok = (|| -> Result<(), keyring::Error> {
        let entry = keyring::Entry::new(SERVICE, ACCOUNT)?;
        entry.set_password(VALUE)?;
        let readback = entry.get_password()?;
        if readback != VALUE {
            // TooLong(String, u32): name + offending length.
            return Err(keyring::Error::TooLong(
                format!("canary readback mismatch: {readback:?}"),
                readback.len() as u32,
            ));
        }
        entry.delete_credential()?;
        Ok(())
    })()
    .is_ok();
    log::info!("[kai:secrets] secret service probe finished, reachable={}", ok);
    ok
}

/// Migrate file-store entries into the Secret Service. The plaintext file is
/// deleted ONLY when every entry migrated cleanly; on any error the file
/// survives (a stale file beats a lost key).
#[cfg(target_os = "linux")]
fn migrate_file_to_keyring(app: &AppHandle) -> Result<(), String> {
    let map = read_store(app)?;
    if map.is_empty() {
        // Nothing to migrate; still remove the (empty) file so its mere
        // existence doesn't misreport the storage mode.
        let path = store_path(app)?;
        if path.exists() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    for (k, v) in &map {
        let (service, account) = split_key(k);
        let entry = keyring::Entry::new(&service, &account).map_err(|e| e.to_string())?;
        match entry.get_password() {
            // Already migrated on a previous run — skip, don't overwrite.
            Ok(_) => continue,
            Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format!("keyring read during migration: {e}")),
        }
        entry.set_password(v).map_err(|e| format!("keyring write during migration: {e}"))?;
    }
    let path = store_path(app)?;
    fs::remove_file(&path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Resolve (and cache) the backend. The probe result is sticky for the
/// process lifetime: D-Bus availability doesn't flip mid-session, and
/// re-probing on every secrets_get would put a canary write on the hot path.
#[cfg(target_os = "linux")]
fn resolve_backend(app: &AppHandle, state: &SecretsState) -> Result<Backend, String> {
    let mut guard = state.backend.lock().map_err(|e| e.to_string())?;
    if let Some(b) = *guard {
        return Ok(b);
    }
    let backend = if probe_secret_service() {
        // Migration failure must NOT crash keyring mode: the daemon IS
        // reachable (probe proved it); a failed migration leaves the file,
        // which the file-fallback read path below still honors.
        if let Err(e) = migrate_file_to_keyring(app) {
            log::warn!("[kai:secrets] keyring migration failed; file kept: {e}");
        }
        Backend::Keyring
    } else {
        Backend::File
    };
    *guard = Some(backend);
    Ok(backend)
}

#[cfg(not(target_os = "linux"))]
fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, account).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct SecretBackendInfo {
    pub backend: &'static str,
    pub encrypted: bool,
}

/// Storage mode for the Security panel ("keys stored in: ...").
#[tauri::command]
pub async fn secrets_backend_info(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
) -> Result<SecretBackendInfo, String> {
    #[cfg(target_os = "linux")]
    {
        let backend = resolve_backend(&app, &state)?;
        Ok(match backend {
            Backend::Keyring => SecretBackendInfo { backend: "secret-service", encrypted: true },
            Backend::File => SecretBackendInfo { backend: "file", encrypted: false },
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        Ok(if cfg!(target_os = "macos") {
            SecretBackendInfo { backend: "keychain", encrypted: true }
        } else {
            SecretBackendInfo { backend: "credential-manager", encrypted: true }
        })
    }
}

#[tauri::command]
pub async fn secrets_get(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "linux")]
    {
        match resolve_backend(&app, &state)? {
            Backend::Keyring => match keyring::Entry::new(&service, &account) {
                Ok(entry) => match entry.get_password() {
                    Ok(v) => Ok(Some(v)),
                    Err(keyring::Error::NoEntry) => Ok(None),
                    // Keyring degraded mid-session (e.g. daemon died after
                    // the probe): serve from the file if it still exists so
                    // a key is never lost to a backend flap.
                    Err(err) => {
                        log::warn!("[kai:secrets] keyring read failed; falling back to file: {err}");
                        with_store(&app, &state, |m| m.get(&key(&service, &account)).cloned())
                    }
                },
                Err(_) => with_store(&app, &state, |m| m.get(&key(&service, &account)).cloned()),
            },
            Backend::File => with_store(&app, &state, |m| m.get(&key(&service, &account)).cloned()),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        let e = entry(&service, &account)?;
        match e.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    }
}

#[tauri::command]
pub async fn secrets_set(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
    password: String,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        match resolve_backend(&app, &state)? {
            Backend::Keyring => {
                let entry = keyring::Entry::new(&service, &account).map_err(|e| e.to_string())?;
                entry.set_password(&password).map_err(|e| e.to_string())
                // Deliberately NOT mirrored to the file: keys must not
                // linger in plaintext once the keyring is active.
            }
            Backend::File => {
                let k = key(&service, &account);
                with_store(&app, &state, |m| {
                    m.insert(k, password);
                })?;
                let snapshot = {
                    let guard = state.cache.lock().map_err(|e| e.to_string())?;
                    guard.as_ref().cloned().unwrap_or_default()
                };
                write_store(&app, &snapshot)
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        let e = entry(&service, &account)?;
        e.set_password(&password).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn secrets_delete(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        match resolve_backend(&app, &state)? {
            Backend::Keyring => {
                let entry = keyring::Entry::new(&service, &account).map_err(|e| e.to_string())?;
                match entry.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(err) => Err(err.to_string()),
                }
            }
            Backend::File => {
                let k = key(&service, &account);
                with_store(&app, &state, |m| {
                    m.remove(&k);
                })?;
                let snapshot = {
                    let guard = state.cache.lock().map_err(|e| e.to_string())?;
                    guard.as_ref().cloned().unwrap_or_default()
                };
                write_store(&app, &snapshot)
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        let e = entry(&service, &account)?;
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }
}

/// Batch read — single IPC roundtrip for the cold-boot fan-out.
#[tauri::command]
pub async fn secrets_get_all(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    accounts: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    #[cfg(target_os = "linux")]
    {
        match resolve_backend(&app, &state)? {
            Backend::Keyring => {
                // Per-account reads over D-Bus; NoEntry → None. A failed
                // entry read does NOT abort the batch (one bad account must
                // not blank every key at boot).
                Ok(accounts
                    .iter()
                    .map(|a| {
                        keyring::Entry::new(&service, a).ok().and_then(|e| e.get_password().ok())
                    })
                    .collect())
            }
            Backend::File => with_store(&app, &state, |m| {
                accounts
                    .iter()
                    .map(|a| m.get(&key(&service, a)).cloned())
                    .collect()
            }),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        Ok(accounts
            .into_iter()
            .map(|a| {
                keyring::Entry::new(&service, &a)
                    .ok()
                    .and_then(|e| e.get_password().ok())
            })
            .collect())
    }
}
