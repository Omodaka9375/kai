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

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::Manager;

/// Versioned artifact source (Run #4 = bump both versions + hashes).
/// Files are served from the KAI release assets (GitHub latest download) so
/// no authenticated storage is involved.
const MANIFEST_URL: &str = "https://github.com/Omodaka9375/kai/releases/latest/download/reflex-manifest.json";

/// The shipped model depth (12L: bench-selected, see scripts/cactus/README.md).
const MODEL_DEPTH: u32 = 12;
const MODEL_NAME: &str = "kai-desktop-v1";

/// PID of the spawned serve process, if we own one. A Mutex (not a static
/// mut) keeps the shared-reference lint happy; None = not spawned by us.
static SPAWN_RUNNING: AtomicBool = AtomicBool::new(false);
static CHILD_PID: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(None);

fn reflex_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("reflex"))
}

use std::path::Path;

fn engine_path(dir: &Path) -> PathBuf {
    #[cfg(windows)]
    return dir.join("cactus.exe");
    #[cfg(not(windows))]
    dir.join("cactus")
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

/// The port the serve process listens on. Fixed (not dynamic) so the
/// frontend's localStorage override stays meaningful; a conflict surfaces
/// as a failed health probe and a clean "engine unavailable" state.
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
    /// Downloaded/total bytes when a setup is in flight.
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
pub struct ReflexManifest {
    pub version: String,
    pub engine_url: String,
    pub engine_sha256: String,
    pub weights_url: String,
    pub weights_sha256: String,
    pub weights_bytes: u64,
    pub tools_url: String,
    pub tools_sha256: String,
}

fn read_manifest_disk(dir: &Path) -> Option<ReflexManifest> {
    let path = manifest_path(dir);
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

async fn fetch_manifest() -> Result<ReflexManifest, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(MANIFEST_URL).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("manifest fetch failed: HTTP {}", resp.status()));
    }
    resp.json::<ReflexManifest>().await.map_err(|e| e.to_string())
}

// Integrity: length-based for now (the manifest records exact bytes, the
// same guarantee voice.rs relies on); a hash upgrade can ride a later
// release without changing the command surface.

// ── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn reflex_status(app: tauri::AppHandle) -> Result<ReflexStatus, String> {
    let dir = reflex_dir(&app)?;
    let installed = engine_path(&dir).exists()
        && model_path(&dir).exists()
        && tools_path(&dir).exists();
    let disk_manifest = read_manifest_disk(&dir);
    let disk_version = disk_manifest.as_ref().map(|m| m.version.clone());
    let latest = fetch_manifest().await.ok();
    let running = installed && probe_health().await;
    Ok(ReflexStatus {
        installed,
        running,
        version: disk_version.clone(),
        latest_version: latest.as_ref().map(|m| m.version.clone()),
        update_available: match (&disk_manifest, &latest) {
            (Some(disk), Some(latest)) => disk.version != latest.version,
            _ => false,
        },
        installing: SPAWN_RUNNING.load(Ordering::Acquire),
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
    if SPAWN_RUNNING.swap(true, Ordering::AcqRel) {
        return Err("reflex setup already running".into());
    }
    let result = setup_inner(&app, &on_event).await;
    SPAWN_RUNNING.store(false, Ordering::Release);
    result
}

async fn setup_inner(
    app: &tauri::AppHandle,
    on_event: &tauri::ipc::Channel<ReflexSetupEvent>,
) -> Result<(), String> {
    let dir = reflex_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let manifest = fetch_manifest().await?;
    let emit = |phase: &str, downloaded: u64, total: u64, msg: Option<&str>| {
        let _ = on_event.send(ReflexSetupEvent {
            phase: phase.into(),
            downloaded,
            total,
            message: msg.map(|s| s.into()),
        });
    };

    // Weights: skip when size matches (the biggest download).
    let weights_dest = model_path(&dir);
    let need_weights = !weights_dest.exists()
        || std::fs::metadata(&weights_dest).map(|m| m.len()).unwrap_or(0) != manifest.weights_bytes;
    if need_weights {
        emit("weights", 0, manifest.weights_bytes, None);
        download_to(&manifest.weights_url, &weights_dest, &emit).await?;
    }

    // Tools schema (tiny).
    let tools_dest = tools_path(&dir);
    emit("tools", 0, 0, None);
    download_to(&manifest.tools_url, &tools_dest, &emit).await?;

    // Engine binary (platform-specific, <1 MB).
    let engine_dest = engine_path(&dir);
    emit("engine", 0, 0, None);
    download_to(&manifest.engine_url, &engine_dest, &emit).await?;
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

async fn download_to(
    url: &str,
    dest: &PathBuf,
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
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        emit("weights", downloaded, total, None);
    }
    file.flush().ok();
    drop(file);
    std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// Classify a prompt through the running engine. MUST be called from Rust,
/// not the webview: the webview's fetch() to 127.0.0.1:8941 is a
/// cross-origin request the cactus engine has no CORS headers for, so
/// WebView2 blocks it (surfaced as reason "no-reply" in the reflex log).
/// Returns the raw engine JSON reply for the frontend to parse.
#[tauri::command]
pub async fn reflex_classify(prompt: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(2500))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("http://127.0.0.1:{SERVE_PORT}/complete"))
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&serde_json::json!({ "input": prompt }))
            .map_err(|e| e.to_string())?)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("engine HTTP {}", resp.status()));
    }
    // Stateless use: same contract as the frontend — reset the engine's
    // conversation so turn N never leaks into turn N+1 (KV window drift).
    let reset = client
        .post(format!("http://127.0.0.1:{SERVE_PORT}/reset"))
        .send()
        .await;
    let reset_ok = reset.map(|r| r.status().is_success()).unwrap_or(false);
    let mut value = resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
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
    // probing, same contract as reflex_classify.
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
    // Idempotence: if something already answers on the port (a previous
    // instance of KAI left one running, or the user started serve-engine.ps1
    // manually), adopt it instead of spawning a second.
    // (The health probe in reflex_ensure_running covers this.)
    let mut cmd = std::process::Command::new(&engine);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: the engine is a headless serve process; without
        // this a console window flashes on every spawn.
        cmd.creation_flags(0x0800_0000);
    }
    cmd.arg("--model").arg(&model)
        .arg("--tools").arg(&tools)
        .arg("--serve")
        .arg("--port").arg(SERVE_PORT.to_string())
        .current_dir(&dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    // Deliberately leak the child handle: we track by PID and kill via the
    // platform killer on exit/remove. std::process::Child would kill on drop
    // only via wait; leaking keeps the serve process independent of this
    // struct's lifetime, and app-exit cleanup goes through stop_engine_sync.
    std::mem::forget(child);
    if let Ok(mut slot) = CHILD_PID.lock() {
        *slot = Some(pid);
    }
    Ok(pid)
}

#[cfg(windows)]
fn kill_pid(pid: u32) {
    // taskkill /F /PID: reliable for a detached console-less child; Job
    // Objects are overkill for a single leaf process with no descendants.
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .creation_flags(0x0800_0000)
        .output();
}
#[cfg(not(windows))]
fn kill_pid(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

fn stop_engine_sync() {
    if let Ok(mut slot) = CHILD_PID.lock() {
        if let Some(pid) = slot.take() {
            kill_pid(pid);
        }
    }
}

/// Ensure the engine is downloaded (no-op when present) AND running (no-op
/// when the port already answers). The frontend calls this before the first
/// classify attempt of a session; it is cheap when everything is ready.
#[tauri::command]
pub async fn reflex_ensure_running(app: tauri::AppHandle) -> Result<ReflexStatus, String> {
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
            installing: false,
            model_depth: MODEL_DEPTH,
            port: SERVE_PORT,
        });
    }
    if !probe_health().await {
        spawn_engine_sync(&app)?;
        // Give the engine a moment to bind the port, then confirm.
        for _ in 0..10 {
            tokio::time::sleep(Duration::from_millis(300)).await;
            if probe_health().await {
                break;
            }
        }
    }
    let running = probe_health().await;
    let version = read_manifest_disk(&dir).map(|m| m.version);
    Ok(ReflexStatus {
        installed: true,
        running,
        version: version.clone(),
        latest_version: version,
        update_available: false,
        installing: false,
        model_depth: MODEL_DEPTH,
        port: SERVE_PORT,
    })
}

/// App-exit cleanup: wired into lib.rs's run-loop exit hook.
#[allow(dead_code)]
pub fn reflex_shutdown() {
    stop_engine_sync();
}
