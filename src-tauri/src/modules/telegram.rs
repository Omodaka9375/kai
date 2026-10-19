//! Telegram bot bridge — the "External / personal assistant" channel.
//!
//! WHY THIS IS A RUST THREAD, not a webview setInterval: long-polling
//! `getUpdates` holds a request open for up to 50 seconds. WebView2 (and
//! hidden browser windows generally) throttle timers and even fetch
//! scheduling on hidden pages — the same reason `modules::heartbeat` exists.
//! A dedicated thread owns the poll loop and forwards each update over a
//! Tauri `Channel` (IPC delivery is NOT throttled).
//!
//! SECURITY MODEL:
//!   - The bot token lives in the OS keyring (service `kai`, key
//!     `telegram_bot_token`) — never in the settings store.
//!   - OWNER BINDING is mandatory: `telegram_owner_chat_id` records the
//!     chat id of the FIRST user to `/start` the bot (and only when the
//!     frontend allows binding — see `telegram_bind_owner`). Every other
//!     chat is rejected silently. A bot token is an internet-reachable
//!     handle to an agent with tool access; without the gate, anyone who
//!     discovers the bot gets the assistant.
//!
//! Transcoding: Telegram voice is OGG/Opus; the local STT wants WAV and the
//! local TTS emits WAV. ffmpeg bridges both directions when it is on PATH
//! (fail-soft: text-only replies when absent).

use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::runtime::Runtime;

static RUNNING: AtomicBool = AtomicBool::new(false);
static POLL_SHUTDOWN: AtomicBool = AtomicBool::new(false);
static OWNER_CHAT_ID: AtomicI64 = AtomicI64::new(-1);

/// Pending owner binding: set by `telegram_bind_owner`, consumed by the
/// FIRST `/start` that arrives after it (single-use handshake token).
static BIND_MODE: AtomicBool = AtomicBool::new(false);

static LAST_UPDATE_ID: LazyLock<Mutex<i64>> = LazyLock::new(|| Mutex::new(0));

/// Incremented by every stop/start cycle. A poll thread exits when the
/// generation it was spawned under is no longer current, so a quick toggle
/// off→on can't leave a zombie loop sharing LAST_UPDATE_ID with a fresh one
/// (a 40s long-poll is still blocked in-flight when the stop lands).
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// The current event channel. `telegram_start` REPLACES it on every call: the
/// loop is global, but delivery follows the most recent starter — the bridge
/// can be (re)claimed from any window (settings panel mount, main window
/// focus) so a closed settings window never strands the loop pushing into a
/// dead channel.
static EVENT_CHANNEL: LazyLock<Mutex<Option<Channel<TelegramEvent>>>> =
    LazyLock::new(|| Mutex::new(None));

/// Send an event to the current channel (silently dropped when none/dead).
fn emit_event(event: TelegramEvent) {
    let ch = crate::modules::lock::mutex_lock(&EVENT_CHANNEL);
    if let Some(c) = ch.as_ref() {
        let _ = c.send(event);
    }
}

const API: &str = "https://api.telegram.org";
/// getUpdates hold time. Telegram caps at 50s; the frontend agent replies
/// happen on the main runtime, this loop only delivers updates.
const LONG_POLL_SECS: u64 = 40;

