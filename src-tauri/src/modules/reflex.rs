//! Local reflex engine (Needle 3 `kai-desktop-v1`) — download, lifecycle, health.
//!
//! Layer: optional user-installed runtime, the same contract as `voice.rs`:
//! nothing ships in the installer; the engine + weights are downloaded ON
//! DEMAND into `app_local_data_dir()/reflex/` and spawned as a short-lived
//! child that serves `POST /complete` on a localhost port for the frontend's
//! pre-LLM fast path (`src/modules/ai/lib/localReflex.ts`).
//!
//! Components:
//!   reflex/cactus(.exe)     the <1 MB C++ engine from Cactus-Compute/cactus
//!   reflex/kai-desktop-v1-<depth>L.cact   the fine-tuned weights (22.5 MB @ 12L)
//!   reflex/narrow_tools.json  the 22-tool flat schema for the decode grammar
//!   reflex/manifest.json    version manifest — Run #4+ ships as a new
//!                           manifest version; the app re-downloads when it
//!                           sees a newer version than what's on disk.
//!
//! Fail-safe contract (same as voice/radio): every command degrades to a
//! clean error; a missing engine can never block a send (the frontend falls
//! through to the cloud LLM), and nothing here can hang the app.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Manager;

/// Versioned artifact source (Run #4 = bump both versions + hashes).
/// Files are served from the KAI release assets (GitHub latest download) so
/// no authenticated storage is involved.
const MANIFEST_URL: &str =
    "https://github.com/Omodaka9375/kai/releases/latest/download/reflex-manifest.json";

/// Allowed download origin prefix for manifest URLs (defense-in-depth so a
/// corrupted/redirected manifest cannot fetch arbitrary local/HTTP URLs).
const ALLOWED_URL_PREFIX: &str = "https://github.com/Omodaka9375/kai/releases/";

/// The shipped model depth (12L: bench-selected, see scripts/cactus/README.md).
const MODEL_DEPTH: u32 = 12;
const MODEL_NAME: &str = "kai-desktop-v1";

/// Guards concurrent `reflex_setup` downloads.
static SETUP_RUNNING: AtomicBool = AtomicBool::new(false);

/// Owned child handle so exit/remove can cleanly kill + wait without leaking
/// handles, creating Unix zombies, or signaling a reused PID.
static CHILD_PROC: std::sync::Mutex<Option<Child>> = std::sync::Mutex::new(None);

/// Serializes `/complete` + `/reset` requests against the single-conversation
/// cactus `--serve` process (both `reflex_classify` and `probe_health`), so
/// concurrent turns or status probes never interleave and poison KV state.
fn engine_io_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Serializes check-and-spawn in `reflex_ensure_running` so concurrent
/// callers never spawn duplicate `cactus` processes.
fn engine_spawn_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn reflex_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("reflex"))
}

fn engine_filename() -> &'static str {
    #[cfg(windows)]
    return "cactus.exe";
    #[cfg(not(windows))]
    "cactus"
}

fn engine_path(dir: &Path) -> PathBuf {
    dir.join(engine_filename())
}

fn model_path(dir: &Path) -> PathBuf {
    dir.join(format!("{MODEL_NAME}-{MODEL_DEPTH}L.cact"))
}

fn tools_path(dir: &Path) -> PathBuf {
    dir.join("narrow_tools.json")
}

fn manifest_path(dir: &Path) -> PathBuf {
    dir.join("manifest.json")
}

/// Platform key matching `scripts/cactus/publish_artifacts.py`.
fn current_platform_key() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "windows-x86_64";
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    return "windows-arm64";
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "macos-arm64";
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return "macos-x86_64";
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "linux-x86_64";
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return "linux-arm64";
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    return "unsupported";
}

