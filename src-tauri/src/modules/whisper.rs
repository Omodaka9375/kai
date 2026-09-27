//! Local voice transcription via whisper.cpp.
//!
//! Models are **not bundled** — they are downloaded on demand into
//! `app_local_data_dir()/whisper/`. The Silero VAD model (~885 KB) *is*
//! bundled via `include_bytes!` and written to disk on first use, because
//! `WhisperVadContext` loads from a file path.
//!
//! Pipeline: capture audio (frontend) → Silero VAD finds speech windows →
//! splice only the speech samples → Whisper transcribes.
//!
//! **Model choice matters on CPU.** The 809M-param `large-v3-turbo` needs a
//! GPU: its 32-layer encoder pads every clip to a 30s window and runs ~11×
//! real-time on a desktop CPU (measured: 111s for a 9.8s clip on an
//! i7-11700F), which used to guarantee the frontend's transcription timeout.
//! `base` (74M, 12-layer encoder) transcribes the same clip in ~3s. The
//! catalog marks CPU-suitable models, and the settings UI steers users to
//! them.

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use base64::Engine as _;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperVadContext,
    WhisperVadContextParams, WhisperVadParams,
};

use crate::modules::lock::mutex_lock;

const SILERO_MODEL_NAME: &str = "ggml-silero-v5.1.2.bin";
/// Bundled Silero VAD model.
const SILERO_MODEL_BYTES: &[u8] = include_bytes!("../../assets/ggml-silero-v5.1.2.bin");
/// 16 kHz — the sample rate whisper.cpp expects.
const SAMPLE_RATE: f32 = 16_000.0;

/// One downloadable Whisper model. Sizes are exact `content-length` values
/// from HuggingFace (verified via HEAD); the download progress total and the
/// on-disk sanity check both key off them.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WhisperModelInfo {
    pub id: &'static str,
    /// Human label, e.g. "base (multilingual, q5_1)".
    pub label: &'static str,
    /// Approximate RAM/CPU cost tier — drives ordering and warnings in the UI.
    pub tier: &'static str, // "fast" | "balanced" | "accurate" | "gpu_only"
    pub size_bytes: u64,
    pub url: &'static str,
    pub file_name: &'static str,
    /// True when the model is usable for live dictation on a typical CPU.
    pub cpu_friendly: bool,
}

const HF_BASE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

const fn model(
    id: &'static str,
    label: &'static str,
    tier: &'static str,
    size: u64,
    file: &'static str,
    cpu: bool,
) -> WhisperModelInfo {
    WhisperModelInfo {
        id,
        label,
        tier,
        size_bytes: size,
        url: "",
        file_name: file,
        cpu_friendly: cpu,
    }
}

/// Downloadable models, ordered fast → heavy. `tiny`/`base`/`small` are the
/// CPU-friendly tiers; the `large-v3-turbo` default was replaced because it
/// cannot do interactive transcription on CPU (see module docs).
pub const MODELS: &[WhisperModelInfo] = &[
    model("tiny",      "tiny (multilingual, q5_1)",            "fast",     32_152_673,  "ggml-tiny-q5_1.bin",      true),
    model("tiny.en",   "tiny (English, q5_1)",               "fast",     32_166_155,  "ggml-tiny.en-q5_1.bin",   true),
    model("base",      "base (multilingual, q5_1)",          "fast",     59_707_625,  "ggml-base-q5_1.bin",      true),
    model("base.en",   "base (English, q5_1)",               "fast",     59_721_011,  "ggml-base.en-q5_1.bin",   true),
    model("small",     "small (multilingual, q5_1)",         "balanced", 190_085_487, "ggml-small-q5_1.bin",     true),
    model("small.en",  "small (English, q5_1)",              "balanced", 190_098_681, "ggml-small.en-q5_1.bin",  true),
    model("medium.en", "medium (English, q5_0)",             "accurate", 539_225_533, "ggml-medium.en-q5_0.bin", false),
    model("turbo",     "large-v3-turbo (multilingual, q5_0)", "gpu_only", 574_041_195, "ggml-large-v3-turbo-q5_0.bin", false),
];

