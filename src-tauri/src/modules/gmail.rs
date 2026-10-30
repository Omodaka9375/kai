//! Gmail read-only IMAP bridge for the agent's `gmail_read` tool.
//!
//! Auth model — deliberately NOT OAuth and deliberately NOT an MCP server:
//! the user pastes a Gmail **app password** (needs 2FA; created at
//! myaccount.google.com/apppasswords) into Settings. It is stored in the OS
//! keychain under service "kai" / account "gmail-app-password" — the same
//! `secrets` module the AI provider keys use — and never touches disk
//! (except Linux's documented 0600 file fallback).
//!
//! The credential itself grants the full mailbox; the TOOL surface does not.
//! This module implements exactly four IMAP operations — connect/login,
//! UID SEARCH (Gmail's X-GM-RAW extension: native Gmail query syntax),
//! UID FETCH (headers + body), and LOGOUT. There is no code path that can
//! write, flag, move, or delete anything, so a prompt-injected model cannot
//! mail anything or mutate the mailbox through KAI. Mail BODIES are
//! untrusted text; the frontend fences the result like any remote surface
//! (fence + remoteSurface: true in toolPresentations).
//!
//! The keychain stores one secret of the form "<email> <password>" (the
//! secrets module has no per-entry metadata and IMAP LOGIN needs both).
//!
//! All network work runs on `spawn_blocking` — the `imap` crate is sync
//! and must never stall the async IPC worker.

use mail_parser::{Addr, MessageParser};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::modules::lock::mutex_lock;
use crate::modules::secrets::{secrets_get, SecretsState};

/// Gmail IMAP endpoint. No config surface — this module is Gmail-only by
/// name and by design (X-GM-RAW search is a Gmail server extension).
const IMAP_HOST: &str = "imap.gmail.com";
const IMAP_PORT: u16 = 993;

/// Account under keychain service "kai" holding "<email> <app-password>".
const ACCOUNT: &str = "gmail-app-password";

/// Cap the raw FETCH byte budget per message. The app password reads the
/// whole mailbox, but the MODEL's context is the scarce resource; 100 KB of
/// body text is ~25k tokens — beyond any useful single email.
const MAX_BODY_BYTES: usize = 100 * 1024;

/// One IMAP session at a time (one account, one TCP connection).
static IMAP_LOCK: Mutex<()> = Mutex::new(());

/// The boxed connection type the crate's public `Client`/`Session` use.
type ImapSession = imap::Session<imap::Connection>;

#[derive(Serialize)]
pub struct GmailMessage {
    pub uid: u32,
    #[serde(rename = "messageId")]
    pub message_id: String,
    pub subject: String,
    pub from: String,
    pub to: String,
    pub date: String,
    /// Extracted human-readable text (text/plain part, else stripped HTML).
    pub body: String,
    pub truncated: bool,
    /// True when the parser found no textual part at all (e.g. a bare
    /// attachment-only message).
    pub body_empty: bool,
}

#[derive(Serialize)]
pub struct GmailSearchResponse {
    pub query: String,
    pub count: usize,
    pub messages: Vec<GmailMessage>,
    pub truncated: bool,
}

/// Split the stored secret "<email> <password>". App passwords contain
/// spaces ("abcd wxyz 1234 5678") — only the FIRST whitespace run after
/// the email's '@' is the separator.
fn split_secret(secret: &str) -> Result<(String, String), String> {
    let s = secret.trim();
    let at = s.find('@').ok_or("stored Gmail secret has no email in it")?;
    let Some(off) = s[at..].find(char::is_whitespace) else {
        return Err("stored Gmail secret must be \"<email> <app-password>\"".to_string());
    };
    let (email, password) = s.split_at(at + off);
    let email = email.trim();
    let password = password.trim();
    if email.is_empty() || password.is_empty() {
        return Err("stored Gmail secret has an empty email or password".to_string());
    }
    Ok((email.to_string(), password.to_string()))
}