/// Fixed localhost serve port; a conflict surfaces as a failed health probe
/// and a clean "engine unavailable" state.
const SERVE_PORT: u16 = 8941;

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReflexStatus {
    /// All three artifacts present on disk.
    pub installed: bool,
    /// Engine process is live and answering /complete.
    pub running: bool,
    /// Manifest version on disk (None = not installed yet).
    pub version: Option<String>,
    /// Latest manifest version upstream (None = fetch failed).
    pub latest_version: Option<String>,
    /// True when on-disk version != latest (an update is available).
    pub update_available: bool,
    /// True while a setup download is in flight.
    pub installing: bool,
    model_depth: u32,
    port: u16,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReflexSetupEvent {
    pub phase: String, // "engine" | "weights" | "tools" | "done" | "error"
    pub downloaded: u64,
    pub total: u64,
    pub message: Option<String>,
}

// ── Manifest handling ──────────────────────────────────────────────────────

#[derive(serde::Deserialize, serde::Serialize, Clone)]
pub struct EngineArtifact {
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub bytes: u64,
}

/// Matches `scripts/cactus/publish_artifacts.py` (`engines` map per platform),
/// while still accepting legacy flat `engine_url`/`engine_sha256` manifests.
#[derive(serde::Deserialize, serde::Serialize, Clone)]
pub struct ReflexManifest {
    pub version: String,
    #[serde(default)]
    pub engines: HashMap<String, EngineArtifact>,
    #[serde(default)]
    pub engine_url: Option<String>,
    #[serde(default)]
    pub engine_sha256: Option<String>,
    pub weights_url: String,
    pub weights_sha256: String,
    pub weights_bytes: u64,
    pub tools_url: String,
    pub tools_sha256: String,
}

impl ReflexManifest {
    fn resolve_engine(&self) -> Result<(String, String), String> {
        let plat = current_platform_key();
        if let Some(art) = self.engines.get(plat) {
            return Ok((art.url.clone(), art.sha256.clone()));
        }
        if let (Some(url), Some(sha)) = (&self.engine_url, &self.engine_sha256) {
            return Ok((url.clone(), sha.clone()));
        }
        Err(format!("no reflex engine binary published for platform {plat}"))
    }
}

fn read_manifest_disk(dir: &Path) -> Option<ReflexManifest> {
    let path = manifest_path(dir);
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Fast timeout for passive status checks so offline/slow GitHub never stalls
/// the Reflex settings panel for 20s; setup uses a longer budget.
async fn fetch_manifest(timeout: Duration) -> Result<ReflexManifest, String> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(MANIFEST_URL).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("manifest fetch failed: HTTP {}", resp.status()));
    }
    resp.json::<ReflexManifest>().await.map_err(|e| e.to_string())
}

fn validate_manifest_url(url: &str) -> Result<(), String> {
    if !url.starts_with(ALLOWED_URL_PREFIX) {
        return Err(format!("refusing untrusted reflex download URL: {url}"));
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

// ── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn reflex_status(app: tauri::AppHandle) -> Result<ReflexStatus, String> {
    let dir = reflex_dir(&app)?;
    let installed = engine_path(&dir).exists()
        && model_path(&dir).exists()
        && tools_path(&dir).exists();
    let disk_manifest = read_manifest_disk(&dir);
    let disk_version = disk_manifest.as_ref().map(|m| m.version.clone());
    // Short timeout on passive status refresh so offline launches stay snappy.
    let latest = fetch_manifest(Duration::from_secs(3)).await.ok();
    let running = installed && probe_health().await;
    Ok(ReflexStatus {
        installed,
        running,
        version: disk_version,
        latest_version: latest.as_ref().map(|m| m.version.clone()),
        update_available: match (&disk_manifest, &latest) {
            (Some(disk), Some(latest)) => disk.version != latest.version,
            _ => false,
        },
        installing: SETUP_RUNNING.load(Ordering::Acquire),
        model_depth: MODEL_DEPTH,
        port: SERVE_PORT,
    })
}

/// Download engine + weights + tools, guided by the latest manifest.
/// Emits progress events on the channel; safe to re-run (idempotent).
#[tauri::command]
pub async fn reflex_setup(
    app: tauri::AppHandle,
    on_event: tauri::ipc::Channel<ReflexSetupEvent>,
) -> Result<(), String> {
    if SETUP_RUNNING.swap(true, Ordering::AcqRel) {
        return Err("reflex setup already running".into());
    }
    let result = setup_inner(&app, &on_event).await;
    SETUP_RUNNING.store(false, Ordering::Release);
    result
}

async fn setup_inner(
    app: &tauri::AppHandle,
    on_event: &tauri::ipc::Channel<ReflexSetupEvent>,
) -> Result<(), String> {
    let dir = reflex_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let manifest = fetch_manifest(Duration::from_secs(20)).await?;
    let (engine_url, engine_sha256) = manifest.resolve_engine()?;

    validate_manifest_url(&manifest.weights_url)?;
    validate_manifest_url(&manifest.tools_url)?;
    validate_manifest_url(&engine_url)?;

    // Stop any running engine BEFORE replacing artifacts so Windows does not
    // hit a sharing violation renaming over a live cactus.exe.
    stop_engine_sync();

    let emit = |phase: &str, downloaded: u64, total: u64, msg: Option<&str>| {
        let _ = on_event.send(ReflexSetupEvent {
            phase: phase.into(),
            downloaded,
            total,
            message: msg.map(|s| s.into()),
        });
    };

    // Weights: skip only when size AND sha256 match (the biggest download).
    let weights_dest = model_path(&dir);
    let weights_valid = weights_dest.exists()
        && std::fs::metadata(&weights_dest).map(|m| m.len()).unwrap_or(0)
            == manifest.weights_bytes
        && sha256_file(&weights_dest)
            .map(|h| h.eq_ignore_ascii_case(&manifest.weights_sha256))
            .unwrap_or(false);
    if !weights_valid {
        emit("weights", 0, manifest.weights_bytes, None);
        download_verified(
            "weights",
            &manifest.weights_url,
            &manifest.weights_sha256,
            &weights_dest,
            &emit,
        )
        .await?;
    }

    // Tools schema (tiny).
    let tools_dest = tools_path(&dir);
    emit("tools", 0, 0, None);
    download_verified(
        "tools",
        &manifest.tools_url,
        &manifest.tools_sha256,
        &tools_dest,
        &emit,
    )
    .await?;

    // Engine binary (platform-specific; published as .zip or raw executable).
    let engine_dest = engine_path(&dir);
    emit("engine", 0, 0, None);
    if engine_url.ends_with(".zip") {
        let zip_tmp = dir.join("cactus-engine.zip");
        download_verified("engine", &engine_url, &engine_sha256, &zip_tmp, &emit).await?;
        let extract_res = extract_engine_from_zip(&zip_tmp, &engine_dest);
        let _ = std::fs::remove_file(&zip_tmp);
        extract_res?;
    } else {
        download_verified("engine", &engine_url, &engine_sha256, &engine_dest, &emit).await?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&engine_dest, std::fs::Permissions::from_mode(0o755));
    }

    // Record the manifest LAST so a partial install never reports installed.
    let manifest_raw = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(manifest_path(&dir), manifest_raw).map_err(|e| e.to_string())?;

    emit("done", 1, 1, Some("Reflex engine ready"));
    Ok(())
}

