//! Local Reflex engine (`kai-reflex-v1`) — download, lifecycle, health.
//!
//! Optional user-installed runtime (same contract as `voice.rs`): nothing
//! ships in the installer; the engine binary + `kai-reflex-v1` weights are
//! downloaded on demand into `app_local_data_dir()/reflex/` and spawned as a
//! localhost serve child answering `POST /complete` for the pre-LLM fast path
//! (`src/modules/ai/lib/localReflex.ts`).
//!
//! Components in `app_local_data_dir()/reflex/`:
//!   cactus(.exe)           pinned Cactus 4.1.0 standalone binary (1.2-1.6 MB)
//!   kai-reflex-v1-12L.cact fine-tuned Needle 3 weights (22.5 MB @ 12L)
//!   narrow_tools.json      embedded 22-tool schema written from binary
//!   manifest.json          installed version record
//!
//! Fail-safe contract: every command degrades to a clean error; a missing or
//! stopped engine never blocks sending (the frontend falls through to the
//! configured cloud/local LLM).

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

/// Versioned manifest published alongside KAI GitHub releases.
const MANIFEST_URL: &str =
    "https://github.com/Omodaka9375/kai/releases/latest/download/reflex-manifest.json";

/// Allowed download origins (KAI GitHub releases + pinned Cactus-Compute HF repo).
const ALLOWED_URL_PREFIXES: &[&str] = &[
    "https://github.com/Omodaka9375/kai/releases/",
    "https://huggingface.co/Cactus-Compute/cactus/resolve/",
];

/// Shipped model identity (`kai-reflex-v1` at 12L depth).
const MODEL_NAME: &str = "kai-reflex-v1";
const MODEL_DEPTH: u32 = 12;
const DEFAULT_VERSION: &str = "1.0.0";

/// Pinned v1 weights fallback (served from KAI's latest GitHub release if
/// `reflex-manifest.json` isn't fetched or for deterministic v1 defaults).
const DEFAULT_WEIGHTS_URL: &str =
    "https://github.com/Omodaka9375/kai/releases/latest/download/kai-reflex-v1-12L.cact";
const DEFAULT_WEIGHTS_SHA256: &str =
    "979db9355ce9783ea84d52ce2aa9a181c9fe1aec404107e3e983dbe1d36c12c1";
const DEFAULT_WEIGHTS_BYTES: u64 = 22_549_012;

/// Embedded 22-tool runtime schema matching `localReflex.ts`.
const EMBEDDED_NARROW_TOOLS: &str = include_str!("reflex_tools.json");

/// Pinned Cactus 4.1.0 standalone engine binaries (exact revision + SHA-256
/// from `Cactus-Compute/cactus` manifest).
const CACTUS_ENGINE_BASE: &str =
    "https://huggingface.co/Cactus-Compute/cactus/resolve/4e822c9036be2eb0e47ef556df32a818bb1572ef/releases/4.1.0";

fn pinned_engine_for_platform(plat: &str) -> Option<(&'static str, &'static str, u64)> {
    match plat {
        "windows-x86_64" => Some((
            "windows-x86_64/cactus.exe",
            "3b913456f1abd8de91aad6058ed1467eb418af7d2806f82c3d0bd8d26677ca6f",
            1_622_016,
        )),
        "windows-arm64" => Some((
            "windows-arm64/cactus.exe",
            "06c001b2d0608cc79297db0d417f5eb83236f59105bf18e1befe7aef81ae8b84",
            1_399_296,
        )),
        "macos-arm64" => Some((
            "macos-arm64/cactus",
            "86c7bad785977c79d935a47604e14df0ef9640297b1b1280d93757a15a87f3f5",
            1_156_280,
        )),
        "linux-x86_64" => Some((
            "linux-x86_64/cactus",
            "d3fabf298fed9da8db319c90fbce62c898930699d87c0468b20262860b337098",
            1_604_704,
        )),
        "linux-arm64" => Some((
            "linux-arm64/cactus",
            "088137b428c1be5cacb022a78a56f82815e5d60767002874afcc2ca7cf446074",
            1_486_560,
        )),
        _ => None,
    }
}

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

