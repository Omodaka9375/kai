//! Radio stream proxy — re-serves a remote Icecast/Shoutcast stream as a
//! clean local HTTP/1.1 chunked response on 127.0.0.1.
//!
//! WHY this exists: WebView2's media resource loader refuses live Icecast
//! streams (`MEDIA_ERR_SRC_NOT_SUPPORTED` / NotSupportedError, code 4) even
//! though the same webview plays ordinary https mp3s and the direct stream
//! URL is verifiably live (curl/ffmpeg both pull it fine). The icecast
//! response shape (HTTP/1.0-style, `Connection: Close`, no Content-Length,
//! 200-for-Range) is the trigger. Re-encoding it locally as a well-formed
//! chunked HTTP/1.1 body sidesteps the loader entirely.
//!
//! Security posture: the destination is FIXED to *.somafm.com (our curated
//! registry — not user/agent input), the listener binds 127.0.0.1 only,
//! and exactly one proxy is alive at a time.

use std::sync::Mutex;

use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

struct ProxyHandle {
    #[allow(dead_code)] // kept for debugging; abort() is the operative field
    port: u16,
    task: tauri::async_runtime::JoinHandle<()>,
}

static PROXY: Mutex<Option<ProxyHandle>> = Mutex::new(None);

/// Only SomaFM hosts are proxyable — the registry is curated in-app; this is
/// a fixed destination, not a general-purpose proxy (that's `net::`).
fn destination_allowed(url: &str) -> bool {
    match reqwest::Url::parse(url) {
        Ok(u) => {
            u.scheme() == "https"
                && u.host_str()
                    .map(|h| h == "somafm.com" || h.ends_with(".somafm.com"))
                    .unwrap_or(false)
        }
        Err(_) => false,
    }
}

/// Start (or replace) the stream proxy. Returns the local port.
pub async fn start(url: String) -> Result<u16, String> {
    if !destination_allowed(&url) {
        return Err("radio proxy: destination must be *.somafm.com (https)".into());
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("radio proxy bind: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("radio proxy local_addr: {e}"))?
        .port();

    // Swap handles under the lock; never held across an await above.
    let mut guard = crate::modules::lock::mutex_lock(&PROXY);
    if let Some(old) = guard.take() {
        old.task.abort();
    }
    let task = tauri::async_runtime::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            let url = url.clone();
            tauri::async_runtime::spawn(async move {
                serve(sock, url).await;
            });
        }
    });
    *guard = Some(ProxyHandle { port, task });
    Ok(port)
}

/// Stop the current proxy (if any). Idempotent.
pub fn stop() {
    let mut guard = crate::modules::lock::mutex_lock(&PROXY);
    if let Some(old) = guard.take() {
        old.task.abort();
    }
}

async fn serve(mut sock: TcpStream, url: String) {
    // Drain the request head (the media element sends a minimal GET; we do
    // not care about its content — single read is enough for well-formed
    // clients, loop until the head end to be safe).
    let mut head = vec![0u8; 1024];
    let mut head_len = 0usize;
    while head_len < 16 * 1024 {
        match sock.read(&mut head).await {
            Ok(0) | Err(_) => break,
            Ok(n) => head_len += n,
        }
        if head[..head_len].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }

    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(_) => return,
    };
    // No Icy-MetaData request → upstream sends plain mp3 frames (no
    // in-stream metadata blocks for the element to choke on).
    let resp = match client
        .get(&url)
        .header("User-Agent", "KAI-Radio/1.0")
        .header("Accept", "*/*")
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return,
    };
    let status = resp.status();
    if !status.is_success() {
        return;
    }
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("audio/mpeg")
        .to_string();

    // Well-formed HTTP/1.1 chunked framing — the shape WebView2's loader
    // is happy with, unlike icecast's HTTP/1.0 + no-length + connection-close.
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {ct}\r\nCache-Control: no-store\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
    );
    if sock.write_all(head.as_bytes()).await.is_err() {
        return;
    }

    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(_) => break,
        };
        if chunk.is_empty() {
            continue;
        }
        let mut framed = format!("{:x}\r\n", chunk.len()).into_bytes();
        framed.extend_from_slice(&chunk);
        framed.extend_from_slice(b"\r\n");
        // Write failure = the element hung up (station switch / stop) —
        // drop the connection; reqwest's stream aborts on drop.
        if sock.write_all(&framed).await.is_err() {
            return;
        }
    }
    let _ = sock.write_all(b"0\r\n\r\n").await;
    let _ = sock.shutdown().await;
}

#[tauri::command]
pub async fn radio_proxy_start(url: String) -> Result<u16, String> {
    start(url).await
}

#[tauri::command]
pub fn radio_proxy_stop() {
    stop();
}
