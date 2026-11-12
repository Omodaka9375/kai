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

/// ALLOW-LISTED GROUP CHATS (2026-11-02 group support). Persisted in the
/// assistant prefs as `boundGroups` and pushed into Rust by every
/// `telegram_start` (same pattern as OWNER_CHAT_ID — Rust owns the gate,
/// prefs own the persistence). A group chat id in this set receives the
/// assistant with sender attribution; every other non-owner chat stays
/// silently rejected.
static BOUND_GROUP_IDS: LazyLock<Mutex<Vec<i64>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));

/// Pending GROUP binding: set by `telegram_bind_group`, consumed by the
/// first `/bindgroup` sent INSIDE a group by the OWNER (single-use).
/// A member who is not the owner arming bind mode cannot add their group.
static GROUP_BIND_MODE: AtomicBool = AtomicBool::new(false);

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

/// Cross-PROCESS poll ownership. The GENERATION guard above only arbitrates
/// threads in one KAI process; project windows can be separate processes and
/// Telegram allows exactly one getUpdates consumer per bot (otherwise 409).
/// An OS-owned lease is released automatically even if KAI crashes.
///
/// Cross-process stop marker. Preferences are shared between project
/// instances; a 64-bit disable epoch avoids an older off marker cancelling
/// a later re-enable.
static DISABLE_EPOCH: AtomicU64 = AtomicU64::new(0);
static DISABLE_FILE_CHECK_MS: AtomicU64 = AtomicU64::new(0);

struct PollLease {
    #[cfg(target_os = "windows")]
    handle: usize,
    #[cfg(unix)]
    fd: i32,
}

#[cfg(target_os = "windows")]
impl Drop for PollLease {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::System::Threading::ReleaseMutex;
        // SAFETY: this handle was returned by CreateMutexW and is released
        // exactly once, when the owning poll thread exits.
        unsafe {
            let handle = self.handle as HANDLE;
            if ReleaseMutex(handle) == 0 {
                log::warn!("[kai:assistant] ReleaseMutex failed: {}", std::io::Error::last_os_error());
            }
            CloseHandle(handle);
        }
    }
}

#[cfg(unix)]
impl Drop for PollLease {
    fn drop(&mut self) {
        // SAFETY: fd is owned by this lease and closed exactly once.
        unsafe {
            libc::close(self.fd);
        }
    }
}

#[cfg(target_os = "windows")]
fn acquire_os_poll_lease() -> Result<Option<PollLease>, String> {
    acquire_os_poll_lease_named("KaiTelegramPoller")
}

/// Windows implementation with an injectable mutex name. The production
/// name is a `Local\` namespace constant shared with every KAI process; the
/// tests pass their own per-test name so a LIVE running KAI holding the
/// production mutex (this dev machine, right now) cannot make the
/// exclusivity test fail for environment reasons.
#[cfg(target_os = "windows")]
fn acquire_os_poll_lease_named(name: &str) -> Result<Option<PollLease>, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let full = format!("Local\\{name}\0");
    let name: Vec<u16> = full.encode_utf16().collect();
    // SAFETY: name is NUL-terminated; the returned handle is owned by the
    // lease (or closed immediately when another process already owns it).
    unsafe {
        let handle = CreateMutexW(std::ptr::null(), 1, name.as_ptr());
        if handle.is_null() {
            return Err(format!("CreateMutexW failed: {}", std::io::Error::last_os_error()));
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            CloseHandle(handle);
            return Ok(None);
        }
        Ok(Some(PollLease { handle: handle as usize }))
    }
}

#[cfg(unix)]
fn acquire_os_poll_lease() -> Result<Option<PollLease>, String> {
    // Production name: keeps the historical `~/.kai/telegram-poller.lock`
    // path so existing deployments keep their lease semantics.
    acquire_os_poll_lease_named("telegram-poller")
}

/// Unix mirror of the Windows `_named` variant: `name` selects the flock'd
/// lock file under `~/.kai`. Tests pass their own per-test name so a LIVE
/// KAI instance holding the production lock (dev machines run KAI while
/// testing KAI) cannot fail the exclusivity test for environment reasons.
/// flock is per open-file-description, so the contender in the same
/// process is still a real contention test.
#[cfg(unix)]
fn acquire_os_poll_lease_named(name: &str) -> Result<Option<PollLease>, String> {
    use std::os::fd::IntoRawFd;
    let dir = dirs::home_dir()
        .ok_or_else(|| "no home directory for Telegram poll lease".to_string())?
        .join(".kai");
    std::fs::create_dir_all(&dir).map_err(|e| format!("poll lease dir: {e}"))?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        // Lock-file contents are never read or written — only the flock
        // matters — so never truncate an existing lock. Stating that
        // explicitly (the Unix default) silences
        // clippy::suspicious_open_options on newer toolchains.
        .truncate(false)
        .open(dir.join(format!("{name}.lock")))
        .map_err(|e| format!("poll lease open: {e}"))?;
    let fd = file.into_raw_fd();
    // SAFETY: fd is live and owned by this function. On contention/error it
    // is closed here; on success PollLease takes ownership.
    if unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let error = std::io::Error::last_os_error();
        unsafe {
            libc::close(fd);
        }
        if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
            return Ok(None);
        }
        return Err(format!("poll lease flock: {error}"));
    }
    Ok(Some(PollLease { fd }))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn disable_marker_path() -> Result<std::path::PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "no home directory for Telegram disable marker".to_string())?
        .join(".kai")
        .join("assistant")
        .join("telegram-disabled.json"))
}

/// Monotonic disable generation, written atomically. The file is read only
/// twice per minute; normal long-polling is unaffected.
fn write_disable_marker(epoch: u64) -> Result<(), String> {
    let path = disable_marker_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("disable marker dir: {e}"))?;
    }
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&temp, format!("{{\"epoch\":{epoch}}}"))
        .map_err(|e| format!("disable marker write: {e}"))?;
    std::fs::rename(&temp, &path).map_err(|e| format!("disable marker commit: {e}"))?;
    Ok(())
}

fn read_disable_marker() -> Option<u64> {
    let text = std::fs::read_to_string(disable_marker_path().ok()?).ok()?;
    #[derive(Deserialize)]
    struct Marker {
        epoch: u64,
    }
    serde_json::from_str::<Marker>(&text).ok().map(|m| m.epoch)
}