/// Platform key matching `scripts/cactus/publish_artifacts.py` and Cactus releases.
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
    /// All required artifacts present on disk.
    pub installed: bool,
    /// Engine process is live and answering /complete.
    pub running: bool,
    /// Model identifier (`kai-reflex-v1`).
    pub model_name: String,
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

/// Matches `scripts/cactus/publish_artifacts.py`.
/// `engines` and `tools_url` are optional: when absent, setup falls back to
/// the pinned Cactus 4.1.0 engine binary and the embedded `narrow_tools.json`.
#[derive(serde::Deserialize, serde::Serialize, Clone)]
pub struct ReflexManifest {
    pub version: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub engines: HashMap<String, EngineArtifact>,
    #[serde(default)]
    pub engine_url: Option<String>,
    #[serde(default)]
    pub engine_sha256: Option<String>,
    pub weights_url: String,
    pub weights_sha256: String,
    pub weights_bytes: u64,
    #[serde(default)]
    pub tools_url: Option<String>,
    #[serde(default)]
    pub tools_sha256: Option<String>,
}

impl ReflexManifest {
    /// Built-in v1 manifest fallback used if `reflex-manifest.json` is not
    /// reachable yet or omitted on a release tag.
    fn builtin_v1() -> Self {
        Self {
            version: DEFAULT_VERSION.to_string(),
            model: Some(MODEL_NAME.to_string()),
            engines: HashMap::new(),
            engine_url: None,
            engine_sha256: None,
            weights_url: DEFAULT_WEIGHTS_URL.to_string(),
            weights_sha256: DEFAULT_WEIGHTS_SHA256.to_string(),
            weights_bytes: DEFAULT_WEIGHTS_BYTES,
            tools_url: None,
            tools_sha256: None,
        }
    }

    fn resolve_engine(&self) -> Result<(String, String, u64), String> {
        let plat = current_platform_key();
        if let Some(art) = self.engines.get(plat) {
            return Ok((art.url.clone(), art.sha256.clone(), art.bytes));
        }
        if let (Some(url), Some(sha)) = (&self.engine_url, &self.engine_sha256) {
            return Ok((url.clone(), sha.clone(), 0));
        }
        if let Some((rel, sha, bytes)) = pinned_engine_for_platform(plat) {
            return Ok((format!("{CACTUS_ENGINE_BASE}/{rel}"), sha.to_string(), bytes));
        }
        Err(format!(
            "Local Reflex is not supported on this platform ({plat}) yet."
        ))
    }
}