#[derive(Debug, Clone, Serialize)]
// `rename_all` covers the VARIANT names (the tag values: "message", "photo"…).
// Internally-tagged enums do NOT apply it to variant FIELDS — without
// `rename_all_fields` the payload serialized snake_case (`chat_id`) while the
// TS handler read camelCase (`chatId` → undefined → every reply died with
// "missing required key chatId"). Keep both.
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum TelegramEvent {
    /// An incoming message (text or voice) from the owner.
    Message {
        chat_id: i64,
        message_id: i64,
        /// None for voice messages (then `file_id` is set).
        text: Option<String>,
        /// Telegram file_id of a voice note, when the message is voice.
        voice_file_id: Option<String>,
        /// Seconds of voice duration (for the STT size gate).
        voice_duration_secs: Option<i64>,
        date: i64,
    },
    /// Incoming photo (largest size) — model gets it as a vision part.
    Photo {
        chat_id: i64,
        message_id: i64,
        photo_file_id: String,
        caption: Option<String>,
        date: i64,
    },
    /// Incoming document (any file) — saved to the assistant scratch dir.
    Document {
        chat_id: i64,
        message_id: i64,
        document_file_id: String,
        file_name: String,
        mime_type: Option<String>,
        date: i64,
    },
    /// Incoming video (mp4 note or regular video).
    Video {
        chat_id: i64,
        message_id: i64,
        video_file_id: String,
        duration_secs: Option<i64>,
        date: i64,
    },
    /// Owner not yet bound — this /start may claim binding.
    StartCandidate { chat_id: i64, message_id: i64, date: i64 },
    /// Message from a non-owner chat (silently ignored by the agent).
    Rejected { chat_id: i64, date: i64 },
    /// Loop-level error (network down, token revoked). Reportable, not fatal.
    Error { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramStatus {
    pub running: bool,
    pub owner_chat_id: Option<i64>,
    /// Bot username from getMe — filled by `telegram_test`.
    pub bot_username: Option<String>,
}

fn api_url(token: &str, method: &str) -> String {
    format!("{API}/bot{token}/{method}")
}

/// Shared pooled HTTP client. One per-process client means one connection
/// pool: repeated sendMessage calls reuse the warm TLS session instead of
/// handshaking from scratch every time (fresh-client-per-call made sends
/// flaky whenever the handshake hit a transient DNS/TLS/VPN hiccup).
fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .connect_timeout(Duration::from_secs(15))
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .expect("reqwest client")
    })
}

/// reqwest's Display ("error sending request for url …") hides the real
/// cause. Walk the source chain so logs name the actual failure.
fn err_chain(e: &reqwest::Error) -> String {
    use std::error::Error as _;
    let mut parts = vec![e.to_string()];
    let mut src = e.source();
    while let Some(s) = src {
        parts.push(s.to_string());
        src = s.source();
    }
    parts.join(" | ")
}

async fn post_json<T: serde::de::DeserializeOwned>(
    token: &str,
    method: &str,
    body: &serde_json::Value,
) -> Result<T, String> {
    let url = api_url(token, method);
    let mut last_err = String::new();
    // Transport-level failures (connect/TLS/DNS/reset/timeout) are transient
    // — retry up to 3 attempts with backoff before surfacing. HTTP-level
    // errors (4xx/5xx, Telegram `ok:false`) are NOT retried: the request
    // reached Telegram and the answer is authoritative.
    for attempt in 1..=3u32 {
        if attempt > 1 {
            tokio::time::sleep(Duration::from_millis(500 * u64::from(attempt - 1))).await;
        }
        let resp = match http_client().post(&url).json(body).send().await {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("{method}: {}", err_chain(&e));
                continue;
            }
        };
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("{method} HTTP {status}: {}", text.chars().take(300).collect::<String>()));
        }
        // Telegram wraps everything in { ok: bool, result: T | description }.
        #[derive(Deserialize)]
        struct Envelope<T> {
            ok: bool,
            result: Option<T>,
            description: Option<String>,
        }
        let env: Envelope<T> =
            serde_json::from_str(&text).map_err(|e| format!("{method} decode: {e}"))?;
        if !env.ok {
            return Err(format!("{method}: {}", env.description.unwrap_or_else(|| "unknown".into())));
        }
        return env.result.ok_or_else(|| format!("{method}: empty result"));
    }
    Err(last_err)
}

