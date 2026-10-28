//! Session event journal — append-only record of the MODEL-VISIBLE context
//! assembly decisions, one JSONL file per chat session.
//!
//! Why: KAI's persisted transcript is the pre-request UI message array; the
//! request-time projection (system prompt, <env> block, per-step compaction
//! elisions, vision swaps, retry lineage) was never reconstructable after the
//! fact — exactly the state a debugging session needs ("what did the model
//! actually see when it did THAT?"). Adopting the DeepSeek-Harness invariant
//! "model-visible ⟺ logged" wholesale would mean replacing the message store
//! (high blast radius on the corruption-prone persistence path); this journal
//! is the safe first step: durable, append-only EVIDENCE that lets the request
//! be reconstructed without becoming load-bearing for it.
//!
//! Format mirrors `audit.rs` deliberately (same lessons): each line is one
//! self-contained JSON object; a partial trailing line (crash mid-write) is
//! skipped on read; the file is never rewritten in place — it rotates.
//! Unlike the audit trail this is per-SESSION data, so files live under
//! `~/.kai/sessions/<session-id>.jsonl` and die with the session.
//!
//! Secrecy: event payloads are metadata (model ids, hashes, durations,
//! counts) — but they ride next to user-supplied paths, so every string
//! VALUE is scrubbed through the same credential-shape scanner the audit
//! trail uses before serialization.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Deserialize;

use super::audit::{one_line, scrub};

/// Rotate a session journal when it exceeds 1 MB. Sessions are bounded by
/// the transcript's own 512 KB cap; this is the generous sibling.
const ROTATE_BYTES: u64 = 1024 * 1024;

static JOURNAL_LOCK: Mutex<()> = Mutex::new(());