fn read_manifest_disk(dir: &Path) -> Option<ReflexManifest> {
    let path = manifest_path(dir);
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Fast timeout for passive status checks so offline/slow GitHub never stalls
/// the Local Reflex settings panel; setup uses a longer budget.
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
    if !ALLOWED_URL_PREFIXES.iter().any(|p| url.starts_with(p)) {
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
        model_name: MODEL_NAME.to_string(),
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

/// Download engine + `kai-reflex-v1` weights + tools schema.
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
    // Prefer the live release manifest (enables v1.1+ updates without an app
    // rebuild), falling back to the built-in v1 manifest if not yet published.
    let manifest = fetch_manifest(Duration::from_secs(15))
        .await
        .unwrap_or_else(|_| ReflexManifest::builtin_v1());
    let (engine_url, engine_sha256, engine_bytes) = manifest.resolve_engine()?;

    validate_manifest_url(&manifest.weights_url)?;
    validate_manifest_url(&engine_url)?;
    if let Some(ref tools_url) = manifest.tools_url {
        validate_manifest_url(tools_url)?;
    }

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

    // 1. Weights: skip only when size AND sha256 match (the 22.5 MB download).
    let weights_dest = model_path(&dir);
    let weights_valid = weights_dest.exists()
        && std::fs::metadata(&weights_dest).map(|m| m.len()).unwrap_or(0)
            == manifest.weights_bytes
        && sha256_file(&weights_dest)
            .map(|h| h.eq_ignore_ascii_case(&manifest.weights_sha256))
            .unwrap_or(false);
    if !weights_valid {
        emit("weights", 0, manifest.weights_bytes, Some("Downloading kai-reflex-v1 weights…"));
        download_verified(
            "weights",
            &manifest.weights_url,
            &manifest.weights_sha256,
            &weights_dest,
            &emit,
        )
        .await?;
    }

    // 2. Tools schema: download from manifest when provided, otherwise write
    // the embedded schema compiled into the binary.
    let tools_dest = tools_path(&dir);
    emit("tools", 0, 0, Some("Writing tool schema…"));
    if let (Some(tools_url), Some(tools_sha)) = (&manifest.tools_url, &manifest.tools_sha256) {
        download_verified("tools", tools_url, tools_sha, &tools_dest, &emit).await?;
    } else {
        std::fs::write(&tools_dest, EMBEDDED_NARROW_TOOLS).map_err(|e| e.to_string())?;
    }

    // 3. Engine binary: skip if checksum already matches on disk.
    let engine_dest = engine_path(&dir);
    let engine_valid = engine_dest.exists()
        && !engine_url.ends_with(".zip")
        && sha256_file(&engine_dest)
            .map(|h| h.eq_ignore_ascii_case(&engine_sha256))
            .unwrap_or(false);
    if !engine_valid {
        emit("engine", 0, engine_bytes, Some("Downloading runtime engine…"));
        if engine_url.ends_with(".zip") {
            let zip_tmp = dir.join("cactus-engine.zip");
            download_verified("engine", &engine_url, &engine_sha256, &zip_tmp, &emit).await?;
            let extract_res = extract_engine_from_zip(&zip_tmp, &engine_dest);
            let _ = std::fs::remove_file(&zip_tmp);
            extract_res?;
        } else {
            download_verified("engine", &engine_url, &engine_sha256, &engine_dest, &emit).await?;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&engine_dest, std::fs::Permissions::from_mode(0o755));
    }

    // Record the manifest LAST so a partial install never reports installed.
    let manifest_raw = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(manifest_path(&dir), manifest_raw).map_err(|e| e.to_string())?;

    emit("done", 1, 1, Some("kai-reflex-v1 ready"));
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
/// not the webview (the engine serves no CORS headers, so WebView2 blocks
/// cross-origin fetch to 127.0.0.1:8941).
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
    let value = resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
    // Stateless use: reset the engine's conversation under the same IO lock
    // so turn N never leaks into turn N+1 (KV window drift).
    let _ = client
        .post(format!("http://127.0.0.1:{SERVE_PORT}/reset"))
        .send()
        .await;
    Ok(value)
}

/// Remove the downloaded engine + weights (Settings -> Local Reflex).
#[tauri::command]
pub fn reflex_remove(app: tauri::AppHandle) -> Result<(), String> {
    let dir = reflex_dir(&app)?;
    stop_engine_sync();
    // Clean up both current (`kai-reflex-v1`) and legacy (`kai-desktop-v1`) weight files.
    for p in [
        engine_path(&dir),
        model_path(&dir),
        dir.join(format!("kai-desktop-v1-{MODEL_DEPTH}L.cact")),
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
    // Reset after probing under the same IO lock so the "ping" turn never
    // leaks into the next classification.
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
        // CREATE_NO_WINDOW: headless serve process; avoid flashing a console.
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

/// Ensure the engine is installed and running (no-op when already answering).
/// Serialized by `engine_spawn_lock` so concurrent callers never spawn
/// duplicate processes.
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
            model_name: MODEL_NAME.to_string(),
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
        model_name: MODEL_NAME.to_string(),
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