/// Extract the `cactus(.exe)` binary from a downloaded engine zip safely
/// (matching basename only, rejecting path traversal, writing via `.part`).
fn extract_engine_from_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("invalid engine zip: {e}"))?;
    let wanted = engine_filename();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let Some(safe_path) = entry.enclosed_name() else {
            continue;
        };
        let is_match = safe_path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case(wanted));
        if !is_match {
            continue;
        }
        let part = dest.with_extension("part");
        let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        if let Err(e) = std::io::copy(&mut entry, &mut out) {
            drop(out);
            let _ = std::fs::remove_file(&part);
            return Err(e.to_string());
        }
        out.flush().ok();
        drop(out);
        replace_file(&part, dest)?;
        return Ok(());
    }
    Err(format!("engine archive did not contain {wanted}"))
}

fn replace_file(src: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        let _ = std::fs::remove_file(dest);
    }
    std::fs::rename(src, dest).map_err(|e| {
        let _ = std::fs::remove_file(src);
        e.to_string()
    })
}

async fn download_verified(
    phase: &str,
    url: &str,
    expected_sha256: &str,
    dest: &Path,
    emit: &impl Fn(&str, u64, u64, Option<&str>),
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {} from {url}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let part = dest.with_extension("part");
    use futures_util::StreamExt;
    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                let _ = std::fs::remove_file(&part);
                return Err(e.to_string());
            }
        };
        if let Err(e) = file.write_all(&chunk) {
            drop(file);
            let _ = std::fs::remove_file(&part);
            return Err(e.to_string());
        }
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        emit(phase, downloaded, total, None);
    }
    file.flush().ok();
    drop(file);

    let actual_sha = format!("{:x}", hasher.finalize());
    if !expected_sha256.is_empty() && !actual_sha.eq_ignore_ascii_case(expected_sha256.trim()) {
        let _ = std::fs::remove_file(&part);
        return Err(format!(
            "checksum mismatch for {phase}: expected {expected_sha256}, got {actual_sha}"
        ));
    }

    replace_file(&part, dest)
}

/// Classify a prompt through the running engine. MUST be called from Rust,
/// not the webview: the webview's fetch() to 127.0.0.1:8941 is a
/// cross-origin request the cactus engine has no CORS headers for, so
/// WebView2 blocks it (surfaced as reason "no-reply" in the reflex log).
/// Returns the raw engine JSON reply for the frontend to parse.
#[tauri::command]
pub async fn reflex_classify(prompt: String) -> Result<serde_json::Value, String> {
    let _io_guard = engine_io_lock().lock().await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(2500))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("http://127.0.0.1:{SERVE_PORT}/complete"))
        .header("Content-Type", "application/json")
        .body(
            serde_json::to_string(&serde_json::json!({ "input": prompt }))
                .map_err(|e| e.to_string())?,
        )
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("engine HTTP {}", resp.status()));
    }
    let mut value = resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
    // Stateless use: reset the engine's conversation under the same IO lock
    // so turn N never leaks into turn N+1 (KV window drift).
    let reset = client
        .post(format!("http://127.0.0.1:{SERVE_PORT}/reset"))
        .send()
        .await;
    let reset_ok = reset.map(|r| r.status().is_success()).unwrap_or(false);
    // Surface reset failures so the frontend can log a distinguishable state.
    if let Some(obj) = value.as_object_mut() {
        obj.insert("resetOk".into(), serde_json::Value::Bool(reset_ok));
    }
    Ok(value)
}

