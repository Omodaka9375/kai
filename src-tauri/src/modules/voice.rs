//! Local voice engines (Layer: optional user-installed tooling).
//!
//! STT: whisper.cpp (`whisper-cli`) — official prebuilt CPU/AVX2 binary from
//! the ggml-org release, with a quantized GGML model. We run it once per
//! recording with the recorded WAV on stdin (`-f -`) and read the transcript
//! from stdout. No server, no resident process, no GPU dependency.
//!
//! TTS: Piper (rhasspy v1.2.0, MIT) — single binary + espeak-ng data + one
//! voice `.onnx`. Text goes in on stdin (`--stdin-input`... actually plain
//! stdin), WAV bytes come back on stdout.
//!
//! Everything downloads ON DEMAND into `app_local_data_dir()/voice/{stt,tts}` —
//! nothing ships in the installer. The download pattern mirrors the sandbox
//! distro (wsl.rs): stream to a `.part` file with progress over a Channel,
//! then extract.
//!
//! Fail-safe contract (same as radio): every command degrades to a clean
//! error state; nothing here can hang or crash the app. The frontend decides
//! what "unavailable" means (fall back to API/Browser STT, disable TTS).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

// The base64 trait is only used inside the win/linux engine bodies; macOS
// early-returns before any decode/encode, so gate the import to keep that
// cfg expansion warning-free.
#[cfg(any(windows, target_os = "linux"))]
use base64::Engine;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::Manager;

// ── Pinned artifacts ────────────────────────────────────────────────────────

/// whisper.cpp prebuilt CPU binaries.
/// b5454 = nightly that carries whisper-cli + ggml libs.
/// macOS has no standalone CLI bundle upstream (only an xcframework zip) —
/// local STT is Windows/Linux only; the setup command returns a clean error.
#[cfg(windows)]
const WHISPER_BIN_URL: &str =
    "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip";
#[cfg(target_os = "linux")]
const WHISPER_BIN_URL: &str =
    "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-x64.tar.gz";

/// Piper 1.2.0 (last rhasspy release; MIT). The macOS tarballs are broken
/// upstream (libonnxruntime.dylib is missing — only its empty .dSTM ships),
/// so local TTS is Windows/Linux only.
#[cfg(windows)]
const PIPER_BIN_URL: &str =
    "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip";
#[cfg(target_os = "linux")]
const PIPER_BIN_URL: &str =
    "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz";

#[cfg(not(any(windows, target_os = "linux")))]
const LOCAL_VOICE_UNSUPPORTED: &str =
    "Local voice engines aren't available on macOS yet — use API mode (or Browser STT).";

/// Quantized whisper models on the ggerganov HF repo (verified sizes:
/// tiny.en 32MB, base.en 59.7MB, small.en 190MB).
pub const STT_MODELS: &[(&str, &str, u64)] = &[
    ("tiny.en", "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en-q5_1.bin", 32_166_155),
    ("base.en", "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin", 59_721_011),
    ("small.en", "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin", 190_098_681),
];

/// Piper voices (en_US; verified: lessac-medium 63.2MB, amy-low 63.1MB).
/// Each voice needs `<id>.onnx` + `<id>.onnx.json` (the .json is tiny).
pub const TTS_VOICES: &[(&str, &str, u64)] = &[
    (
        "en_US-lessac-medium",
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx",
        63_201_294,
    ),
    (
        "en_US-amy-low",
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/low/en_US-amy-low.onnx",
        63_104_526,
    ),
];

/// Optional Silero VAD (885KB) — improves segmentation on longer clips.
#[cfg(any(windows, target_os = "linux"))]
const SILERO_URL: &str =
    "https://huggingface.co/ggml-org/silero-v5.1.2/resolve/main/ggml-silero-v5.1.2.bin";

static SETUP_RUNNING: AtomicBool = AtomicBool::new(false);

fn voice_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("voice"))
}

fn stt_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(voice_dir(app)?.join("stt"))
}

fn tts_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(voice_dir(app)?.join("tts"))
}

fn model_path(dir: &Path, model: &str) -> PathBuf {
    dir.join(format!("ggml-{model}.bin"))
}

fn voice_paths(dir: &Path, voice: &str) -> (PathBuf, PathBuf) {
    let base = dir.join(voice);
    (base.with_extension("onnx"), format!("{}.onnx.json", base.display()).into())
}

fn whisper_cli_path(dir: &Path) -> PathBuf {
    // The win zip extracts to whisper/Release/whisper-cli.exe; we FLATTEN at
    // extract time into stt/ so this is just stt/whisper-cli(.exe).
    #[cfg(windows)]
    return dir.join("whisper-cli.exe");
    #[cfg(not(windows))]
    dir.join("whisper-cli")
}