fn refresh_disable_epoch(force: bool) {
    let now = now_millis();
    if !force && now.saturating_sub(DISABLE_FILE_CHECK_MS.load(Ordering::Relaxed)) < 5_000 {
        return;
    }
    DISABLE_FILE_CHECK_MS.store(now, Ordering::Relaxed);
    if let Some(epoch) = read_disable_marker() {
        DISABLE_EPOCH.fetch_max(epoch, Ordering::SeqCst);
    }
}

fn mark_assistant_disabled() {
    // Two processes toggling simultaneously still converge on a newer epoch.
    refresh_disable_epoch(true);
    let epoch = now_millis().max(DISABLE_EPOCH.load(Ordering::SeqCst).saturating_add(1));
    if let Err(e) = write_disable_marker(epoch) {
        // Fail closed locally; don't claim that other instances were stopped
        // when the shared marker could not be persisted.
        log::warn!("[kai:assistant] unable to persist cross-instance stop: {e}");
    }
    DISABLE_EPOCH.fetch_max(epoch, Ordering::SeqCst);
}

/// True when this loop's enable generation predates a cross-process stop.
fn assistant_disabled_since(generation_started: u64) -> bool {
    refresh_disable_epoch(false);
    DISABLE_EPOCH.load(Ordering::SeqCst) >= generation_started
}

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
    /// An incoming message (text or voice) from the owner or an
    /// allow-listed group (sender_name set for group attribution).
    Message {
        chat_id: i64,
        message_id: i64,
        /// None for voice messages (then `file_id` is set).
        text: Option<String>,
        /// Telegram file_id of a voice note, when the message is voice.
        voice_file_id: Option<String>,
        /// Seconds of voice duration (for the STT size gate).
        voice_duration_secs: Option<i64>,
        /// Sender display name (group messages: who is talking; the
        /// owner's own name in private chats). Attribute replies with it.
        sender_name: String,
        /// True when this came from an allow-listed GROUP chat.
        is_group: bool,
        date: i64,
    },
    /// Incoming photo (largest size) — model gets it as a vision part.
    Photo {
        chat_id: i64,
        message_id: i64,
        photo_file_id: String,
        caption: Option<String>,
        sender_name: String,
        is_group: bool,
        date: i64,
    },
    /// Incoming document (any file) — saved to the assistant scratch dir.
    Document {
        chat_id: i64,
        message_id: i64,
        document_file_id: String,
        file_name: String,
        mime_type: Option<String>,
        sender_name: String,
        is_group: bool,
        date: i64,
    },
    /// Incoming video (mp4 note or regular video).
    Video {
        chat_id: i64,
        message_id: i64,
        video_file_id: String,
        duration_secs: Option<i64>,
        sender_name: String,
        is_group: bool,
        date: i64,
    },
    /// Owner not yet bound — this /start may claim binding.
    StartCandidate { chat_id: i64, message_id: i64, date: i64 },
    /// A `/bindgroup` sent INSIDE a group by the OWNER while group-bind
    /// mode was armed: the TS side persists the group in prefs.
    GroupBindCandidate {
        chat_id: i64,
        group_title: Option<String>,
        date: i64,
    },
    /// Message from a non-owner chat (silently ignored by the agent).
    Rejected { chat_id: i64, date: i64 },
    /// Inline-keyboard button press (approval card). `data` is the button
    /// payload ("approve:<id>" / "deny:<id>"); `query_id` answers the
    /// callback (stops the client-side spinner), `chat_id` routes it.
    CallbackQuery {
        query_id: String,
        chat_id: i64,
        data: String,
    },
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
fn http_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Option<reqwest::Client>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .connect_timeout(Duration::from_secs(15))
                .pool_idle_timeout(Duration::from_secs(90))
                .build()
                .ok()
        })
        .as_ref()
        .ok_or_else(|| "HTTP client unavailable".to_string())
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
    let client = http_client()?;
    let mut last_err = String::new();
    // Transport-level failures (connect/TLS/DNS/reset/timeout) are transient
    // — retry up to 3 attempts with backoff before surfacing. HTTP-level
    // errors (4xx/5xx, Telegram `ok:false`) are NOT retried: the request
    // reached Telegram and the answer is authoritative.
    for attempt in 1..=3u32 {
        if attempt > 1 {
            tokio::time::sleep(Duration::from_millis(500 * u64::from(attempt - 1))).await;
        }
        let resp = match client.post(&url).json(body).send().await {
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
    /// The SENDER. Group messages carry it (the group's members); private
    /// chats echo the owner's user object. Used for group attribution and
    /// the /bindgroup owner check.
    #[serde(default)]
    from: Option<TgUser>,
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
    /// Group/supergroup title (absent in private chats).
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TgUser {
    #[serde(default)]
    id: Option<i64>,
    #[serde(default)]
    first_name: Option<String>,
    #[serde(default)]
    username: Option<String>,
}

/// Display name for event attribution: first name, falling back to the
/// @username, then "Someone" (never empty so the TS side can always
/// attribute).
///
/// SANITIZED (2026-11-03 review hardening): the name is interpolated into
/// the model transcript as "[Name]: text" - a display name containing
/// brackets/newlines could forge attribution ("System:", "[Owner", or a
/// line break that starts a plausible system line). Strip control chars
/// and bracket-like characters, collapse whitespace, cap at 32 chars.
fn tg_display_name(from: &Option<TgUser>) -> String {
    let raw = match from {
        Some(u) => u
            .first_name
            .clone()
            .or_else(|| u.username.clone())
            .unwrap_or_else(|| "Someone".into()),
        None => "Someone".into(),
    };
    sanitize_sender_name(&raw)
}

/// Attribution-safe sender name: no control characters, no brackets (the
/// attribution wrapper uses them), single spaces, 32-char cap. Empty after
/// stripping falls back to "Someone".
fn sanitize_sender_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_control() {
            continue; // newlines/tabs could start a new "system" line
        }
        if matches!(
            ch,
            '[' | ']' | '{' | '}' | '<' | '>' | '"' | '\'' | '`' | '(' | ')' | ':' | '@'
        ) {
            continue; // bracket-ish: the [Name]: wrapper must stay unforgeable
        }
        out.push(ch);
    }
    let collapsed: String = out
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        "Someone".into()
    } else {
        trimmed.chars().take(32).collect()
    }
}