/// ID of the model used when the user never picked one. Must stay
/// CPU-friendly. (Referenced by tests; the frontend keeps its own copy in
/// native.ts — keep them in sync.)
#[cfg_attr(not(test), allow(dead_code))]
pub const DEFAULT_MODEL_ID: &str = "base";

pub fn find_model(id: &str) -> Option<&'static WhisperModelInfo> {
    MODELS.iter().find(|m| m.id == id)
}

/// URL for a catalog model — computed here rather than stored in the const
/// table so the catalog stays a `const` (no `String` in statics).
fn model_url(info: &WhisperModelInfo) -> String {
    format!("{HF_BASE}{}", info.file_name)
}

/// The model a transcription actually uses. An explicit `model_id` is
/// honored when downloaded; when it isn't, we fall back to a downloaded
/// **CPU-friendly** model rather than whatever else is on disk — for users of
/// the old single-model build the only file there is the CPU-hostile turbo
/// model, and silently picking it recreated the every-press-times-out bug.
/// Only when no CPU-friendly model exists does the error surface guidance.
fn resolve_model_for(
    app: &AppHandle,
    model_id: Option<&str>,
) -> Result<Option<WhisperModelInfo>, String> {
    let dir = model_dir(app)?;
    if let Some(id) = model_id {
        if let Some(info) = find_model(id) {
            if dir.join(info.file_name).exists() {
                return Ok(Some(info.clone()));
            }
        }
        // Explicit pick missing on disk: any downloaded CPU-friendly model.
        for info in MODELS {
            if info.cpu_friendly && dir.join(info.file_name).exists() {
                return Ok(Some(info.clone()));
            }
        }
        return Ok(None);
    }
    // No explicit pick: any downloaded model, preferring CPU-friendly.
    let mut any: Option<&WhisperModelInfo> = None;
    for info in MODELS {
        if dir.join(info.file_name).exists() {
            if info.cpu_friendly {
                return Ok(Some(info.clone()));
            }
            any.get_or_insert(info);
        }
    }
    Ok(any.cloned())
}