fn piper_path(dir: &Path) -> PathBuf {
    // Flattened at extract time into tts/.
    #[cfg(windows)]
    return dir.join("piper.exe");
    #[cfg(not(windows))]
    dir.join("piper")
}

// ── Status ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub stt_installed: bool,
    pub tts_installed: bool,
    pub stt_model: Option<String>,
    /// First installed TTS voice (legacy single-field view).
    pub tts_voice: Option<String>,
    /// Every voice currently on disk. The UI must check membership here —
    /// a `find`-first report made the second-installed voice show "Install"
    /// forever, and the runtime used it too (picked Amy, heard Lessac).
    pub tts_voices: Vec<String>,
}

#[tauri::command]
pub fn voice_status(app: tauri::AppHandle) -> Result<VoiceStatus, String> {
    let stt = stt_dir(&app)?;
    let tts = tts_dir(&app)?;
    let stt_installed = whisper_cli_path(&stt).exists();
    let tts_installed = piper_path(&tts).exists();
    let stt_model = STT_MODELS
        .iter()
        .find(|(name, _, _)| model_path(&stt, name).exists())
        .map(|(name, _, _)| name.to_string());
    let installed_voices: Vec<String> = TTS_VOICES
        .iter()
        .filter(|(name, _, _)| voice_paths(&tts, name).0.exists())
        .map(|(name, _, _)| name.to_string())
        .collect();
    let first = installed_voices.first().cloned();
    Ok(VoiceStatus {
        stt_installed,
        tts_installed,
        stt_model,
        tts_voice: first,
        tts_voices: installed_voices,
    })
}

// ── Download with progress ────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSetupEvent {
    pub phase: String,
    pub downloaded: u64,
    pub total: u64,
    pub message: Option<String>,
}

async fn download_with_progress(
    url: &str,
    dest: &Path,
    on_event: &Channel<VoiceSetupEvent>,
    phase: &str,
) -> Result<(), String> {
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (url, dest, on_event, phase);
        unreachable!()
    }
    #[cfg(any(windows, target_os = "linux"))]
    {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(600))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("download failed: HTTP {} from {url}", resp.status()));
        }
        let total = resp.content_length().unwrap_or(0);
        use futures_util::StreamExt;
        let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
        let mut downloaded: u64 = 0;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            downloaded += chunk.len() as u64;
            let _ = on_event.send(VoiceSetupEvent {
                phase: phase.to_string(),
                downloaded,
                total,
                message: None,
            });
        }
        file.flush().map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Extract a .zip, flattening nested `whisper/Release/` or `piper/piper/`