fn journal_dir() -> Result<PathBuf, String> {
    // Test/DI override (same pattern as audit_dir; agent-spawned children
    // cannot mutate this process's environment).
    if let Ok(p) = std::env::var("KAI_JOURNAL_DIR") {
        if !p.trim().is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    let home = dirs::home_dir().ok_or_else(|| "no home directory".to_string())?;
    Ok(home.join(".kai").join("sessions"))
}

/// A session id is model/user-adjacent — keep only filename-safe chars.
/// Anything else maps to `_`; empty after sanitization is rejected.
fn safe_file_name(session_id: &str) -> Result<String, String> {
    let cleaned: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    // Reject traversal outright: a name of only dots / leading dots could
    // escape the dir even after per-char sanitization.
    if cleaned.is_empty() || cleaned.chars().all(|c| c == '.') || cleaned.starts_with('.') {
        return Err(format!("unsafe session id: {session_id:?}"));
    }
    Ok(cleaned)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Scrub every string VALUE in an event object (keys are ours; values may
/// carry paths or model names). Newlines inside string values are flattened
/// the same way the audit trail does, so one event stays one line.
fn scrub_event(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::String(s) => {
            let cleaned = scrub(&one_line(s));
            *s = cleaned;
        }
        serde_json::Value::Array(items) => {
            for it in items {
                scrub_event(it);
            }
        }
        serde_json::Value::Object(map) => {
            for (_k, val) in map.iter_mut() {
                scrub_event(val);
            }
        }
        _ => {}
    }
}

#[derive(Deserialize)]
struct JournalEventIn {
    kind: String,
    #[serde(flatten)]
    rest: serde_json::Map<String, serde_json::Value>,
}

/// Append a batch of events for one session. `events_json` is a JSON array of
/// objects, each with a `kind` string plus arbitrary detail fields. A `ts` is
/// stamped server-side (the clock the transcript lacks). Fire-and-forget: a
/// failed journal write logs a warning and never propagates — observability
/// must not break the agent run it observes.
#[tauri::command]
pub fn session_events_append(session_id: String, events_json: String) {
    if let Err(e) = session_events_append_inner(&session_id, &events_json) {
        log::warn!("session journal append failed for {session_id}: {e}");
    }
}

fn session_events_append_inner(session_id: &str, events_json: &str) -> Result<(), String> {
    let file_name = safe_file_name(session_id)?;
    let parsed: Vec<JournalEventIn> =
        serde_json::from_str(events_json).map_err(|e| format!("decode: {e}"))?;
    if parsed.is_empty() {
        return Ok(());
    }
    let dir = journal_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    let _guard = crate::modules::lock::mutex_lock(&JOURNAL_LOCK);

    let path = dir.join(&file_name).with_extension("jsonl");
    rotate_if_needed(&path);

    let ts = now_ms();
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    for ev in parsed {
        let mut obj = serde_json::Map::new();
        obj.insert("ts".into(), serde_json::Value::from(ts));
        obj.insert("kind".into(), serde_json::Value::String(scrub(&one_line(&ev.kind))));
        for (k, mut val) in ev.rest {
            scrub_event(&mut val);
            obj.insert(scrub(&one_line(&k)), val);
        }
        let line = serde_json::Value::Object(obj);
        let line = serde_json::to_string(&line).map_err(|e| format!("encode: {e}"))?;
        writeln!(f, "{line}").map_err(|e| format!("append: {e}"))?;
    }
    Ok(())
}

/// Rotate `<file>` → `<file>.1` when over the cap (best-effort).
fn rotate_if_needed(path: &std::path::Path) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() < ROTATE_BYTES {
        return;
    }
    let rotated = {
        let mut p = path.as_os_str().to_os_string();
        p.push(".1");
        PathBuf::from(p)
    };
    let _ = std::fs::remove_file(&rotated);
    let _ = std::fs::rename(path, &rotated);
}

/// Read recent events, newest first. Used by diagnostics/UI; corrupt lines
/// are skipped, not fatal (crash mid-write leaves at most one bad tail).
#[tauri::command]
pub fn session_events_recent(
    session_id: String,
    limit: Option<u32>,
) -> Result<Vec<serde_json::Value>, String> {
    let limit = limit.unwrap_or(200).clamp(1, 2000) as usize;
    let file_name = safe_file_name(&session_id)?;
    let dir = journal_dir()?;
    let path = dir.join(&file_name).with_extension("jsonl");
    let rotated = {
        let mut p = path.as_os_str().to_os_string();
        p.push(".1");
        PathBuf::from(p)
    };
    let mut events: Vec<serde_json::Value> = Vec::new();
    for candidate in [&rotated, &path] {
        let Ok(f) = File::open(candidate) else {
            continue;
        };
        for line in BufReader::new(f).lines() {
            let Ok(line) = line else { continue };
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(ev) = serde_json::from_str::<serde_json::Value>(&line) {
                events.push(ev);
            }
        }
    }
    events.reverse();
    events.truncate(limit);
    Ok(events)
}

/// Delete a session's journal (session deleted). Errors ignored — the file
/// may never have been created.
#[tauri::command]
pub fn session_events_clear(session_id: String) {
    let Ok(file_name) = safe_file_name(&session_id) else {
        return;
    };
    let Ok(dir) = journal_dir() else {
        return;
    };
    let path = dir.join(&file_name).with_extension("jsonl");
    let _ = std::fs::remove_file(&path);
    let mut r = path.as_os_str().to_os_string();
    r.push(".1");
    let _ = std::fs::remove_file(PathBuf::from(r));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The env-override tests share process state; serialize them (cargo runs
    /// tests in threads of one process) — same reason as audit's AUDIT_ENV_LOCK.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kai-journal-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn safe_file_name_rejects_traversal() {
        assert!(safe_file_name("s-abc123").is_ok());
        assert!(safe_file_name("../../etc/passwd").is_err());
        assert!(safe_file_name("..").is_err());
        assert!(safe_file_name("").is_err());
        assert_eq!(safe_file_name("a/b\\c").unwrap(), "a_b_c");
    }

    #[test]
    fn appended_events_roundtrip_newest_first() {
        let _lock = crate::modules::lock::mutex_lock(&ENV_LOCK);
        let dir = temp_dir("rt");
        std::env::set_var("KAI_JOURNAL_DIR", &dir);
        session_events_append(
            "s-1".into(),
            serde_json::to_string(&vec![
                serde_json::json!({"kind": "turn", "modelId": "claude-x"}),
                serde_json::json!({"kind": "compact", "droppedCount": 3}),
            ])
            .unwrap(),
        );
        let evs = session_events_recent("s-1".into(), Some(10)).unwrap();
        assert_eq!(evs.len(), 2);
        // newest first
        assert_eq!(evs[0]["kind"], "compact");
        assert_eq!(evs[1]["kind"], "turn");
        assert_eq!(evs[1]["modelId"], "claude-x");
        assert!(evs[0]["ts"].is_number());
        std::env::remove_var("KAI_JOURNAL_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn secrets_in_values_are_scrubbed() {
        let _lock = crate::modules::lock::mutex_lock(&ENV_LOCK);
        let dir = temp_dir("scrub");
        std::env::set_var("KAI_JOURNAL_DIR", &dir);
        session_events_append(
            "s-2".into(),
            serde_json::to_string(&vec![serde_json::json!({
                "kind": "env",
                "cwd": "password=<REDACTED:secret> /home/me"
            })])
            .unwrap(),
        );
        let evs = session_events_recent("s-2".into(), Some(10)).unwrap();
        let cwd = evs[0]["cwd"].as_str().unwrap();
        assert!(!cwd.contains("hunter2"), "got: {cwd}");
        std::env::remove_var("KAI_JOURNAL_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_tail_is_skipped_on_read() {
        let _lock = crate::modules::lock::mutex_lock(&ENV_LOCK);
        let dir = temp_dir("corrupt");
        std::env::set_var("KAI_JOURNAL_DIR", &dir);
        session_events_append(
            "s-3".into(),
            "[{\"kind\":\"turn\"}]".into(),
        );
        let path = dir.join("s-3").with_extension("jsonl");
        {
            let mut f = OpenOptions::new().append(true).open(&path).unwrap();
            let _ = writeln!(f, "{{\"kind\":\"tu");
        }
        let evs = session_events_recent("s-3".into(), Some(10)).unwrap();
        assert_eq!(evs.len(), 1);
        std::env::remove_var("KAI_JOURNAL_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