/// Remove the downloaded engine + weights (Settings → the reflex card).
#[tauri::command]
pub fn reflex_remove(app: tauri::AppHandle) -> Result<(), String> {
    let dir = reflex_dir(&app)?;
    stop_engine_sync();
    for p in [
        engine_path(&dir),
        model_path(&dir),
        tools_path(&dir),
        manifest_path(&dir),
    ] {
        if p.exists() {
            std::fs::remove_file(p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ── Engine lifecycle ───────────────────────────────────────────────────────

async fn probe_health() -> bool {
    let _io_guard = engine_io_lock().lock().await;
    let url = format!("http://127.0.0.1:{SERVE_PORT}/complete");
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let resp = match client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(r#"{"input":"ping"}"#)
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return false,
    };
    let healthy = resp.status().is_success();
    // The probe's turn MUST NOT leak into the next classification: the
    // engine keeps ONE running conversation, and a leftover "ping" turn
    // made the next real prompt drift into the ping answer's tool (seen
    // live: "stop radio" classified as set_voice_settings). Reset after
    // probing under the same IO lock.
    let _ = client
        .post(format!("http://127.0.0.1:{SERVE_PORT}/reset"))
        .send()
        .await;
    healthy
}

fn spawn_engine_sync(app: &tauri::AppHandle) -> Result<u32, String> {
    let dir = reflex_dir(app)?;
    let engine = engine_path(&dir);
    let model = model_path(&dir);
    let tools = tools_path(&dir);
    for p in [&engine, &model, &tools] {
        if !p.exists() {
            return Err(format!("missing artifact: {}", p.display()));
        }
    }
    // Reap any previous child before replacing the slot.
    stop_engine_sync();

    let mut cmd = std::process::Command::new(&engine);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: the engine is a headless serve process; without
        // this a console window flashes on every spawn.
        cmd.creation_flags(0x0800_0000);
    }
    cmd.arg("--model")
        .arg(&model)
        .arg("--tools")
        .arg(&tools)
        .arg("--serve")
        .arg("--port")
        .arg(SERVE_PORT.to_string())
        .current_dir(&dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    let mut slot = crate::modules::lock::mutex_lock(&CHILD_PROC);
    *slot = Some(child);
    Ok(pid)
}

fn stop_engine_sync() {
    let mut slot = crate::modules::lock::mutex_lock(&CHILD_PROC);
    if let Some(mut child) = slot.take() {
        // Only signal if still running (avoids touching an already-exited child).
        if matches!(child.try_wait(), Ok(None)) {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

/// Ensure the engine is downloaded (no-op when present) AND running (no-op
/// when the port already answers). Serialized by `engine_spawn_lock` so
/// concurrent callers never spawn duplicate processes.
#[tauri::command]
pub async fn reflex_ensure_running(app: tauri::AppHandle) -> Result<ReflexStatus, String> {
    let _spawn_guard = engine_spawn_lock().lock().await;
    let dir = reflex_dir(&app)?;
    let installed = engine_path(&dir).exists()
        && model_path(&dir).exists()
        && tools_path(&dir).exists();
    if !installed {
        return Ok(ReflexStatus {
            installed: false,
            running: false,
            version: None,
            latest_version: None,
            update_available: false,
            installing: SETUP_RUNNING.load(Ordering::Acquire),
            model_depth: MODEL_DEPTH,
            port: SERVE_PORT,
        });
    }
    let mut running = probe_health().await;
    if !running {
        spawn_engine_sync(&app)?;
        // Give the engine a moment to bind the port, then confirm.
        for _ in 0..10 {
            tokio::time::sleep(Duration::from_millis(300)).await;
            if probe_health().await {
                running = true;
                break;
            }
        }
    }
    let version = read_manifest_disk(&dir).map(|m| m.version);
    Ok(ReflexStatus {
        installed: true,
        running,
        version: version.clone(),
        latest_version: version,
        update_available: false,
        installing: SETUP_RUNNING.load(Ordering::Acquire),
        model_depth: MODEL_DEPTH,
        port: SERVE_PORT,
    })
}

/// App-exit cleanup: wired into lib.rs's run-loop exit hook.
#[allow(dead_code)]
pub fn reflex_shutdown() {
    stop_engine_sync();
}