/// prefixes, keeping only the files the engines need.
#[cfg(windows)]
fn extract_zip_flat(zip_path: &Path, dest: &Path, keep: &[&str]) -> Result<(), String> {
    let f = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        let file_name = name.rsplit('/').next().unwrap_or("").to_string();
        // Keep by name/extension (win zips carry many test exes we don't want).
        // NOTE: espeak-ng-data must match on the FULL path — the basename
        // ("en_dict") never contains the prefix.
        let keep_it = keep.iter().any(|k| file_name == *k)
            || file_name.ends_with(".dll")
            || name.contains("espeak-ng-data/");
        if !keep_it {
            continue;
        }
        let out_path = if name.contains("espeak-ng-data/") {
            // Preserve the espeak-ng-data/ tree structure relative to the dir.
            let idx = name.find("espeak-ng-data/").unwrap_or(0);
            dest.join(&name[idx..])
        } else {
            dest.join(&file_name)
        };
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Extract a .tar.gz (linux piper / linux whisper). Handles the real-world
/// layouts: versioned shared libs (libwhisper.so.1.9.5) + their unversioned
/// SYMLINKS, the espeak-ng-data tree, and exec bits for engine binaries.
#[cfg(target_os = "linux")]
fn extract_tgz(tgz_path: &Path, dest: &Path, bins: &[&str]) -> Result<(), String> {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let f = std::fs::File::open(tgz_path).map_err(|e| e.to_string())?;
    let gz = flate2::read::GzDecoder::new(f);
    let mut archive = tar::Archive::new(gz);
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let is_dir = entry.header().entry_type().is_dir();
        let name = entry
            .path()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let file_name = name.rsplit('/').next().unwrap_or("").to_string();
        // Keep: engine binaries, shared libs (incl. versioned .so.N.N and
        // their symlink names), and the espeak-ng-data tree. Skip dirs,
        // test/bench binaries, .dSYM debug bundles, pkgconfig.
        let keep_it = !is_dir
            && (bins.contains(&file_name.as_str())
                || (file_name.starts_with("lib") && file_name.contains(".so"))
                || name.contains("espeak-ng-data/"));
        if !keep_it {
            continue;
        }
        let out_path = if let Some(idx) = name.find("espeak-ng-data/") {
            dest.join(&name[idx..])
        } else {
            dest.join(&file_name)
        };
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // Symlinks (e.g. libwhisper.so -> libwhisper.so.1): recreate, don't
        // copy — a copied symlink is an empty file and breaks the loader.
        let link = entry
            .link_name()
            .ok()
            .flatten()
            .map(|p| p.to_string_lossy().to_string());
        if let Some(target) = link {
            let _ = std::fs::remove_file(&out_path);
            symlink(&target, &out_path).map_err(|e| e.to_string())?;
            continue;
        }
        let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        // Engine binaries need the exec bit (tar mode doesn't survive our
        // manual copy — files default to 0644 under umask).
        if bins.contains(&file_name.as_str()) {
            std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ── Setup commands ────────────────────────────────────────────────────────

/// Install the whisper.cpp binary + a chosen model (+ optional Silero VAD).
#[tauri::command]
pub async fn voice_setup_stt(
    app: tauri::AppHandle,
    model: String,
    on_event: Channel<VoiceSetupEvent>,
) -> Result<(), String> {
    if SETUP_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("voice setup already in progress".into());
    }
    let result = setup_stt_inner(&app, &model, &on_event).await;
    SETUP_RUNNING.store(false, Ordering::SeqCst);
    result
}

async fn setup_stt_inner(
    app: &tauri::AppHandle,
    model: &str,
    on_event: &Channel<VoiceSetupEvent>,
) -> Result<(), String> {
    // macOS: no standalone whisper.cpp CLI bundle exists upstream — local
    // STT is Windows/Linux only.
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (app, model, on_event);
        return Err(LOCAL_VOICE_UNSUPPORTED.to_string());
    }
    #[cfg(any(windows, target_os = "linux"))]
    {
    let (_, url, size) = STT_MODELS
        .iter()
        .find(|(n, _, _)| n == &model)
        .ok_or_else(|| format!("unknown model \"{model}\""))?;
    let dir = stt_dir(app)?;
    let tmp = dir.join("download.part");

    // 1. Binary (skip if present).
    if !whisper_cli_path(&dir).exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let _ = on_event.send(VoiceSetupEvent {
            phase: "stt-bin".into(),
            downloaded: 0,
            total: 0,
            message: Some("downloading whisper.cpp…".into()),
        });
        download_with_progress(WHISPER_BIN_URL, &tmp, on_event, "stt-bin").await?;
        #[cfg(windows)]
        extract_zip_flat(&tmp, &dir, &["whisper-cli.exe", "ggml.dll", "whisper.dll", "SDL2.dll"])?;
        #[cfg(target_os = "linux")]
        extract_tgz(&tmp, &dir, &["whisper-cli"])?;
        let _ = std::fs::remove_file(&tmp);
    }

    // 2. Model.
    let mpath = model_path(&dir, model);
    if !mpath.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let _ = on_event.send(VoiceSetupEvent {
            phase: "stt-model".into(),
            downloaded: 0,
            total: *size,
            message: Some(format!("downloading {model} model…")),
        });
        download_with_progress(url, &mpath, on_event, "stt-model").await?;
    }

    // 3. Silero VAD (tiny, 885KB — always install; improves segmentation).
    let vad = dir.join("ggml-silero-v5.1.2.bin");
    if !vad.exists() {
        let _ = download_with_progress(SILERO_URL, &vad, on_event, "stt-vad").await;
    }

    let _ = on_event.send(VoiceSetupEvent {
        phase: "done".into(),
        downloaded: 0,
        total: 0,
        message: Some("local STT ready".into()),
    });
    Ok(())
    }
}

/// Install Piper + a chosen voice.
#[tauri::command]
pub async fn voice_setup_tts(
    app: tauri::AppHandle,
    voice: String,
    on_event: Channel<VoiceSetupEvent>,
) -> Result<(), String> {
    if SETUP_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("voice setup already in progress".into());
    }
    let result = setup_tts_inner(&app, &voice, &on_event).await;
    SETUP_RUNNING.store(false, Ordering::SeqCst);
    result
}