/// Read + validate the stored credential through the same `secrets` command
/// the rest of the app uses. Distinct error for "unset" so the model can
/// point the user at Settings.
async fn read_creds(app: &AppHandle) -> Result<(String, String), String> {
    let state = app.state::<SecretsState>();
    let secret = secrets_get(
        app.clone(),
        state,
        "kai".to_string(),
        ACCOUNT.to_string(),
    )
    .await
    .ok()
    .flatten()
    .ok_or("Gmail is not configured — set an app password in Settings → External")?;
    split_secret(&secret)
}

/// Blocking IMAP session factory — called ONLY inside `run_blocking`.
fn open_session(email: &str, password: &str) -> Result<ImapSession, String> {
    let client = imap::ClientBuilder::new(IMAP_HOST, IMAP_PORT)
        .mode(imap::ConnectionMode::Tls)
        .tls_kind(imap::TlsKind::Rust)
        .connect()
        .map_err(|e| format!("connect to {IMAP_HOST}:{IMAP_PORT} failed: {e}"))?;
    // Client::login consumes self and returns the Session directly.
    client
        .login(email, password)
        .map_err(|(e, _)| format!("Gmail login failed: {e}. Check the app password in Settings."))
}

fn extract_body(parsed: &mail_parser::Message<'_>) -> (String, bool) {
    if let Some(text) = parsed.body_text(0) {
        return (text.trim().to_string(), false);
    }
    if let Some(html) = parsed.body_html(0) {
        return (strip_html(&html).trim().to_string(), false);
    }
    (String::new(), true)
}