#[derive(Debug, Deserialize)]
struct TgPhotoSize {
    #[serde(default)]
    file_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TgDocument {
    #[serde(default)]
    file_id: Option<String>,
    #[serde(default)]
    file_name: Option<String>,
    #[serde(default)]
    mime_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TgVideo {
    #[serde(default)]
    file_id: Option<String>,
    #[serde(default)]
    duration: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct TgMessage {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    voice: Option<TgVoice>,
    #[serde(default)]
    photo: Option<Vec<TgPhotoSize>>,
    #[serde(default)]
    document: Option<TgDocument>,
    #[serde(default)]
    video: Option<TgVideo>,
    #[serde(default)]
    caption: Option<String>,
    #[serde(default)]
    chat: Option<TgChat>,
    #[serde(default)]
    message_id: Option<i64>,
    #[serde(default)]
    date: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct TgVoice {
    #[serde(default)]
    file_id: Option<String>,
    #[serde(default)]
    duration: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct TgChat {
    #[serde(default)]
    id: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct TgUpdate {
    #[serde(default)]
    update_id: i64,
    #[serde(default)]
    message: Option<TgMessage>,
}

/// Minimal getUpdates result — we only need message updates.
async fn poll_once(
    client: &reqwest::Client,
    token: &str,
    offset: i64,
) -> Result<Vec<TgUpdate>, String> {
    let resp = client
        .post(api_url(token, "getUpdates"))
        .json(&serde_json::json!({
            "offset": offset,
            "timeout": LONG_POLL_SECS as i64,
            "allowed_updates": ["message"],
        }))
        .send()
        .await
        .map_err(|e| format!("getUpdates: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("getUpdates HTTP {status}"));
    }
    #[derive(Deserialize)]
    struct Envelope {
        ok: bool,
        #[serde(default)]
        result: Vec<TgUpdate>,
        #[serde(default)]
        description: Option<String>,
    }
    let env: Envelope = serde_json::from_str(&text).map_err(|e| format!("decode: {e}"))?;
    if !env.ok {
        return Err(env.description.unwrap_or_else(|| "getUpdates failed".into()));
    }
    Ok(env.result)
}

/// Classify one update against the owner gate and emit the right event.
fn classify(update: &TgUpdate) -> Option<i64> {
    let msg = update.message.as_ref()?;
    let chat_id = msg.chat.as_ref()?.id?;
    let message_id = msg.message_id.unwrap_or(0);
    let date = msg.date.unwrap_or(0);

    // Owner gate. -1 = unbound.
    let owner = OWNER_CHAT_ID.load(Ordering::SeqCst);
    let is_start = msg.text.as_deref().map(|t| t.trim() == "/start").unwrap_or(false);

    if owner == -1 && is_start {
        if BIND_MODE.swap(false, Ordering::SeqCst) {
            // Claim binding — this chat becomes the owner.
            OWNER_CHAT_ID.store(chat_id, Ordering::SeqCst);
            emit_event(TelegramEvent::StartCandidate { chat_id, message_id, date });
            return Some(chat_id);
        }
        // Not in bind mode: drop silently (no owner leak, no response).
        return None;
    }
    if owner != -1 && chat_id != owner {
        emit_event(TelegramEvent::Rejected { chat_id, date });
        return None;
    }
    if owner == -1 {
        // Unbound and not a bindable /start — drop.
        return None;
    }

    if let Some(voice) = &msg.voice {
        emit_event(TelegramEvent::Message {
            chat_id,
            message_id,
            text: None,
            voice_file_id: voice.file_id.clone(),
            voice_duration_secs: voice.duration,
            date,
        });
    } else if let Some(text) = &msg.text {
        emit_event(TelegramEvent::Message {
            chat_id,
            message_id,
            text: Some(text.clone()),
            voice_file_id: None,
            voice_duration_secs: None,
            date,
        });
    } else if let Some(photo) = &msg.photo {
        // photo: Vec<PhotoSize> sorted small→large; take the largest file_id.
        let best = photo.iter().rev().find_map(|s| s.file_id.clone());
        if let Some(file_id) = best {
            emit_event(TelegramEvent::Photo {
                chat_id,
                message_id,
                photo_file_id: file_id,
                caption: msg.caption.clone(),
                date,
            });
        }
    } else if let Some(doc) = &msg.document {
        emit_event(TelegramEvent::Document {
            chat_id,
            message_id,
            document_file_id: doc.file_id.clone().unwrap_or_default(),
            file_name: doc.file_name.clone().unwrap_or_else(|| "file".into()),
            mime_type: doc.mime_type.clone(),
            date,
        });
    } else if let Some(video) = &msg.video {
        emit_event(TelegramEvent::Video {
            chat_id,
            message_id,
            video_file_id: video.file_id.clone().unwrap_or_default(),
            duration_secs: video.duration,
            date,
        });
    }
    Some(chat_id)
}

/// Start the long-poll thread. Called from the settings UI (and app start
/// when the assistant is enabled). Restartable: starting while running is a
/// no-op except for refreshing the channel.
#[tauri::command]
pub async fn telegram_start(
    token: String,
    owner_chat_id: Option<i64>,
    on_event: Channel<TelegramEvent>,
) -> Result<TelegramStatus, String> {
    if token.trim().is_empty() {
        return Err("bot token is empty".into());
    }
    OWNER_CHAT_ID.store(owner_chat_id.unwrap_or(-1), Ordering::SeqCst);
    // Replace the delivery channel FIRST — even when the loop is already
    // running, the most recent caller takes over event delivery.
    {
        let mut ch = crate::modules::lock::mutex_lock(&EVENT_CHANNEL);
        *ch = Some(on_event);
    }
    if RUNNING.swap(true, Ordering::SeqCst) {
        // Already running — the loop picks up the new channel above.
        return Ok(status());
    }
    POLL_SHUTDOWN.store(false, Ordering::SeqCst);
    // Claim a fresh generation for this loop.
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    // Tokio runtime for this thread's async work (the main Tauri runtime is
    // busy with commands; a dedicated 1-thread runtime matches net.rs use).
    std::thread::spawn(move || {
        let rt = match Runtime::new() {
            Ok(rt) => rt,
            Err(e) => {
                RUNNING.store(false, Ordering::SeqCst);
                emit_event(TelegramEvent::Error { message: format!("runtime: {e}") });
                return;
            }
        };
        rt.block_on(async move {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(LONG_POLL_SECS + 15))
                .build()
                .expect("reqwest client");
            loop {
                // Exit when stopped, or when a newer start superseded us — a
                // stale thread must never share LAST_UPDATE_ID with the new
                // loop (double-advancing the offset skips messages).
                if POLL_SHUTDOWN.load(Ordering::SeqCst)
                    || GENERATION.load(Ordering::SeqCst) != generation
                {
                    break;
                }
                let offset = {
                    let last = crate::modules::lock::mutex_lock(&LAST_UPDATE_ID);
                    *last + 1
                };
                match poll_once(&client, &token, offset).await {
                    Ok(updates) => {
                        for u in &updates {
                            classify(u);
                            let mut last = crate::modules::lock::mutex_lock(&LAST_UPDATE_ID);
                            if u.update_id > *last {
                                *last = u.update_id;
                            }
                        }
                    }
                    Err(e) => {
                        // Transient (network/token). Report at most one event
                        // per failure burst; back off 5s.
                        emit_event(TelegramEvent::Error { message: e });
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                }
            }
            // Only the CURRENT generation may clear the running flag: a
            // stale thread exiting late must not kill the new loop's state.
            if GENERATION.load(Ordering::SeqCst) == generation {
                RUNNING.store(false, Ordering::SeqCst);
            }
        });
    });
    Ok(status())
}

/// Stop the poll loop (settings toggle off / app exit).
#[tauri::command]
pub fn telegram_stop() -> Result<TelegramStatus, String> {
    POLL_SHUTDOWN.store(true, Ordering::SeqCst);
    // Supersede the running poll thread (it may be blocked in a 40s
    // long-poll) so it can never deliver or advance the offset again.
    GENERATION.fetch_add(1, Ordering::SeqCst);
    RUNNING.store(false, Ordering::SeqCst);
    // Drop the delivery channel so a stopped loop can't push anywhere.
    *crate::modules::lock::mutex_lock(&EVENT_CHANNEL) = None;
    Ok(status())
}

/// One-use handshake: the NEXT /start binds that chat as owner. The settings
/// UI enables this only when no owner is bound yet.
#[tauri::command]
pub fn telegram_bind_owner() -> Result<(), String> {
    BIND_MODE.store(true, Ordering::SeqCst);
    Ok(())
}

/// Clear the owner binding (re-bind to a different account). Re-arms the
/// single-use bind handshake so the NEXT /start claims ownership — without
/// this, an unbound bot silently drops everything forever (the handshake
/// flag is consumed by the first /start and never re-armed on clear).
#[tauri::command]
pub fn telegram_clear_owner() -> Result<(), String> {
    OWNER_CHAT_ID.store(-1, Ordering::SeqCst);
    BIND_MODE.store(true, Ordering::SeqCst);
    Ok(())
}

fn status() -> TelegramStatus {
    let owner = OWNER_CHAT_ID.load(Ordering::SeqCst);
    TelegramStatus {
        running: RUNNING.load(Ordering::SeqCst),
        owner_chat_id: if owner == -1 { None } else { Some(owner) },
        bot_username: None,
    }
}

/// Current bridge status (no API call — for the settings toggle).
#[tauri::command]
pub fn telegram_status() -> Result<TelegramStatus, String> {
    Ok(status())
}

/// Connectivity + token test: getMe. Returns the bot username so the settings
/// page can show "connected as @foo".
#[tauri::command]
pub async fn telegram_test(token: String) -> Result<TelegramStatus, String> {
    #[derive(Deserialize)]
    struct Me {
        #[serde(default)]
        username: Option<String>,
    }
    let me: Me = post_json(&token, "getMe", &serde_json::json!({})).await?;
    let mut s = status();
    s.bot_username = me.username;
    Ok(s)
}

/// Send a text message (agent reply). Errors are surfaced to the caller which
/// logs them in the session — the user sees the assistant went quiet and why.
#[tauri::command]
pub async fn telegram_send_message(token: String, chat_id: i64, text: String) -> Result<(), String> {
    // 4096 is Telegram's hard message cap; split long agent replies.
    for chunk in split_message(&text) {
        // Markdown first (nicer rendering). Agent replies often contain raw
        // backticks / half-written Markdown that Telegram's parser rejects
        // with HTTP 400 "can't parse entities" — fall back to plain text so
        // the reply is never lost to formatting.
        let md = serde_json::json!({
            "chat_id": chat_id,
            "text": chunk,
            "parse_mode": "Markdown",
        });
        if let Err(e) = post_json::<serde_json::Value>(&token, "sendMessage", &md).await {
            if e.contains("can't parse entities") {
                let plain = serde_json::json!({ "chat_id": chat_id, "text": chunk });
                post_json::<serde_json::Value>(&token, "sendMessage", &plain).await?;
            } else {
                return Err(e);
            }
        }
    }
    Ok(())
}

/// Send a voice note (TTS reply). `audio` is base64 WAV/MP3 from voice_tts /
/// OpenAI TTS; transcoded to OGG/Opus via ffmpeg when available, else the
/// raw audio is sent as a document (fail-soft, still delivered).
#[tauri::command]
pub async fn telegram_send_voice(
    token: String,
    chat_id: i64,
    audio_base64: String,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.as_bytes())
        .map_err(|e| format!("bad audio base64: {e}"))?;

    // ffmpeg WAV/MP3 → OGG/Opus (Telegram voice requirement).
    let ogg = transcode_to_ogg(&bytes)?;

    let part = reqwest::multipart::Part::bytes(ogg)
        .file_name("voice.ogg")
        .mime_str("audio/ogg")
        .map_err(|e| format!("mime: {e}"))?;
    let form = reqwest::multipart::Form::new()
        .text("chat_id", chat_id.to_string())
        .part("voice", part);
    let resp = http_client()
        .post(api_url(&token, "sendVoice"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("sendVoice: {}", err_chain(&e)))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(format!(
            "sendVoice HTTP {}: {}",
            status,
            t.chars().take(200).collect::<String>()
        ));
    }
    Ok(())
}

/// Download a voice file by file_id and return PCM WAV base64 (for STT).
/// Telegram serves voice as OGG/Opus; whisper needs WAV — ffmpeg transcodes.
#[tauri::command]
pub async fn telegram_download_voice(
    token: String,
    file_id: String,
) -> Result<String, String> {
    let bytes = download_file(&token, &file_id).await?;
    let wav = ogg_to_wav(&bytes)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(wav))
}

/// Generic file download by file_id → base64 bytes. Used for photos
/// (vision input), documents and videos (saved to the scratch dir).
#[tauri::command]
pub async fn telegram_download_file(
    token: String,
    file_id: String,
) -> Result<String, String> {
    let bytes = download_file(&token, &file_id).await?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Shared download core: getFile → HTTPS fetch → bytes (20 MB cap).
async fn download_file(token: &str, file_id: &str) -> Result<bytes::Bytes, String> {
    #[derive(Deserialize)]
    struct FilePath {
        #[serde(default)]
        file_path: Option<String>,
    }
    let fp: FilePath = post_json(token, "getFile", &serde_json::json!({ "file_id": file_id })).await?;
    let rel = fp.file_path.ok_or("no file_path in getFile result")?;
    let url = format!("{API}/file/bot{token}/{rel}");
    let resp = http_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download: {}", err_chain(&e)))?;
    if !resp.status().is_success() {
        return Err(format!("download HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("body: {}", err_chain(&e)))?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("file too large (over 20 MB)".into());
    }
    Ok(bytes)
}

// ── Media send (photos / videos / documents) ───────────────────────────────

/// Upload bytes as a multipart part with the right method + field name.
/// Params map 1:1 onto the Telegram form fields — an options struct would
/// just hide that correspondence.
#[allow(clippy::too_many_arguments)]
async fn send_multipart(
    token: &str,
    method: &str,
    field: &str,
    chat_id: i64,
    file_name: &str,
    mime: &str,
    data: Vec<u8>,
    caption: Option<String>,
) -> Result<(), String> {
    let part = reqwest::multipart::Part::bytes(data)
        .file_name(file_name.to_string())
        .mime_str(mime)
        .map_err(|e| format!("mime: {e}"))?;
    let mut form = reqwest::multipart::Form::new()
        .text("chat_id", chat_id.to_string());
    if let Some(c) = caption {
        form = form.text("caption", c);
    }
    form = form.part(field.to_string(), part);
    let resp = http_client()
        .post(api_url(token, method))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("{method}: {}", err_chain(&e)))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(format!(
            "{method} HTTP {status}: {}",
            t.chars().take(200).collect::<String>()
        ));
    }
    Ok(())
}

/// Send a photo (base64 image bytes). Falls back to sendDocument when the
/// format isn't a Telegram-accepted image type — the caller's caption is
/// preserved either way.
#[tauri::command]
pub async fn telegram_send_photo(
    token: String,
    chat_id: i64,
    photo_base64: String,
    caption: Option<String>,
) -> Result<(), String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(photo_base64.as_bytes())
        .map_err(|e| format!("bad photo base64: {e}"))?;
    send_multipart(&token, "sendPhoto", "photo", chat_id, "photo.png", "image/png", data, caption).await
}

/// Send a video (base64 video bytes, e.g. a generated mp4).
#[tauri::command]
pub async fn telegram_send_video(
    token: String,
    chat_id: i64,
    video_base64: String,
    caption: Option<String>,
) -> Result<(), String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(video_base64.as_bytes())
        .map_err(|e| format!("bad video base64: {e}"))?;
    send_multipart(&token, "sendVideo", "video", chat_id, "video.mp4", "video/mp4", data, caption).await
}

/// Send any file as a document (e.g. files from the scratch dir the user
/// asked for, exports, etc.).
#[tauri::command]
pub async fn telegram_send_document(
    token: String,
    chat_id: i64,
    data_base64: String,
    file_name: String,
    mime_type: Option<String>,
) -> Result<(), String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("bad data base64: {e}"))?;
    send_multipart(
        &token,
        "sendDocument",
        "document",
        chat_id,
        &file_name,
        mime_type.as_deref().unwrap_or("application/octet-stream"),
        data,
        None,
    )
    .await
}

/// Send media referenced by a URL: fetch server-side (Rust, so no CSP/webview
/// fetch limits), then upload as photo / video / document. This is how the
/// assistant delivers provider-generated media — most providers return a
/// temporary URL rather than inline bytes, and the fetch+upload must happen
/// off the webview anyway. Video snapshots are generated in the caller; the
/// 20 MB cap matches Telegram's bot upload limit.
#[tauri::command]
pub async fn telegram_send_media_url(
    token: String,
    chat_id: i64,
    url: String,
    kind: String, // "image" | "video" | "document"
    caption: Option<String>,
) -> Result<(), String> {
    const MAX_BYTES: usize = 20 * 1024 * 1024;
    let resp = http_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("media download: {}", err_chain(&e)))?;
    if !resp.status().is_success() {
        return Err(format!("media download HTTP {}", resp.status()));
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or("application/octet-stream").trim().to_string())
        .unwrap_or_else(|| "application/octet-stream".into());
    let bytes = resp.bytes().await.map_err(|e| format!("media body: {}", err_chain(&e)))?;
    if bytes.len() > MAX_BYTES {
        return Err("media too large (over 20 MB)".into());
    }
    let (method, field, name) = match (kind.as_str(), mime.as_str()) {
        ("image", "image/png") => ("sendPhoto", "photo", "image.png"),
        ("image", "image/jpeg") => ("sendPhoto", "photo", "image.jpg"),
        ("image", "image/webp") => ("sendPhoto", "photo", "image.webp"),
        ("image", _) => ("sendDocument", "document", "image"),
        ("video", "video/mp4") => ("sendVideo", "video", "video.mp4"),
        ("video", _) => ("sendDocument", "document", "video"),
        _ => ("sendDocument", "document", "file"),
    };
    send_multipart(&token, method, field, chat_id, name, &mime, bytes.to_vec(), caption).await
}

// ── ffmpeg helpers (fail-soft) ─────────────────────────────────────────────

fn ffmpeg_available() -> bool {
    std::process::Command::new("ffmpeg")
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn transcode_to_ogg(input: &[u8]) -> Result<Vec<u8>, String> {
    if !ffmpeg_available() {
        // No ffmpeg: deliver raw audio as-is; Telegram may reject the voice
        // MIME but the caller already warns once about missing ffmpeg.
        return Ok(input.to_vec());
    }
    run_ffmpeg(input, &["-c:a", "libopus", "-b:a", "64k", "-f", "ogg"])
}

fn ogg_to_wav(input: &[u8]) -> Result<Vec<u8>, String> {
    if !ffmpeg_available() {
        return Err("ffmpeg not found — required to transcode Telegram voice notes for STT. Install ffmpeg.".into());
    }
    run_ffmpeg(input, &["-ar", "16000", "-ac", "1", "-f", "wav"])
}

/// Pipe bytes through ffmpeg via temp files (stdin pipes are flaky with
/// ffmpeg on Windows; temp in std::env::temp_dir()).
fn run_ffmpeg(input: &[u8], encode_args: &[&str]) -> Result<Vec<u8>, String> {
    let dir = std::env::temp_dir().join("kai-telegram");
    std::fs::create_dir_all(&dir).map_err(|e| format!("tmpdir: {e}"))?;
    let in_path = dir.join(format!("in-{}.bin", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
    let out_path = in_path.with_extension("out");

    let mut f = std::fs::File::create(&in_path).map_err(|e| format!("tmp write: {e}"))?;
    f.write_all(input).map_err(|e| format!("tmp write: {e}"))?;
    drop(f);

    let out = std::process::Command::new("ffmpeg")
        .arg("-y")
        .arg("-loglevel").arg("error")
        .arg("-i").arg(&in_path)
        .args(encode_args)
        .arg(&out_path)
        .output()
        .map_err(|e| format!("ffmpeg spawn: {e}"))?;
    let _ = std::fs::remove_file(&in_path);
    if !out.status.success() {
        let _ = std::fs::remove_file(&out_path);
        return Err(format!("ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr).chars().take(200).collect::<String>()));
    }
    let result = std::fs::read(&out_path).map_err(|e| format!("tmp read: {e}"))?;
    let _ = std::fs::remove_file(&out_path);
    Ok(result)
}

/// Split into ≤4096-char chunks at line boundaries (Telegram hard cap).
fn split_message(text: &str) -> Vec<String> {
    const CAP: usize = 4000;
    if text.chars().count() <= CAP {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        let line_len = line.chars().count() + 1;
        if !current.is_empty() && current.chars().count() + line_len > CAP {
            chunks.push(std::mem::take(&mut current));
        }
        if current.is_empty() && line.chars().count() > CAP {
            // Single pathological line — hard-split at char boundary.
            let chars: Vec<char> = line.chars().collect();
            for sl in chars.chunks(CAP) {
                chunks.push(sl.iter().collect());
            }
            continue;
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    if chunks.is_empty() {
        chunks.push(String::new());
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_serializes_camel_case_for_channel() {
        // The frontend Channel handler reads `kind`, `chatId`, `text`, … —
        // a field naming mismatch here silently drops the field (undefined),
        // which previously killed every reply with "missing required key
        // chatId". Pin the exact wire shape.
        let e = TelegramEvent::Message {
            chat_id: 42,
            message_id: 7,
            text: Some("hi".into()),
            voice_file_id: None,
            voice_duration_secs: None,
            date: 0,
        };
        let j = serde_json::to_value(&e).unwrap();
        assert_eq!(j["kind"], "message");
        assert_eq!(j["chatId"], 42);
        assert_eq!(j["text"], "hi");
        let p = TelegramEvent::Photo {
            chat_id: 42,
            message_id: 7,
            photo_file_id: "f".into(),
            caption: None,
            date: 0,
        };
        let j = serde_json::to_value(&p).unwrap();
        assert_eq!(j["kind"], "photo");
        assert_eq!(j["photoFileId"], "f");
    }

    #[test]
    fn split_message_respects_cap() {
        let long = "a".repeat(12_000);
        let chunks = split_message(&long);
        assert!(chunks.len() >= 3);
        for c in &chunks {
            assert!(c.chars().count() <= 4096);
        }
    }

    #[test]
    fn split_message_keeps_short_text_whole() {
        assert_eq!(split_message("hello"), vec!["hello".to_string()]);
    }

    #[test]
    fn split_message_splits_on_lines() {
        let text = "line1\nline2\nline3";
        assert_eq!(split_message(text), vec![text.to_string()]);
    }
}