async fn setup_tts_inner(
    app: &tauri::AppHandle,
    voice: &str,
    on_event: &Channel<VoiceSetupEvent>,
) -> Result<(), String> {
    // macOS: the rhasspy piper tarballs are broken upstream (missing
    // libonnxruntime.dylib) — local TTS is Windows/Linux only.
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (app, voice, on_event);
        return Err(LOCAL_VOICE_UNSUPPORTED.to_string());
    }
    #[cfg(any(windows, target_os = "linux"))]
    {
    let (_, url, size) = TTS_VOICES
        .iter()
        .find(|(n, _, _)| n == &voice)
        .ok_or_else(|| format!("unknown voice \"{voice}\""))?;
    let dir = tts_dir(app)?;
    let tmp = dir.join("download.part");

    // 1. Binary + espeak data (skip if present).
    if !piper_path(&dir).exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let _ = on_event.send(VoiceSetupEvent {
            phase: "tts-bin".into(),
            downloaded: 0,
            total: 0,
            message: Some("downloading Piper…".into()),
        });
        download_with_progress(PIPER_BIN_URL, &tmp, on_event, "tts-bin").await?;
        #[cfg(windows)]
        extract_zip_flat(&tmp, &dir, &["piper.exe", "espeak-ng.dll", "onnxruntime.dll", "onnxruntime_providers_shared.dll", "piper_phonemize.dll", "libtashkeel_model.ort"])?;
        #[cfg(target_os = "linux")]
        extract_tgz(&tmp, &dir, &["piper"])?;
        let _ = std::fs::remove_file(&tmp);
    }

    // 2. Voice (onnx + onnx.json).
    let (vonnx, vjson) = voice_paths(&dir, voice);
    if !vonnx.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let _ = on_event.send(VoiceSetupEvent {
            phase: "tts-voice".into(),
            downloaded: 0,
            total: *size,
            message: Some(format!("downloading {voice} voice…")),
        });
        download_with_progress(url, &vonnx, on_event, "tts-voice").await?;
    }
    let json_url = format!("{url}.json");
    if !vjson.exists() {
        let _ = download_with_progress(&json_url, &vjson, on_event, "tts-voice-json").await;
    }

    let _ = on_event.send(VoiceSetupEvent {
        phase: "done".into(),
        downloaded: 0,
        total: 0,
        message: Some("local TTS ready".into()),
    });
    Ok(())
    }
}

/// Remove both engines and all models (~150MB freed).
#[tauri::command]
pub fn voice_remove_local(app: tauri::AppHandle) -> Result<(), String> {
    let dir = voice_dir(&app)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Runtime: transcribe / synthesize ──────────────────────────────────────

/// Transcribe WAV bytes with whisper-cli. `audio_base64` is raw WAV
/// (16-bit PCM 16kHz mono — the frontend records this format). Returns the
/// transcript text (whisper.cpp prints timestamped lines to stderr and the
/// plain text to stdout; we use -nt for no-timestamps plain stdout).
#[tauri::command]
pub async fn voice_transcribe(
    app: tauri::AppHandle,
    audio_base64: String,
) -> Result<String, String> {
    // macOS: no local engine can be installed (see setup_stt_inner).
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (app, audio_base64);
        return Err(LOCAL_VOICE_UNSUPPORTED.to_string());
    }
    #[cfg(any(windows, target_os = "linux"))]
    {
    let dir = stt_dir(&app)?;
    let cli = whisper_cli_path(&dir);
    if !cli.exists() {
        return Err("local STT not installed — run setup in Settings → Voice".into());
    }
    let model = STT_MODELS
        .iter()
        .find(|(n, _, _)| model_path(&dir, n).exists())
        .map(|(n, _, _)| n.to_string())
        .ok_or_else(|| "no whisper model installed".to_string())?;
    let mpath = model_path(&dir, &model);
    let vad = dir.join("ggml-silero-v5.1.2.bin");

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.as_bytes())
        .map_err(|e| format!("bad audio base64: {e}"))?;

    // Write the WAV to a temp file instead of piping to stdin: whisper-cli
    // b5454's stdin path is broken on Windows — it reads the bytes but the
    // transcript never reaches stdout (unless -of is also passed). File
    // input transcribes correctly (verified end-to-end).
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_wav = std::env::temp_dir().join(format!("kai-stt-{}-{nanos}.wav", std::process::id()));
    std::fs::write(&tmp_wav, &bytes).map_err(|e| format!("temp wav write: {e}"))?;

    let mut cmd = std::process::Command::new(&cli);
    cmd.arg("-m").arg(&mpath)
        .arg("-nt")           // no timestamps on stdout
        .arg("-np")           // no prints (loading bar)
        .arg("-l").arg("en")
        .arg("-f").arg(&tmp_wav); // file input (stdin path is broken, see above)
    // VAD improves long-clip segmentation (whisper.cpp ≥1.9, verified flags:
    // --vad + --vad-model).
    if vad.exists() {
        cmd.arg("--vad").arg("--vad-model").arg(&vad);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let run = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let result = (|| -> Result<String, String> {
            let child = cmd.spawn().map_err(|e| format!("spawn whisper-cli: {e}"))?;
            let out = child
                .wait_with_output()
                .map_err(|e| format!("whisper-cli run: {e}"))?;
            if !out.status.success() {
                let err = String::from_utf8_lossy(&out.stderr);
                return Err(format!("whisper-cli failed: {}", err.trim().chars().take(400).collect::<String>()));
            }
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        })();
        let _ = std::fs::remove_file(&tmp_wav);
        result
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(run)
    }
}

