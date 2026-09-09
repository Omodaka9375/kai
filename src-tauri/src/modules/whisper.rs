//! Local voice transcription via whisper.cpp (large-v3-turbo q5_0).
//!
//! The Whisper model is **not** bundled — it is downloaded on demand into
//! `app_local_data_dir()/whisper/`. The Silero VAD model (~885 KB) *is* bundled
//! via `include_bytes!` and written to disk on first use, because
//! `WhisperVadContext` loads from a file path.
//!
//! Pipeline: capture audio (frontend) → Silero VAD finds speech windows →
//! splice only the speech samples → Whisper transcribes. Whisper.cpp's own VAD
//! is ignored when driving `whisper_full_with_state`, so Silero does the gating
//! host-side where the sample-index math is exact.

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use base64::Engine as _;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperVadContext,
    WhisperVadContextParams, WhisperVadParams,
};

use crate::modules::lock::mutex_lock;

const WHISPER_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin";
const WHISPER_MODEL_NAME: &str = "ggml-large-v3-turbo-q5_0.bin";
const SILERO_MODEL_NAME: &str = "ggml-silero-v5.1.2.bin";
/// Expected byte size of the q5_0 large-v3-turbo model; sanity check after
/// download and the progress total when the server omits `content-length`.
const EXPECTED_WHISPER_SIZE: u64 = 574_041_195;
/// Bundled Silero VAD model.
const SILERO_MODEL_BYTES: &[u8] = include_bytes!("../../assets/ggml-silero-v5.1.2.bin");
/// 16 kHz — the sample rate whisper.cpp expects.
const SAMPLE_RATE: f32 = 16_000.0;

/// Removes `path` on drop unless disarmed. Wraps the per-PID download temp so
/// a mid-download error, cancel, or panic can't orphan a ~547 MB `.part.<pid>`
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
/// doesn't reload ~547 MB from disk every time.
pub struct WhisperManager {
    context: Mutex<Option<WhisperContext>>,
    downloading: AtomicBool,
    cancel: AtomicBool,
}

impl Default for WhisperManager {
    fn default() -> Self {
        Self {
            context: Mutex::new(None),
            downloading: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
        }
    }
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

fn whisper_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(model_dir(app)?.join(WHISPER_MODEL_NAME))
}

fn ensure_silero(app: &AppHandle) -> Result<PathBuf, String> {
    let path = model_dir(app)?.join(SILERO_MODEL_NAME);
    if !path.exists() {
        std::fs::write(&path, SILERO_MODEL_BYTES).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

#[tauri::command]
pub fn whisper_model_status(app: AppHandle) -> Result<WhisperModelStatus, String> {
    let manager = app.state::<WhisperManager>();
    let path = whisper_model_path(&app)?;
    let downloaded = path.exists();
    let size = if downloaded {
        std::fs::metadata(&path).ok().map(|m| m.len())
    } else {
        None
    };
    Ok(WhisperModelStatus {
        downloaded,
        downloading: manager.downloading.load(Ordering::SeqCst),
        path: if downloaded {
            Some(path.to_string_lossy().into_owned())
        } else {
            None
        },
        size,
    })
}

#[tauri::command]
pub async fn whisper_download_model(
    app: AppHandle,
    on_event: Channel<WhisperDownloadEvent>,
) -> Result<(), String> {
    if app
        .state::<WhisperManager>()
        .downloading
        .swap(true, Ordering::SeqCst)
    {
        return Err("download already in progress".into());
    }
    app.state::<WhisperManager>().cancel.store(false, Ordering::SeqCst);

    let result = download_inner(&app, &on_event).await;

    app.state::<WhisperManager>()
        .downloading
        .store(false, Ordering::SeqCst);
    result
}

async fn download_inner(
    app: &AppHandle,
    on_event: &Channel<WhisperDownloadEvent>,
) -> Result<(), String> {
    let path = whisper_model_path(app)?;

    // Already present at the expected size — nothing to do.
    if path.exists() && std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) == EXPECTED_WHISPER_SIZE {
        let _ = on_event.send(WhisperDownloadEvent {
            phase: "done".into(),
            downloaded: EXPECTED_WHISPER_SIZE,
            total: EXPECTED_WHISPER_SIZE,
            message: Some(path.to_string_lossy().into_owned()),
        });
        return Ok(());
    }

    let client = reqwest::Client::new();
    let resp = client
        .get(WHISPER_MODEL_URL)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(EXPECTED_WHISPER_SIZE);

    use futures_util::StreamExt;
    // Per-process temp path — two instances downloading concurrently would
    // otherwise interleave writes into the same `.part` file and corrupt the
    // ~547 MB model on the final rename.
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
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    // rename() to the same destination from two processes is atomic on the
    // filesystem level; the last finisher wins with a complete file, so the
    // shared destination stays coherent even when both instances downloaded.
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    guard.disarm();

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
pub fn whisper_delete_model(app: AppHandle) -> Result<(), String> {
    let manager = app.state::<WhisperManager>();
    *mutex_lock(&manager.context) = None;
    let path = whisper_model_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn whisper_transcribe(
    app: AppHandle,
    audio_base64: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || transcribe_inner(&app, &audio_base64))
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

fn transcribe_inner(app: &AppHandle, audio_base64: &str) -> Result<String, String> {
    let samples = decode_audio(audio_base64)?;
    if samples.is_empty() {
        return Ok(String::new());
    }

    let model_path = whisper_model_path(app)?;
    if !model_path.exists() {
        return Err(
            "Whisper model not downloaded. Download it in Settings → General.".into(),
        );
    }

    // Silero VAD: find speech windows, splice only those samples.
    let spliced = vad_splice(app, &samples)?;
    if spliced.is_empty() {
        return Ok(String::new());
    }

    let manager = app.state::<WhisperManager>();
    let mut guard = mutex_lock(&manager.context);
    if guard.is_none() {
        *guard = Some(
            WhisperContext::new_with_params(&model_path, WhisperContextParameters::default())
                .map_err(|e| format!("failed to load whisper model: {e}"))?,
        );
    }
    let mut state = guard
        .as_ref()
        .expect("context initialized above")
        .create_state()
        .map_err(|e| e.to_string())?;
    // Release the lock before running; `state` holds its own Arc to the model.
    drop(guard);

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 5 });
    params.set_language(None); // auto-detect
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_n_threads(4);

    state.full(params, &spliced).map_err(|e| e.to_string())?;

    let mut text = String::new();
    for segment in state.as_iter() {
        text.push_str(&segment.to_str_lossy().unwrap_or_default());
    }
    Ok(text.trim().to_string())
}

fn vad_splice(app: &AppHandle, samples: &[f32]) -> Result<Vec<f32>, String> {
    let silero_path = ensure_silero(app)?;

    let mut vad_params = WhisperVadContextParams::default();
    vad_params.set_n_threads(1);
    vad_params.set_use_gpu(false);
    let mut vad_ctx = WhisperVadContext::new(&silero_path.to_string_lossy(), vad_params)
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
}