/// Minimal HTML → text for the HTML-fallback path (the model wants prose).
fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut in_tag = false;
    let mut in_entity = false;
    let mut entity = String::new();
    for ch in html.chars() {
        match ch {
            '<' => {
                in_tag = true;
                out.push(' ');
            }
            '>' => in_tag = false,
            _ if in_tag => {}
            '&' => {
                in_entity = true;
                entity.clear();
                entity.push('&');
            }
            ';' if in_entity => {
                in_entity = false;
                entity.push(';');
                match entity.as_str() {
                    "&nbsp;" => out.push(' '),
                    "&amp;" => out.push('&'),
                    "&lt;" => out.push('<'),
                    "&gt;" => out.push('>'),
                    "&quot;" => out.push('"'),
                    "&#39;" | "&apos;" => out.push('\''),
                    _ => out.push_str(&entity),
                }
            }
            _ if in_entity => entity.push(ch),
            _ => out.push(ch),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Flatten a parsed Address header (List | Group) into display strings.
fn addr_to_string(a: Option<&mail_parser::Address<'_>>) -> String {
    let Some(addr) = a else { return String::new() };
    let items: Vec<&Addr<'_>> = match addr {
        mail_parser::Address::List(list) => list.iter().collect(),
        mail_parser::Address::Group(groups) => groups
            .iter()
            .flat_map(|g| g.addresses.iter())
            .collect(),
    };
    items
        .iter()
        .filter_map(|a| match (a.name(), a.address()) {
            (Some(name), Some(address)) => Some(format!("{name} <{address}>")),
            (None, Some(address)) => Some(address.to_string()),
            (Some(name), None) => Some(name.to_string()),
            (None, None) => None,
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Run synchronous IMAP work on a blocking thread (the imap crate is sync).
async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("IMAP worker failed: {e}"))?
}

#[tauri::command]
pub async fn gmail_search(
    app: AppHandle,
    query: String,
    max_results: Option<usize>,
) -> Result<GmailSearchResponse, String> {
    let (email, password) = read_creds(&app).await?;
    let max = max_results.unwrap_or(10).clamp(1, 25);
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("query is empty".to_string());
    }

    run_blocking(move || {
        let _guard = mutex_lock(&IMAP_LOCK);
        let mut session = open_session(&email, &password)?;
        let response = search_and_fetch(&mut session, &query, max)?;
        let _ = session.logout();
        Ok(response)
    })
    .await
}

#[tauri::command]
pub async fn gmail_read_message(app: AppHandle, uid: u32) -> Result<GmailMessage, String> {
    let (email, password) = read_creds(&app).await?;

    run_blocking(move || {
        let _guard = mutex_lock(&IMAP_LOCK);
        let mut session = open_session(&email, &password)?;
        session
            .select("[Gmail]/All Mail")
            .map_err(|e| format!("select failed: {e}"))?;
        let message = fetch_one(&mut session, uid)?;
        let _ = session.logout();
        Ok(message)
    })
    .await
}

/// X-GM-RAW search + FETCH the newest `max` hits as full messages.
fn search_and_fetch(
    session: &mut ImapSession,
    query: &str,
    max: usize,
) -> Result<GmailSearchResponse, String> {
    session
        .select("[Gmail]/All Mail")
        .map_err(|e| format!("select failed: {e}"))?;
    // X-GM-RAW takes the native Gmail query syntax (from:, has:attachment,
    // after:, label:, …) as a literal string.
    let uids = session
        .uid_search(format!("X-GM-RAW \"{}\"", escape_query(query)))
        .map_err(|e| format!("search failed: {e}"))?;
    let mut uids: Vec<u32> = uids.into_iter().collect();
    uids.sort_unstable();
    uids.reverse(); // newest first
    let truncated = uids.len() > max;
    let mut messages = Vec::with_capacity(uids.len().min(max));
    for uid in uids.iter().take(max) {
        match fetch_one(session, *uid) {
            Ok(m) => messages.push(m),
            // One unreadable message must not fail the whole search.
            Err(e) => log::warn!("gmail fetch uid={uid} failed: {e}"),
        }
    }
    Ok(GmailSearchResponse {
        query: query.to_string(),
        count: messages.len(),
        messages,
        truncated,
    })
}

fn escape_query(q: &str) -> String {
    // Only the IMAP quoted-string delimiters need escaping.
    q.replace('\\', "\\\\").replace('"', "\\\"")
}

fn fetch_one(session: &mut ImapSession, uid: u32) -> Result<GmailMessage, String> {
    let fetches = session
        .uid_fetch(uid.to_string(), "(UID BODY.PEEK[] RFC822.SIZE)")
        .map_err(|e| format!("fetch failed: {e}"))?;
    let fetch = fetches.get(0).ok_or("server returned no message for uid")?;

    let body_bytes = fetch.body().ok_or("message had no body section")?;
    let size = body_bytes.len();
    let truncated = size > MAX_BODY_BYTES;
    let bytes = &body_bytes[..size.min(MAX_BODY_BYTES)];

    let Some(parsed) = MessageParser::default().parse(bytes) else {
        return Err("parse failed".to_string());
    };
    let (body, body_empty) = extract_body(&parsed);
    Ok(GmailMessage {
        uid,
        message_id: parsed.message_id().unwrap_or_default().to_string(),
        subject: parsed.subject().unwrap_or_default().to_string(),
        from: addr_to_string(parsed.from()),
        to: addr_to_string(parsed.to()),
        date: parsed.date().map(|d| d.to_rfc822()).unwrap_or_default(),
        body,
        truncated,
        body_empty,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_secret_parses_email_and_password() {
        let (e, p) = split_secret("user@gmail.com abcd wxyz 1234 5678").unwrap();
        assert_eq!(e, "user@gmail.com");
        assert_eq!(p, "abcd wxyz 1234 5678");
    }

    #[test]
    fn split_secret_rejects_garbage() {
        assert!(split_secret("noatsign password").is_err());
        assert!(split_secret("a@b.com").is_err()); // no separator
        assert!(split_secret("a@b.com   ").is_err()); // empty password
    }

    #[test]
    fn escape_query_escapes_quotes_and_backslashes() {
        assert_eq!(escape_query("from:\"x\""), "from:\\\"x\\\"");
        assert_eq!(escape_query("a\\b"), "a\\\\b");
    }

    #[test]
    fn strip_html_produces_plain_text() {
        assert_eq!(strip_html("<p>Hello&nbsp;world</p>"), "Hello world");
        assert_eq!(strip_html("a &amp; b"), "a & b");
    }
}