fn model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("whisper");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn silero_path(app: &AppHandle) -> Result<PathBuf, String> {
    let path = model_dir(app)?.join(SILERO_MODEL_NAME);
    if !path.exists() {
        std::fs::write(&path, SILERO_MODEL_BYTES).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

fn model_path_for(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let info = find_model(id).ok_or_else(|| format!("unknown whisper model: {id}"))?;
    Ok(model_dir(app)?.join(info.file_name))
}

/// Removes `path` on drop unless disarmed. Wraps the per-PID download temp so
/// a mid-download error, cancel, or panic can't orphan a partial `.part.<pid>`
/// file on disk. Declared *before* the `File` in `download_inner` so it drops
/// after the file handle closes (Windows won't remove an open file).
struct TmpGuard {
    path: Option<PathBuf>,
}

impl TmpGuard {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for TmpGuard {
    fn drop(&mut self) {
        if let Some(p) = self.path.take() {
            let _ = std::fs::remove_file(&p);
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WhisperModelStatus {
    pub downloaded: bool,
    pub downloading: bool,
    pub path: Option<String>,
    pub size: Option<u64>,
    /// Model id the next transcription would use (null when nothing is
    /// downloaded). The selected-but-maybe-not-downloaded id lives on the
    /// frontend settings store, like every other pref.
    pub active_id: Option<String>,
    /// Every catalog model whose file exists on disk. Lets the settings UI
    /// show per-model Download/Remove without stat-ing each file from JS.
    pub downloaded_ids: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WhisperDownloadEvent {
    pub phase: String, // "progress" | "done" | "error"
    pub downloaded: u64,
    pub total: u64,
    pub message: Option<String>,
}

/// Managed state. `context` caches the loaded model so a transcription pass
/// doesn't reload it from disk every time; `model_id` remembers which one is
/// loaded so a model switch invalidates the cache. `abort` lets the UI kill
/// an in-flight transcription (whisper's callback runs each token, so abort
/// latency is one decode step).
pub struct WhisperManager {
    context: Mutex<Option<(String, WhisperContext)>>,
    downloading: AtomicBool,
    cancel: AtomicBool,
    abort: AtomicBool,
    /// Shared clone for whisper's abort callback (needs 'static + Send).
    abort_share: Arc<AtomicBool>,
}

impl Default for WhisperManager {
    fn default() -> Self {
        let abort = Arc::new(AtomicBool::new(false));
        Self {
            context: Mutex::new(None),
            downloading: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            abort: AtomicBool::new(false),
            abort_share: abort.clone(),
        }
    }
}

impl WhisperManager {
    /// Shared handle to the in-flight abort flag (for whisper's callback).
    pub fn abort_flag(&self) -> Arc<AtomicBool> {
        self.abort_share.clone()
    }
}

#[tauri::command]
pub fn whisper_list_models() -> Vec<WhisperModelInfo> {
    MODELS.to_vec()
}

#[tauri::command]
pub fn whisper_model_status(app: AppHandle) -> Result<WhisperModelStatus, String> {
    let manager = app.state::<WhisperManager>();
    let dir = model_dir(&app)?;
    let downloaded_ids: Vec<String> = MODELS
        .iter()
        .filter(|m| dir.join(m.file_name).exists())
        .map(|m| m.id.to_string())
        .collect();
    let active = resolve_model_for(&app, None)?;
    Ok(WhisperModelStatus {
        downloaded: active.is_some(),
        downloading: manager.downloading.load(Ordering::SeqCst),
        path: active.as_ref().map(|m| {
            dir.join(m.file_name).to_string_lossy().into_owned()
        }),
        size: active.as_ref().and_then(|m| {
            std::fs::metadata(dir.join(m.file_name)).ok().map(|md| md.len())
        }),
        active_id: active.as_ref().map(|m| m.id.to_string()),
        downloaded_ids,
    })
}

#[tauri::command]
pub async fn whisper_download_model(
    app: AppHandle,
    model_id: String,
    on_event: Channel<WhisperDownloadEvent>,
) -> Result<(), String> {
    let manager_state = app.state::<WhisperManager>();
    if manager_state
        .downloading
        .swap(true, Ordering::SeqCst)
    {
        return Err("download already in progress".into());
    }
    manager_state.cancel.store(false, Ordering::SeqCst);

    let result = download_inner(&app, &model_id, &on_event).await;

    app.state::<WhisperManager>()
        .downloading
        .store(false, Ordering::SeqCst);
    result
}

async fn download_inner(
    app: &AppHandle,
    model_id: &str,
    on_event: &Channel<WhisperDownloadEvent>,
) -> Result<(), String> {
    let info = find_model(model_id).ok_or_else(|| format!("unknown whisper model: {model_id}"))?;
    let dir = model_dir(app)?;
    let path = dir.join(info.file_name);

    // Already present at the expected size — nothing to do.
    if path.exists() && std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) == info.size_bytes {
        let _ = on_event.send(WhisperDownloadEvent {
            phase: "done".into(),
            downloaded: info.size_bytes,
            total: info.size_bytes,
            message: Some(path.to_string_lossy().into_owned()),
        });
        return Ok(());
    }

    log::info!("whisper: downloading {} ({})", info.label, info.file_name);
    let client = reqwest::Client::new();
    let resp = client
        .get(model_url(info))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(info.size_bytes);

    use futures_util::StreamExt;
    // Per-process temp path — two instances downloading concurrently would
    // otherwise interleave writes into the same `.part` file and corrupt the
    // model on the final rename.
    let tmp = path.with_extension(format!("part.{}", std::process::id()));
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut guard = TmpGuard::new(tmp.clone());
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        let _ = on_event.send(WhisperDownloadEvent {
            phase: "progress".into(),
            downloaded,
            total,
            message: None,
        });
        if app.state::<WhisperManager>().cancel.load(Ordering::SeqCst) {
            return Err("download cancelled".into());
        }
    }
    if downloaded != info.size_bytes {
        return Err(format!(
            "download incomplete: got {downloaded} of {} bytes",
            info.size_bytes
        ));
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    // rename() to the same destination from two processes is atomic on the
    // filesystem level; the last finisher wins with a complete file.
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    guard.disarm();
    log::info!("whisper: model {} saved", info.file_name);

    let _ = on_event.send(WhisperDownloadEvent {
        phase: "done".into(),
        downloaded,
        total,
        message: Some(path.to_string_lossy().into_owned()),
    });
    Ok(())
}

#[tauri::command]
pub fn whisper_cancel_download(app: AppHandle) {
    app.state::<WhisperManager>()
        .cancel
        .store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn whisper_delete_model(app: AppHandle, model_id: String) -> Result<(), String> {
    let manager = app.state::<WhisperManager>();
    let path = model_path_for(&app, &model_id)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        // Drop the cached context if it was this model.
        let mut guard = mutex_lock(&manager.context);
        if guard.as_ref().map(|(id, _)| id == model_id.as_str()).unwrap_or(false) {
            *guard = None;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn whisper_abort_transcribe(app: AppHandle) {
    app.state::<WhisperManager>()
        .abort
        .store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn whisper_transcribe(
    app: AppHandle,
    model_id: Option<String>,
    audio_base64: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        transcribe_inner(&app, model_id.as_deref(), &audio_base64)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Decode little-endian f32 PCM from a base64 string. The frontend resamples to
/// 16 kHz mono and sends raw f32 bytes so the payload stays compact.
fn decode_audio(base64_str: &str) -> Result<Vec<f32>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_str.trim())
        .map_err(|e| format!("invalid audio payload: {e}"))?;
    if bytes.len() % 4 != 0 {
        return Err("invalid audio payload: not f32-aligned".into());
    }
    let mut samples = Vec::with_capacity(bytes.len() / 4);
    for &chunk in bytes.as_chunks::<4>().0 {
        samples.push(f32::from_le_bytes(chunk));
    }
    Ok(samples)
}

/// Cores available for inference. Leaves 2 logical cores for the UI/PTY
/// threads; whisper.cpp's own thread pool scales sub-linearly past
/// physical-core count, so cap at physical cores.
fn inference_threads() -> i32 {
    let logical = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let physical = (logical / 2).max(1);
    physical.clamp(1, 8) as i32
}

fn transcribe_inner(
    app: &AppHandle,
    model_id: Option<&str>,
    audio_base64: &str,
) -> Result<String, String> {
    let manager = app.state::<WhisperManager>();
    manager.abort.store(false, Ordering::SeqCst);

    let t_start = Instant::now();
    let samples = decode_audio(audio_base64)?;
    if samples.is_empty() {
        return Ok(String::new());
    }
    let dur_s = samples.len() as f32 / SAMPLE_RATE;
    log::info!(
        "whisper: transcribe start ({} samples, {dur_s:.1}s)",
        samples.len()
    );

    let info = match resolve_model_for(app, model_id)? {
        Some(i) => i,
        None => {
            // Distinguish "nothing downloaded" from "the selected one isn't
            // downloaded" so the error tells the user exactly what to do.
            if let Some(id) = model_id {
                let label = find_model(id)
                    .map(|m| m.label)
                    .unwrap_or(id);
                return Err(format!(
                    "Whisper model \"{label}\" is not downloaded. Open Settings → General → Local voice transcription to download it (or pick a downloaded model)."
                ));
            }
            return Err(
                "Whisper model not downloaded. Download it in Settings → General.".into(),
            );
        }
    };    let model_path = model_dir(app)?.join(info.file_name);

    let t = Instant::now();
    let spliced = vad_splice(app, &samples)?;
    let t_vad = t.elapsed();
    if spliced.is_empty() {
        log::info!("whisper: no speech detected ({dur_s:.1}s in, vad {t_vad:?})");
        return Ok(String::new());
    }
    log::info!(
        "whisper: vad {t_vad:?}, kept {}/{} samples ({:.0}%)",
        spliced.len(),
        samples.len(),
        100.0 * spliced.len() as f32 / samples.len() as f32
    );

    // Cached context keyed by model id — switching models drops the old one.
    let mut guard = mutex_lock(&manager.context);
    if guard.as_ref().map(|(id, _)| id != info.id).unwrap_or(false) {
        *guard = None;
    }
    if guard.is_none() {
        let t = Instant::now();
        *guard = Some((
            info.id.to_string(),
            WhisperContext::new_with_params(
                model_path.to_string_lossy().as_ref(),
                WhisperContextParameters::default(),
            )
            .map_err(|e| format!("failed to load whisper model: {e}"))?,
        ));
        log::info!("whisper: model load {:?}", t.elapsed());
    }
    let mut state = guard
        .as_ref()
        .expect("context initialized above")
        .1
        .create_state()
        .map_err(|e| e.to_string())?;
    // Release the lock before running; `state` holds its own Arc to the model.
    drop(guard);

    let threads = inference_threads();
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 5 });
    params.set_language(None); // auto-detect
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_n_threads(threads);
    // CPU-friendly abort: the callback is checked between decode steps, so
    // cancel latency is at most one token. Arc shares the flag with the
    // `whisper_abort_transcribe` command.
    let abort = app.state::<WhisperManager>().abort_flag();
    params.set_abort_callback_safe(move || abort.load(Ordering::SeqCst));

    let t = Instant::now();
    let full_result = state.full(params, &spliced);
    let t_full = t.elapsed();
    match full_result {
        Ok(()) => {}
        Err(e) => {
            if app.state::<WhisperManager>().abort.load(Ordering::SeqCst) {
                log::info!("whisper: aborted after {t_full:?}");
                return Err("Transcription cancelled.".into());
            }
            return Err(e.to_string());
        }
    }

    let mut text = String::new();
    for segment in state.as_iter() {
        text.push_str(&segment.to_str_lossy().unwrap_or_default());
    }
    log::info!(
        "whisper: transcribe done: model={} threads={} vad={t_vad:?} full={t_full:?} total={:?} ({:.1}s audio)",
        info.id,
        threads,
        t_start.elapsed(),
        dur_s
    );
    Ok(text.trim().to_string())
}

fn vad_splice(app: &AppHandle, samples: &[f32]) -> Result<Vec<f32>, String> {
    let silero = silero_path(app)?;

    let mut vad_params = WhisperVadContextParams::default();
    vad_params.set_n_threads(1);
    vad_params.set_use_gpu(false);
    let mut vad_ctx = WhisperVadContext::new(&silero.to_string_lossy(), vad_params)
        .map_err(|e| e.to_string())?;

    let segments = vad_ctx
        .segments_from_samples(WhisperVadParams::new(), samples)
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for segment in segments {
        // whisper.cpp VAD timestamps are in centiseconds.
        let start = ((segment.start / 100.0) * SAMPLE_RATE) as usize;
        let end = ((segment.end / 100.0) * SAMPLE_RATE) as usize;
        let start = start.min(samples.len());
        let end = end.min(samples.len());
        if end > start {
            out.extend_from_slice(&samples[start..end]);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::decode_audio;
    use base64::Engine as _;

    #[test]
    fn decodes_f32_le_base64() {
        let samples = [0.25f32, -1.0f32, 0.5f32];
        let mut bytes = Vec::new();
        for s in samples {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let decoded = decode_audio(&b64).unwrap();
        assert_eq!(decoded.len(), 3);
        assert!((decoded[0] - 0.25).abs() < f32::EPSILON);
        assert!((decoded[1] + 1.0).abs() < f32::EPSILON);
        assert!((decoded[2] - 0.5).abs() < f32::EPSILON);
    }

    #[test]
    fn rejects_unaligned_audio() {
        assert!(decode_audio("aGVsbG8=").is_err()); // 5 bytes, not f32-aligned
    }

    #[test]
    fn default_model_is_cpu_friendly() {
        let m = super::find_model(super::DEFAULT_MODEL_ID).unwrap();
        assert!(m.cpu_friendly);
    }

    #[test]
    fn catalog_ids_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for m in super::MODELS {
            assert!(seen.insert(m.id), "duplicate id {}", m.id);
        }
    }
}