#[derive(Debug, Deserialize)]
struct TgUpdate {
    #[serde(default)]
    update_id: i64,
    #[serde(default)]
    message: Option<TgMessage>,
    /// Inline-keyboard button press (approval cards). Owner-gated in classify().
    #[serde(default)]
    callback_query: Option<TgCallbackQuery>,
}

#[derive(Debug, Deserialize)]
struct TgCallbackQuery {
    #[serde(default)]
    id: String,
    /// The data string we attached to the button ("approve:<id>" / "deny:<id>").
    #[serde(default)]
    data: Option<String>,
    /// The message carrying the keyboard: { chat: { id }, ... }.
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
            "allowed_updates": ["message", "callback_query"],
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
    // Inline-keyboard presses (approval cards). The owner gate applies to
    // callbacks exactly as to messages - a stranger pressing a forwarded
    // button is dropped before anything decides anything.
    if let Some(cb) = update.callback_query.as_ref() {
        let owner = OWNER_CHAT_ID.load(Ordering::SeqCst);
        let chat_id = cb
            .message
            .as_ref()
            .and_then(|m| m.chat.as_ref())
            .and_then(|c| c.id);
        let chat_id = match chat_id {
            Some(id) if owner != -1 && id == owner => id,
            _ => return None,
        };
        let data = cb.data.clone().unwrap_or_default();
        if data.is_empty() {
            return None;
        }
        emit_event(TelegramEvent::CallbackQuery {
            query_id: cb.id.clone(),
            chat_id,
            data,
        });
        return Some(chat_id);
    }
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
    // GROUP GATE (2026-11-02): allow-listed group chats receive the
    // assistant with sender attribution. The list is persisted in prefs
    // (boundGroups) and pushed here by every telegram_start. `/bindgroup`
    // (sent INSIDE the group, by the owner, while bind mode is armed) is
    // the ONLY way a group id becomes a bind candidate — never auto-added.
    let group_allowed = {
        let groups = crate::modules::lock::mutex_lock(&BOUND_GROUP_IDS);
        groups.contains(&chat_id)
    };
    let sender_name = tg_display_name(&msg.from);
    let is_bindgroup = msg
        .text
        .as_deref()
        .map(|t| t.trim() == "/bindgroup")
        .unwrap_or(false);
    if is_bindgroup {
        // Handshake: armed by telegram_bind_group (settings), consumed
        // here. Only the OWNER may add a group — a member arming bind
        // mode and /bindgroup-ing from any group cannot.
        let sender_is_owner = msg.from.as_ref().and_then(|u| u.id) == Some(owner);
        if sender_is_owner && GROUP_BIND_MODE.swap(false, Ordering::SeqCst) {
            emit_event(TelegramEvent::GroupBindCandidate {
                chat_id,
                group_title: group_title_of(msg),
                date,
            });
            return Some(chat_id);
        }
        // Not armed or not the owner: drop silently.
        return None;
    }
    let is_group = group_allowed && owner != -1 && chat_id != owner;
    if !is_group {
        if owner != -1 && chat_id != owner {
            emit_event(TelegramEvent::Rejected { chat_id, date });
            return None;
        }
        if owner == -1 {
            // Unbound and not a bindable /start — drop.
            return None;
        }
    }

    if let Some(voice) = &msg.voice {
        emit_event(TelegramEvent::Message {
            chat_id,
            message_id,
            text: None,
            voice_file_id: voice.file_id.clone(),
            voice_duration_secs: voice.duration,
            sender_name,
            is_group,
            date,
        });
    } else if let Some(text) = &msg.text {
        emit_event(TelegramEvent::Message {
            chat_id,
            message_id,
            text: Some(text.clone()),
            voice_file_id: None,
            voice_duration_secs: None,
            sender_name,
            is_group,
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
                sender_name,
                is_group,
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
            sender_name,
            is_group,
            date,
        });
    } else if let Some(video) = &msg.video {
        emit_event(TelegramEvent::Video {
            chat_id,
            message_id,
            video_file_id: video.file_id.clone().unwrap_or_default(),
            duration_secs: video.duration,
            sender_name,
            is_group,
            date,
        });
    }
    Some(chat_id)
}

/// Group title for the /bindgroup confirmation ("Group <title> added").
/// The chat payload carries `title` for groups/supergroups.
fn group_title_of(msg: &TgMessage) -> Option<String> {
    msg.chat.as_ref().and_then(|c| c.title.clone())
}