/// Synthesize speech with Piper. Returns WAV bytes (base64) for the frontend
/// to play via a blob URL.
#[tauri::command]
pub async fn voice_tts(
    app: tauri::AppHandle,
    text: String,
    voice_arg: Option<String>,
) -> Result<String, String> {
    // macOS: no local engine can be installed (see setup_tts_inner).
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (app, text, voice_arg);
        return Err(LOCAL_VOICE_UNSUPPORTED.to_string());
    }
    #[cfg(any(windows, target_os = "linux"))]
    {
    let dir = tts_dir(&app)?;
    let piper = piper_path(&dir);
    if !piper.exists() {
        return Err("local TTS not installed — run setup in Settings → Voice".into());
    }
    // Honor the caller's requested voice when it is actually installed.
    // (Previously this picked the FIRST installed voice regardless of the
    // user's selection — picking Amy with Lessac also on disk played Lessac.)
    let installed: Vec<String> = TTS_VOICES
        .iter()
        .filter(|(n, _, _)| voice_paths(&dir, n).0.exists())
        .map(|(n, _, _)| n.to_string())
        .collect();
    let voice = match voice_arg.as_deref() {
        Some(v) if installed.iter().any(|i| i == v) => v.to_string(),
        _ => installed
            .first()
            .cloned()
            .ok_or_else(|| "no piper voice installed".to_string())?,
    };
    let (vonnx, _) = voice_paths(&dir, &voice);
    let espeak = dir.join("espeak-ng-data");

    // Piper must write to a real FILE, not stdout: on Windows its `-f -`
    // stdout stream is opened in text mode and every 0x0A byte becomes
    // 0x0D 0x0A — the WAV arrives as full-scale static. Same text to `-f
    // <file>` transcribes perfectly through whisper (verified).
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_out = std::env::temp_dir().join(format!("kai-tts-{}-{nanos}.wav", std::process::id()));

    let mut cmd = std::process::Command::new(&piper);
    cmd.arg("--model").arg(&vonnx)
        .arg("--espeak_data").arg(&espeak)
        .arg("-q")
        .arg("-f").arg(&tmp_out);
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let run = tokio::task::spawn_blocking(move || -> Result<String, String> {
        use std::io::Write as _;
        let result = (|| -> Result<String, String> {
            let mut child = cmd.spawn().map_err(|e| format!("spawn piper: {e}"))?;
            {
                let mut stdin = child.stdin.take().ok_or("no stdin")?;
                let _ = stdin.write_all(text.as_bytes());
            }
            let out = child
                .wait_with_output()
                .map_err(|e| format!("piper run: {e}"))?;
            if !out.status.success() {
                let err = String::from_utf8_lossy(&out.stderr);
                return Err(format!("piper failed: {}", err.trim().chars().take(400).collect::<String>()));
            }
            let wav = std::fs::read(&tmp_out)
                .map_err(|e| format!("piper output missing: {e}"))?;
            Ok(base64::engine::general_purpose::STANDARD.encode(&wav))
        })();
        let _ = std::fs::remove_file(&tmp_out);
        result
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(run)
    }
}

/// Sweep stale download .part files (crash leftovers) at boot. Public so
/// lib.rs setup calls it; no-op when the dir doesn't exist.
pub fn sweep_stale_voice_parts(app: &tauri::AppHandle) {
    let Ok(dir) = voice_dir(app) else { return };
    for sub in [dir.join("stt"), dir.join("tts")] {
        for entry in std::fs::read_dir(&sub).into_iter().flatten().flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("part") {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
}