/// Start the long-poll thread. Called from the settings UI (and app start
/// when the assistant is enabled). Restartable: starting while running is a
/// no-op except for refreshing the channel.
#[tauri::command]
pub async fn telegram_start(
    token: String,
    owner_chat_id: Option<i64>,
    bound_group_ids: Option<Vec<i64>>,
    on_event: Channel<TelegramEvent>,
) -> Result<TelegramStatus, String> {
    if token.trim().is_empty() {
        return Err("bot token is empty".into());
    }
    refresh_disable_epoch(true);
    // GROUP GATE (2026-11-02): refresh Rust's copy of the allow-listed groups
    // on every start (same pattern as OWNER_CHAT_ID above). The gate in
    // classify() only ever READS this; /bindgroup alone cannot mutate it —
    // mutation flows exclusively through this persisted-prefs push.
    {
        let mut groups = crate::modules::lock::mutex_lock(&BOUND_GROUP_IDS);
        *groups = bound_group_ids.unwrap_or_default();
    }
    // An enable is a strictly NEWER epoch than any observed disable. Never
    // compare raw wall-clock timestamps: same-ms toggles/clock rollback
    // could otherwise disable the replacement loop immediately.
    let started_at = now_millis().max(DISABLE_EPOCH.load(Ordering::SeqCst).saturating_add(1));
    if RUNNING.load(Ordering::SeqCst) && assistant_disabled_since(started_at) {
        // The old loop has not finished its in-flight request yet. Supersede
        // it now so start cannot return a doomed `running: true` status.
        GENERATION.fetch_add(1, Ordering::SeqCst);
        RUNNING.store(false, Ordering::SeqCst);
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
    RUNNING.store(true, Ordering::SeqCst);

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
            // Builder failures (e.g. TLS backend init) must degrade to an
            // emitted error + stopped state, not panic the poll thread.
            let client = match reqwest::Client::builder()
                .timeout(Duration::from_secs(LONG_POLL_SECS + 15))
                .build()
            {
                Ok(c) => c,
                Err(e) => {
                    if GENERATION.load(Ordering::SeqCst) == generation {
                        RUNNING.store(false, Ordering::SeqCst);
                    }
                    emit_event(TelegramEvent::Error {
                        message: format!("HTTP client: {e}"),
                    });
                    return;
                }
            };
            let mut last_error: Option<String> = None;
            let mut waiting_logged = false;
            // Held by THIS poll thread only, across successful polls. A
            // stale standby thread has no lease and therefore cannot release
            // a replacement thread's ownership during off→on.
            let mut lease: Option<PollLease> = None;
            loop {
                // Exit when stopped, superseded, or disabled in ANY KAI
                // instance. The final case is checked before EVERY request,
                // including after a long-poll/error sleep.
                if POLL_SHUTDOWN.load(Ordering::SeqCst)
                    || GENERATION.load(Ordering::SeqCst) != generation
                    || assistant_disabled_since(started_at)
                {
                    break;
                }
                if lease.is_none() {
                    match acquire_os_poll_lease() {
                        Ok(Some(acquired)) => {
                            lease = Some(acquired);
                            waiting_logged = false;
                        }
                        Ok(None) => {
                            // Another KAI project instance owns polling.
                            // Standby is healthy: no getUpdates, no 409.
                            if !waiting_logged {
                                log::info!("[kai:assistant] Telegram polling owned by another instance; standing by");
                                waiting_logged = true;
                            }
                            tokio::time::sleep(Duration::from_secs(15)).await;
                            continue;
                        }
                        Err(e) => {
                            if !waiting_logged {
                                log::warn!("[kai:assistant] Telegram poll lease unavailable: {e}");
                                waiting_logged = true;
                            }
                            tokio::time::sleep(Duration::from_secs(15)).await;
                            continue;
                        }
                    }
                }
                let offset = {
                    let last = crate::modules::lock::mutex_lock(&LAST_UPDATE_ID);
                    *last + 1
                };
                match poll_once(&client, &token, offset).await {
                    Ok(updates) => {
                        // A stop may arrive while this request is in-flight.
                        // Do not dispatch agent turns after disable, and do
                        // not acknowledge the updates: a later enabled poll
                        // will fetch them again instead of losing messages.
                        refresh_disable_epoch(true);
                        if POLL_SHUTDOWN.load(Ordering::SeqCst)
                            || GENERATION.load(Ordering::SeqCst) != generation
                            || assistant_disabled_since(started_at)
                        {
                            break;
                        }
                        last_error = None;
                        for u in &updates {
                            classify(u);
                            let mut last = crate::modules::lock::mutex_lock(&LAST_UPDATE_ID);
                            if u.update_id > *last {
                                *last = u.update_id;
                            }
                        }
                    }
                    Err(e) => {
                        if last_error.as_deref() != Some(e.as_str()) {
                            emit_event(TelegramEvent::Error { message: e.clone() });
                        }
                        let conflict = e.contains("HTTP 409");
                        last_error = Some(e);
                        tokio::time::sleep(Duration::from_secs(if conflict { 30 } else { 5 })).await;
                    }
                }
            }
            // Drop only this thread's lease, after its in-flight request has
            // ended. The OS also releases it automatically on process crash.
            drop(lease);
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
    mark_assistant_disabled();
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

/// Arm the GROUP bind handshake: the OWNER's next `/bindgroup` sent INSIDE
/// a group claims that group (classify verifies the sender is the owner and
/// emits GroupBindCandidate; the TS side persists it in prefs.boundGroups).
#[tauri::command]
pub fn telegram_bind_group() -> Result<(), String> {
    GROUP_BIND_MODE.store(true, Ordering::SeqCst);
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
    // A loop disabled in another instance may be winding down its in-flight
    // request; it is NOT a live bridge and must not be treated as one.
    let running = RUNNING.load(Ordering::SeqCst)
        && !POLL_SHUTDOWN.load(Ordering::SeqCst);
    TelegramStatus {
        running,
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

/// Show a "typing…" status in the chat. Telegram's sendChatAction lasts ~5s
/// per call; the JS bridge repeats it every 4s while a turn is running so the
/// owner sees life during long tool runs instead of silence. Best-effort:
/// failures (rate limit, network) are logged and swallowed — a missing
/// typing hint must never fail the turn itself.
#[tauri::command]
pub async fn telegram_set_chat_action(
    token: String,
    chat_id: i64,
    action: Option<String>,
) -> Result<(), String> {
    // Only a fixed allowlist is forwarded — no arbitrary method passthrough.
    // `Some(valid) => valid, _ => default` reads as manual unwrap_or to
    // clippy, but the alternative chain doesn't typecheck with mixed
    // literals — keep the match, silence the lint at the source.
    #[allow(clippy::manual_unwrap_or)]
    let action = match action.as_deref() {
        Some(a @ ("typing" | "upload_document" | "upload_video")) => a,
        _ => "typing",
    };
    // The action naturally expires after ~5s on Telegram's side; we keep
    // re-sending it on an interval from the frontend for long turns.
    let body = serde_json::json!({
        "chat_id": chat_id,
        "action": action,
    });
    match post_json::<serde_json::Value>(&token, "sendChatAction", &body).await {
        Ok(_) => Ok(()),
        Err(e) => {
            log::warn!("[kai:assistant] sendChatAction({action}) failed: {e}");
            Ok(()) // never fail the turn over a status hint
        }
    }
}
/// Send a text message (agent reply). Errors are surfaced to the caller which
/// logs them in the session — the user sees the assistant went quiet and why.
#[tauri::command]
pub async fn telegram_send_message(
    token: String,
    chat_id: i64,
    text: String,
    plain: Option<bool>,
) -> Result<(), String> {
    // 4096 is Telegram's hard message cap; split long agent replies.
    for chunk in split_message(&text) {
        // PLAIN MODE (2026-11-03 review hardening): machine-generated pings
        // (reminder fires, watch notices) carry text that can include
        // member-chosen or file-derived words; parsing those as Telegram
        // Markdown let a well-formed [link](url) render CLICKABLE from the
        // trusted bot. `plain` skips parse_mode entirely.
        if plain.unwrap_or(false) {
            let msg = serde_json::json!({ "chat_id": chat_id, "text": chunk });
            post_json::<serde_json::Value>(&token, "sendMessage", &msg).await?;
            continue;
        }
        // Telegram HTML, converted from the model's standard Markdown
        // (2026-11-06: the legacy "Markdown" parse_mode only understands
        // *single-star* emphasis, so the **bold** / ## headings / fenced
        // code that models actually emit rendered as literal asterisks and
        // hashes - user report: "looks like its markdown but either its
        // broken or telegram doesnt render it"). md_to_telegram_html is
        // conservative and escapes first, but anything Telegram's HTML
        // parser still rejects with HTTP 400 "can't parse entities" falls
        // back to plain text so the reply is never lost to formatting.
        // A chunk cut after a ``` opener (split_message trims at 4000 chars
        // without knowing about fences) leaves <pre> unclosed, Telegram 400s
        // with "can't parse entities", and the fallback below sends that
        // chunk as PLAIN TEXT - silently dropping every bullet and heading in
        // it. Close an open fence at the chunk boundary; the next chunk
        // re-opens its own because the boundary sits between lines.
        let body = md_to_telegram_html(&chunk);
        let body = if has_unclosed_fence(&body) {
            format!("{body}</pre>")
        } else {
            body
        };
        let html = serde_json::json!({
            "chat_id": chat_id,
            "text": body,
            "parse_mode": "HTML",
        });
        if let Err(e) = post_json::<serde_json::Value>(&token, "sendMessage", &html).await {
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

/// Send a text message WITH inline keyboard buttons (approval cards).
/// `buttons` is a flat list rendered as one row: [(label, callback_data)].
/// Markdown-then-plain fallback exactly like telegram_send_message.
#[tauri::command]
pub async fn telegram_send_message_with_buttons(
    token: &str,
    chat_id: i64,
    text: String,
    buttons: Vec<(String, String)>,
) -> Result<(), String> {
    let keyboard: Vec<Vec<serde_json::Value>> = vec![buttons
        .iter()
        .map(|(label, data)| {
            serde_json::json!({ "text": label, "callback_data": data })
        })
        .collect()];
    let payload = serde_json::json!({
        "chat_id": chat_id,
        "text": text,
        "reply_markup": { "inline_keyboard": keyboard },
    });
    if let Err(e) = post_json::<serde_json::Value>(token, "sendMessage", &payload).await {
        if e.contains("can't parse entities") {
            let plain = serde_json::json!({
                "chat_id": chat_id,
                "text": text,
                "reply_markup": { "inline_keyboard": keyboard },
            });
            post_json::<serde_json::Value>(token, "sendMessage", &plain).await?;
        } else {
            return Err(e);
        }
    }
    Ok(())
}

/// Answer a callback query (stops the button's client-side spinner).
#[tauri::command]
pub async fn telegram_answer_callback(
    token: &str,
    query_id: String,
    text: Option<String>,
) -> Result<(), String> {
    let mut payload = serde_json::json!({ "callback_query_id": query_id });
    if let Some(t) = text {
        payload["text"] = serde_json::Value::String(t);
    }
    post_json::<serde_json::Value>(token, "answerCallbackQuery", &payload).await?;
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
    let resp = http_client()?
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
    let resp = http_client()?
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
    let resp = http_client()?
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
    let resp = http_client()?
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
    let mut probe = std::process::Command::new("ffmpeg");
    probe
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // CREATE_NO_WINDOW — no console flash from the GUI app on every probe.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        probe.creation_flags(0x08000000);
    }
    probe.status().map(|s| s.success()).unwrap_or(false)
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

    let mut ffmpeg = std::process::Command::new("ffmpeg");
    ffmpeg
        .arg("-y")
        .arg("-loglevel").arg("error")
        .arg("-i").arg(&in_path)
        .args(encode_args)
        .arg(&out_path);
    // CREATE_NO_WINDOW — no console flash from the GUI app on transcode.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        ffmpeg.creation_flags(0x08000000);
    }
    let out = ffmpeg
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

/// --- Markdown → Telegram HTML -------------------------------------------
///
/// Agent replies arrive as standard LLM Markdown (**bold**, ## headings,
/// `code`, ``` fences, [links](url)). Telegram's legacy `parse_mode:
/// "Markdown"` only understands *single-star* emphasis and chokes on the
/// rest, so users saw raw asterisks and hashes. Telegram HTML renders all
/// of it. Conversion rules, in order:
///  1. The source text is HTML-escaped FIRST (`&`, `<`, `>`), so user or
///     model content can never inject markup — the only tags in the output
///     are the ones this function emits.
///  2. Fenced ``` blocks become <pre> (contents untouched), ``` # headings
///     become bold lines, "> quote" lines become <blockquote>.
///  3. LISTS ARE NORMALIZED, not marked up: Telegram's HTML parse mode does
///     NOT support <ul>/<ol>/<li> ("Only the tags mentioned above are
///     currently supported" — core.telegram.org/bots/api), so raw `- item`
///     passed through as literal text and the user read a paragraph of
///     dashes. Bullets become a dot, task boxes become boxes, and ordered
///     items are RENUMBERED per block (models emit "1." for every item).
///     Nesting is indented with non-breaking spaces, which Telegram keeps.
///     A standalone `---` rule becomes a separator line (no <hr> either).
///  4. Inline: `code`, **bold**, *italic* (guarded), ~~strike~~, and
///     [text](http…) links. `_italic_` is deliberately NOT converted —
///     snake_case identifiers would be mangled into italics.
///  5. Unpaired markers stay literal rather than guessing; the caller's
///     plain-text fallback still catches anything Telegram's parser
///     rejects (the "can't parse entities" path, unchanged).
fn md_to_telegram_html(text: &str) -> String {
    let escaped = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");

    let mut out = String::with_capacity(escaped.len() + 64);
    let mut in_fence = false;
    // (indent level, next number) per open ordered list. Reset by any
    // non-list content so a new list starts at 1, but PRESERVED across the
    // blank lines models put between items (a loose list is still one list).
    let mut ordered: Vec<(usize, u32)> = Vec::new();
    for line in escaped.split('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            out.push_str(if in_fence { "</pre>" } else { "<pre>" });
            out.push('\n');
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        // "---" / "***" / "___" alone on a line → a visible rule. Telegram
        // has no <hr>, so a run of box-drawing chars stands in.
        if is_thematic_break(trimmed) {
            ordered.clear();
            out.push_str("──────────\n");
            continue;
        }
        // "# Heading" → bold line (Telegram has no heading concept). '#'
        // is single-byte, so byte slicing after counting is safe.
        let mut hashes = 0;
        for ch in line.chars() {
            if ch == '#' {
                hashes += 1;
            } else {
                break;
            }
        }
        if (1..=6).contains(&hashes) {
            let rest = &line[hashes..];
            if rest.starts_with(' ') || rest.starts_with('\t') {
                ordered.clear();
                out.push_str("<b>");
                out.push_str(&md_inline(rest.trim()));
                out.push_str("</b>\n");
                continue;
            }
        }
        // "> quote" → blockquote (a bare ">" line stays literal). The line
        // is ALREADY HTML-escaped at this point, so the marker is "&gt; ".
        if trimmed.len() > 5 && trimmed.starts_with("&gt; ") {
            let q = trimmed[5..].trim();
            if !q.is_empty() {
                ordered.clear();
                out.push_str("<blockquote>");
                out.push_str(&md_inline(q));
                out.push_str("</blockquote>\n");
                continue;
            }
        }
        // List item at any depth. Detected BEFORE inline conversion so a
        // leading "* " is a bullet, never an italic opener.
        if let Some((marker, body)) = parse_list_marker(trimmed) {
            let level = list_indent_level(&line[..line.len() - trimmed.len()]);
            let bullet = match marker {
                ListMarker::Bullet => "• ".to_string(),
                ListMarker::Task(done) => if done { "☑ " } else { "☐ " }.to_string(),
                ListMarker::Ordered => {
                    while ordered.last().is_some_and(|(l, _)| *l > level) {
                        ordered.pop();
                    }
                    let n = match ordered.last_mut() {
                        Some((l, next)) if *l == level => {
                            let n = *next;
                            *next += 1;
                            n
                        }
                        _ => {
                            ordered.push((level, 2));
                            1
                        }
                    };
                    format!("{n}. ")
                }
            };
            // Two non-breaking spaces per level: Telegram preserves those,
            // while a plain-space indent can be collapsed by the client.
            for _ in 0..level {
                out.push('\u{00A0}');
                out.push('\u{00A0}');
            }
            out.push_str(&bullet);
            out.push_str(&md_inline(body));
            out.push('\n');
            continue;
        }
        // Blank line: keep it, and keep any open ordered list alive.
        if trimmed.is_empty() {
            out.push('\n');
            continue;
        }
        ordered.clear();
        out.push_str(&md_inline(line));
        out.push('\n');
    }
    // The loop appends '\n' per line; drop the one added for a final line
    // that had none in the source so the output ends exactly like the input.
    if out.ends_with('\n') && !text.ends_with('\n') {
        out.pop();
    }
    out
}

/// `---`, `***`, `___`, optionally spaced out, and nothing else on the line.
fn is_thematic_break(trimmed: &str) -> bool {
    let mut count = 0usize;
    let mut kind: Option<char> = None;
    for ch in trimmed.chars() {
        if ch == ' ' || ch == '\t' {
            continue;
        }
        match kind {
            None => {
                if !matches!(ch, '-' | '*' | '_') {
                    return false;
                }
                kind = Some(ch);
                count = 1;
            }
            Some(k) if k == ch => count += 1,
            Some(_) => return false,
        }
    }
    count >= 3
}

enum ListMarker {
    Bullet,
    Task(bool),
    Ordered,
}

/// Indent level of a list item. Tabs count as four columns; two columns is
/// one level (the most common LLM nesting step). Capped so a pathological
/// line cannot push the body off-screen.
fn list_indent_level(leading: &str) -> usize {
    let mut cols = 0usize;
    for ch in leading.chars() {
        match ch {
            ' ' => cols += 1,
            '\t' => cols += 4,
            _ => break,
        }
    }
    (cols / 2).min(6)
}

/// Parse a Markdown list marker at the start of `rest` (already trimmed and
/// HTML-escaped). Returns the marker and the item body.
fn parse_list_marker(rest: &str) -> Option<(ListMarker, &str)> {
    let first = rest.chars().next()?;
    if matches!(first, '-' | '*' | '+') {
        let after = &rest[1..];
        // A marker must be followed by whitespace; "-5 degrees" is prose.
        if !after.starts_with(' ') && !after.starts_with('\t') {
            return None;
        }
        let body = after.trim_start();
        if body.is_empty() {
            return None;
        }
        // Task list: "- [ ] " / "- [x]" (checked before the bare bullet).
        let bytes = body.as_bytes();
        if bytes.len() >= 3
            && bytes[0] == b'['
            && bytes[2] == b']'
            && (bytes.len() == 3 || bytes[3] == b' ')
        {
            let mk = bytes[1];
            let tail = body[3..].trim_start();
            if mk == b' ' {
                return Some((ListMarker::Task(false), tail));
            }
            if mk == b'x' || mk == b'X' {
                return Some((ListMarker::Task(true), tail));
            }
        }
        return Some((ListMarker::Bullet, body));
    }
    // Ordered: "1. " or "1) ". ASCII digits, so byte slicing is safe.
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 || digits > 9 {
        return None;
    }
    let after = &rest[digits..];
    for sep in [". ", ") "] {
        if let Some(body) = after.strip_prefix(sep) {
            return Some((ListMarker::Ordered, body.trim_start()));
        }
    }
    if after == "." || after == ")" {
        return Some((ListMarker::Ordered, ""));
    }
    None
}

/// Inline conversion on ALREADY-ESCAPED text (see md_to_telegram_html).
fn md_inline(s: &str) -> String {
    md_inline_chars(&s.chars().collect::<Vec<char>>())
}

fn find_char(b: &[char], from: usize, c: char) -> Option<usize> {
    (from..b.len()).find(|&i| b[i] == c)
}

fn md_inline_chars(b: &[char]) -> String {
    let mut out = String::with_capacity(b.len() + 16);
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        // `code` — must come first so markers inside code spans are left
        // alone and backticks in the wild don't half-convert.
        if c == '`' {
            if let Some(close) = find_char(b, i + 1, '`') {
                out.push_str("<code>");
                out.extend(&b[i + 1..close]);
                out.push_str("</code>");
                i = close + 1;
                continue;
            }
        }
        // **bold**
        if c == '*' && b.get(i + 1) == Some(&'*') {
            let mut j = i + 2;
            let mut close = None;
            while j + 1 < b.len() {
                if b[j] == '*' && b[j + 1] == '*' {
                    close = Some(j);
                    break;
                }
                j += 1;
            }
            if let Some(j) = close {
                out.push_str("<b>");
                out.push_str(&md_inline_chars(&b[i + 2..j]));
                out.push_str("</b>");
                i = j + 2;
                continue;
            }
        }
        // *italic* — guarded: open only at start/after whitespace (never
        // mid-word), close only before whitespace/end/sentence punctuation,
        // so "a * b" and stray asterisks stay literal.
        if c == '*'
            && (i == 0 || b[i - 1].is_whitespace())
            && i + 1 < b.len()
            && !b[i + 1].is_whitespace()
            && b[i + 1] != '*'
        {
            let mut j = i + 1;
            let mut close = None;
            while j < b.len() {
                if b[j] == '*'
                    && !b[j - 1].is_whitespace()
                    && (j + 1 >= b.len()
                        || b[j + 1].is_whitespace()
                        || ".,;:!?)\"'".contains(b[j + 1]))
                {
                    close = Some(j);
                    break;
                }
                j += 1;
            }
            if let Some(j) = close {
                out.push_str("<i>");
                out.push_str(&md_inline_chars(&b[i + 1..j]));
                out.push_str("</i>");
                i = j + 1;
                continue;
            }
        }
        // ~~strike~~
        if c == '~' && b.get(i + 1) == Some(&'~') {
            let mut j = i + 2;
            let mut close = None;
            while j + 1 < b.len() {
                if b[j] == '~' && b[j + 1] == '~' {
                    close = Some(j);
                    break;
                }
                j += 1;
            }
            if let Some(j) = close {
                out.push_str("<s>");
                out.push_str(&md_inline_chars(&b[i + 2..j]));
                out.push_str("</s>");
                i = j + 2;
                continue;
            }
        }
        // [text](url) — http(s) only; anything else stays literal so
        // bracketed prose can't become a bogus link. The URL is already
        // HTML-escaped, which is exactly what an href attribute needs.
        if c == '[' {
            if let Some(close_br) = find_char(b, i + 1, ']') {
                if b.get(close_br + 1) == Some(&'(') {
                    if let Some(close_par) = find_char(b, close_br + 2, ')') {
                        let url: String = b[close_br + 2..close_par].iter().collect();
                        if url.starts_with("http://") || url.starts_with("https://") {
                            let inner: String = b[i + 1..close_br].iter().collect();
                            out.push_str("<a href=\"");
                            out.push_str(&url);
                            out.push_str("\">");
                            out.push_str(&md_inline(&inner));
                            out.push_str("</a>");
                            i = close_par + 1;
                            continue;
                        }
                    }
                }
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// True when the converted HTML has an odd number of <pre> openers/closers,
/// i.e. a fence was cut at a chunk boundary and must be closed by hand.
fn has_unclosed_fence(html: &str) -> bool {
    html.matches("<pre>").count() > html.matches("</pre>").count()
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
            sender_name: "Tester".into(),
            is_group: false,
            date: 0,
        };
        let j = serde_json::to_value(&e).unwrap();
        assert_eq!(j["kind"], "message");
        assert_eq!(j["chatId"], 42);
        assert_eq!(j["text"], "hi");
        assert_eq!(j["senderName"], "Tester");
        assert_eq!(j["isGroup"], false);
        let p = TelegramEvent::Photo {
            chat_id: 42,
            message_id: 7,
            photo_file_id: "f".into(),
            caption: None,
            sender_name: "Tester".into(),
            is_group: false,
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
    fn poll_lease_is_exclusive_until_released() {
        // Per-TEST mutex name: the production name may already be held by a
        // LIVE KAI instance on this machine (dev runs KAI while testing
        // KAI), which made the takeover assert fail for environment
        // reasons, not code reasons. Exclusivity semantics are identical.
        let name = format!("KaiTestPoller-{}", std::process::id());
        let acquired = acquire_os_poll_lease_named(&name).unwrap();
        assert!(acquired.is_some());
        let contender = {
            let name = name.clone();
            std::thread::spawn(move || {
                // OS mutexes are recursive within a thread, so the
                // contending call comes from another thread (matching the
                // real poll-loop model).
                let lease = acquire_os_poll_lease_named(&name).unwrap();
                assert!(lease.is_none());
            })
        };
        contender.join().unwrap();
        drop(acquired);
        let takeover = acquire_os_poll_lease_named(&name).unwrap();
        assert!(takeover.is_some());
        drop(takeover);
        // Unix lock files persist after release; Windows named mutexes die
        // with the handle. Best-effort tidy so ~/.kai doesn't collect a
        // per-test litter file on every dev-machine run.
        #[cfg(unix)]
        {
            if let Some(home) = dirs::home_dir() {
                let _ = std::fs::remove_file(home.join(".kai").join(format!("{name}.lock")));
            }
        }
    }

    #[test]
    fn disable_epoch_orders_stops_before_later_enables() {
        let previous = DISABLE_EPOCH.swap(100, Ordering::SeqCst);
        let enabled_at = now_millis().max(DISABLE_EPOCH.load(Ordering::SeqCst).saturating_add(1));
        assert!(enabled_at > 100);
        assert!(!assistant_disabled_since(enabled_at));
        assert!(assistant_disabled_since(100));
        DISABLE_EPOCH.store(previous, Ordering::SeqCst);
    }

    #[test]
    fn split_message_keeps_short_text_whole() {
        assert_eq!(split_message("hello"), vec!["hello".to_string()]);
    }

    #[test]
    fn md_to_html_renders_the_standard_llm_markdown() {
        let h = md_to_telegram_html("## Title\nsome **bold** and `code` here");
        assert!(h.contains("<b>Title</b>"), "got: {h}");
        assert!(h.contains("<b>bold</b>"), "got: {h}");
        assert!(h.contains("<code>code</code>"), "got: {h}");
        assert!(!h.contains('*'));
        assert!(!h.contains('#'));
    }

    #[test]
    fn md_to_html_escapes_source_first_so_markup_cannot_be_injected() {
        let h = md_to_telegram_html("<script>alert(1)</script>");
        assert!(h.contains("&lt;script&gt;"), "got: {h}");
        assert!(!h.contains("<script>"));
    }

    #[test]
    fn md_to_html_leaves_snake_case_and_lone_markers_alone() {
        let h = md_to_telegram_html("use file_name_here and a lone * star and 2 * 3 = 6");
        assert_eq!(h, "use file_name_here and a lone * star and 2 * 3 = 6");
    }

    #[test]
    fn md_to_html_links_fences_quotes_and_strike() {
        let src = "[docs](https://example.com/a?b=1&c=2)\n```rust\nfn main() { let x = *p; }\n```\n> quoted *italics* text\n~~gone~~";
        let h = md_to_telegram_html(src);
        assert!(
            h.contains("<a href=\"https://example.com/a?b=1&amp;c=2\">docs</a>"),
            "got: {h}"
        );
        assert!(h.contains("<pre>"));
        assert!(h.contains("fn main() { let x = *p; }"));
        assert!(h.contains("</pre>"));
        // The fence body must keep its raw asterisk (no inline conversion
        // inside <pre>).
        assert!(h.contains("x = *p"));
        assert!(h.contains("<blockquote>quoted <i>italics</i> text</blockquote>"), "got: {h}");
        assert!(h.contains("<s>gone</s>"));
    }

    #[test]
    fn md_to_html_renders_bullet_lists_instead_of_literal_dashes() {
        // User report: "when telegram assistant writes a list it comes out as
        // plain text not rendered in html properly from markdown". Telegram's
        // HTML mode has NO <ul>/<ol>/<li>, so raw "- item" used to survive
        // verbatim. Bullets are normalized to a real bullet glyph.
        let h = md_to_telegram_html("- one\n- two\n- **three**");
        assert_eq!(h, "• one\n• two\n• <b>three</b>");
        assert!(!h.contains("- "), "marker left literal: {h}");
    }

    #[test]
    fn md_to_html_nests_bullets_with_nonbreaking_indent() {
        let h = md_to_telegram_html("- outer\n  - inner\n    - deeper");
        assert!(h.starts_with("• outer\n"), "got: {h}");
        // Two NBSPs per level: clients cannot collapse them the way they
        // collapse a leading run of plain spaces.
        assert!(h.contains("\n\u{00A0}\u{00A0}• inner"), "got: {h}");
        assert!(h.contains("\n\u{00A0}\u{00A0}\u{00A0}\u{00A0}• deeper"), "got: {h}");
    }

    #[test]
    fn md_to_html_renumbers_ordered_lists() {
        // Models emit "1." for every item. Renumber sequentially.
        let h = md_to_telegram_html("1. first\n1. second\n1. third");
        assert_eq!(h, "1. first\n2. second\n3. third");
        // ") " is accepted too.
        assert_eq!(md_to_telegram_html("1) a\n2) b"), "1. a\n2. b");
    }

    #[test]
    fn md_to_html_keeps_one_ordered_list_across_blank_lines() {
        // A loose list (blank line between items) is still ONE list - the
        // counter must not reset at each gap.
        let h = md_to_telegram_html("1. a\n\n2. b\n\n3. c");
        assert_eq!(h, "1. a\n\n2. b\n\n3. c");
    }

    #[test]
    fn md_to_html_restarts_ordered_lists_after_prose() {
        let h = md_to_telegram_html("1. a\n2. b\n\nSome prose.\n\n1. c");
        assert_eq!(h, "1. a\n2. b\n\nSome prose.\n\n1. c", "got: {h}");
    }

    #[test]
    fn md_to_html_renders_task_lists_as_boxes() {
        let h = md_to_telegram_html("- [x] done\n- [ ] pending");
        assert_eq!(h, "☑ done\n☐ pending");
    }

    #[test]
    fn md_to_html_leaves_prose_that_only_looks_like_a_list() {
        // A marker needs trailing whitespace, so a negative number and a
        // multiplication expression must not become bullets.
        let src = "Temperature dropped -5 degrees, and 2 * 3 = 6.";
        assert_eq!(md_to_telegram_html(src), src);
        // A single dash is not a thematic break either.
        assert_eq!(md_to_telegram_html("A line with a single - dash"), "A line with a single - dash");
        // A "*" bullet right after text is NOT a bullet (no line start).
        assert_eq!(md_to_telegram_html("a * b"), "a * b");
    }

    #[test]
    fn md_to_html_converts_standalone_rules() {
        // Telegram has no <hr>; --- used to render as literal dashes.
        let h = md_to_telegram_html("above\n\n---\n\nbelow");
        assert!(h.contains("──────────"), "got: {h}");
        assert!(!h.contains("---"));
        // Inside a fence, dashes are content and must survive.
        let fenced = md_to_telegram_html("```\n---\n```");
        assert!(fenced.contains("---"), "got: {fenced}");
    }

    #[test]
    fn unclosed_fence_is_detected_at_a_chunk_boundary() {
        // A code fence split across chunks leaves <pre> unbalanced; sending
        // that would 400 and cost the whole chunk its formatting.
        let open = md_to_telegram_html("text\n```rust\nfn main() {}");
        assert!(has_unclosed_fence(&open), "got: {open}");
        let balanced = md_to_telegram_html("text\n```rust\nfn main() {}\n```\nmore");
        assert!(!has_unclosed_fence(&balanced), "got: {balanced}");
        // Closing it by hand yields a parseable chunk.
        let repaired = format!("{open}</pre>");
        assert!(!has_unclosed_fence(&repaired));
    }

    #[test]
    fn md_to_html_list_items_still_get_inline_formatting() {
        let h = md_to_telegram_html("- use `code` and **bold** and [x](https://e.com)");
        assert!(h.starts_with("• "), "got: {h}");
        assert!(h.contains("<code>code</code>"));
        assert!(h.contains("<b>bold</b>"));
        assert!(h.contains("<a href=\"https://e.com\">x</a>"));
    }

    #[test]
    fn md_to_html_unpaired_markers_stay_literal() {
        let h = md_to_telegram_html("a single ` backtick and an **unpaired bold");
        assert!(h.contains('`'));
        assert!(h.contains("**"));
    }

    #[test]
    fn split_message_splits_on_lines() {
        let text = "line1\nline2\nline3";
        assert_eq!(split_message(text), vec![text.to_string()]);
    }
}
