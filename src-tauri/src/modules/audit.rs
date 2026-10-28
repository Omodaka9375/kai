//! Agent audit trail — append-only record of security-relevant agent actions.
//!
//! Threat model: after a suspicious agent run, the user must be able to
//! answer "what did it actually touch, and what did I approve?" without
//! trusting the agent's own transcript (which the agent's tools — or a
//! prompt injection — can influence). The log lives OUTSIDE the project
//! (`~/.kai/audit/`) so workspace-confined code cannot rewrite it.
//!
//! Integrity: append-only JSONL. Each line is one self-contained JSON
//! object; a partial trailing line (crash mid-write) is skipped on read.
//! The file is never modified in place — rotation renames it.
//!
//! Secrecy: arguments may contain secrets the agent handled (a `.env` value
//! referenced in a shell command, a path under ~/.ssh). Every free-text
//! field is scrubbed through a credential-shape scanner before it hits
//! disk, and the file rotates at a fixed size cap.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// One audit event. `kind` discriminates; `summary` is a short human line.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    /// Milliseconds since epoch (JS `Date.now()` parity).
    pub ts: i64,
    /// Event kind: `tool.exec` | `approval.approve` | `approval.deny` |
    /// `sandbox.change` | `security.deny` | `assistant.exec`.
    pub kind: String,
    /// Tool or surface name (e.g. `bash_run`, `telegram`).
    pub subject: String,
    /// Short human summary (scrubbed + newline-flattened before write).
    pub summary: String,
    /// Project root the action ran against ("" when none).
    pub root: String,
}

const AUDIT_FILENAME: &str = "audit.jsonl";
const AUDIT_ROTATED: &str = "audit.1.jsonl";
/// Rotate when the live file exceeds 5 MB. Older data survives one
/// rotation in `audit.1.jsonl` — bounded disk, no silent recency loss.
const ROTATE_BYTES: u64 = 5 * 1024 * 1024;

static AUDIT_LOCK: Mutex<()> = Mutex::new(());

fn audit_dir() -> Result<PathBuf, String> {
    // Test/DI override. Agent-spawned child processes cannot mutate this
    // process's environment (env changes don't propagate to the parent), so
    // this is not attacker-reachable from the agent surface.
    if let Ok(p) = std::env::var("KAI_AUDIT_DIR") {
        if !p.trim().is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    let home = dirs::home_dir().ok_or_else(|| "no home directory".to_string())?;
    Ok(home.join(".kai").join("audit"))
}

/// Milliseconds since the Unix epoch (0 on clock failure — never panics).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Neutralize newlines/control chars so a hostile value can't split one
/// event into two forged lines (a newline inside `summary` would let
/// injected text impersonate an audit record) or corrupt the JSONL.
pub(crate) fn one_line(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\n' | '\r' | '\u{0}' => ' ',
            _ => c,
        })
        .collect()
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.'
}

fn is_hex(c: char) -> bool {
    c.is_ascii_hexdigit()
}

/// Scrub credential-shaped substrings from a free-text field before it hits
/// disk. Hand-rolled scanner (no regex dep) mirroring the frontend's secret
/// patterns: token prefixes (sk-, ghp_, AKIA…), long hex, and
/// `key=value` assignments for common secret key names.
pub(crate) fn scrub(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let key_names = [
        "password", "passwd", "token", "secret", "apikey", "api_key", "bearer",
    ];
    let mut i = 0;
    while i < chars.len() {
        let rest: String = chars[i..].iter().collect();

        // Token prefixes → consume the following word.
        const TOKEN_PREFIXES: &[&str] = &["sk-ant-", "sk-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "AKIA"];
        let mut matched = false;
        for p in TOKEN_PREFIXES {
            if rest.starts_with(p) {
                let plen = p.chars().count();
                // Find the end of the credential word.
                let mut j = i + plen;
                let min_tail = if *p == "AKIA" { 16 } else { 8 };
                let mut n = 0;
                while j < chars.len() && (is_word(chars[j]) || chars[j] == '=') {
                    j += 1;
                    n += 1;
                }
                if n >= min_tail {
                    out.push_str("[REDACTED:key]");
                    i = j;
                    matched = true;
                }
                break;
            }
        }
        if matched {
            continue;
        }

        // Long hex runs (32+ chars) → digest-shaped secrets.
        if is_hex(chars[i]) {
            let mut j = i;
            while j < chars.len() && is_hex(chars[j]) {
                j += 1;
            }
            if j - i >= 32 {
                out.push_str("[REDACTED:hex]");
                i = j;
                continue;
            }
        }

        // `name=value` / `name: value` for common secret key names.
        let lower = rest.to_ascii_lowercase();
        let mut consumed = false;
        for name in key_names {
            // Word boundary: start of string, after a separator, or after `_`
            // (env-var prefixes like DB_PASSWORD — in an audit log,
            // over-redaction is the safe direction).
            let starts_word = i == 0 || chars[i - 1] == '_' || !is_word(chars[i - 1]);
            if starts_word && lower.starts_with(name) {
                let after = &lower[name.len()..];
                let trimmed = after.trim_start();
                let skipped = after.len() - trimmed.len();
                if trimmed.starts_with('=') || trimmed.starts_with(": ") {
                    let mut j = i + name.len() + skipped + 1; // past the = (or 1 of ": ")
                    if trimmed.starts_with(": ") {
                        j += 1;
                    }
                    // Consume the value up to whitespace or end.
                    let start_val = j;
                    while j < chars.len() && !chars[j].is_whitespace() {
                        j += 1;
                    }
                    if j > start_val {
                        out.push_str(&chars[i..start_val].iter().collect::<String>());
                        out.push_str("[REDACTED:assign]");
                        i = j;
                        consumed = true;
                    }
                    break;
                }
            }
        }
        if consumed {
            continue;
        }

        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Append one event. Fire-and-forget by design: failures are logged, never
/// surfaced to the caller — auditing must not break the audited flow.
#[tauri::command]
pub fn audit_append(kind: String, subject: String, summary: String, root: String) {
    let ev = AuditEvent {
        ts: now_ms(),
        kind: one_line(&kind),
        subject: one_line(&subject),
        summary: scrub(&one_line(&summary)),
        root: one_line(&root),
    };
    let _guard = crate::modules::lock::mutex_lock(&AUDIT_LOCK);
    if let Err(e) = append_inner(&ev) {
        log::warn!("audit append failed: {e}");
    }
}

fn append_inner(ev: &AuditEvent) -> Result<(), String> {
    let dir = audit_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    rotate_if_needed(&dir);
    let path = dir.join(AUDIT_FILENAME);
    let line = serde_json::to_string(ev).map_err(|e| format!("encode: {e}"))?;
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    writeln!(f, "{line}").map_err(|e| format!("append: {e}"))
}

/// Rotate `audit.jsonl` → `audit.1.jsonl` when the live file exceeds the
/// cap. Best-effort: rotation failure falls through (append reopens).
fn rotate_if_needed(dir: &std::path::Path) {
    let path = dir.join(AUDIT_FILENAME);
    let Ok(meta) = std::fs::metadata(&path) else {
        return;
    };
    if meta.len() < ROTATE_BYTES {
        return;
    }
    let rotated = dir.join(AUDIT_ROTATED);
    let _ = std::fs::remove_file(&rotated);
    let _ = std::fs::rename(&path, &rotated);
}

/// Read recent events, newest first. `limit` bounds memory; a corrupt or
/// partial trailing line (crash mid-write) is skipped, not fatal.
#[tauri::command]
pub fn audit_recent(limit: Option<u32>) -> Result<Vec<AuditEvent>, String> {
    let limit = limit.unwrap_or(50).clamp(1, 500) as usize;
    let dir = audit_dir()?;
    let mut events: Vec<AuditEvent> = Vec::new();
    // Chronological read across live + rotated files, then reverse.
    for name in [AUDIT_FILENAME, AUDIT_ROTATED] {
        let path = dir.join(name);
        let Ok(f) = File::open(&path) else {
            continue;
        };
        for line in BufReader::new(f).lines() {
            let Ok(line) = line else { continue };
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(ev) = serde_json::from_str::<AuditEvent>(&line) {
                events.push(ev);
            }
        }
    }
    events.reverse();
    events.truncate(limit);
    Ok(events)
}

/// Wipe the audit trail (user-invoked, Settings → Security).
#[tauri::command]
pub fn audit_clear() -> Result<(), String> {
    let dir = audit_dir()?;
    for name in [AUDIT_FILENAME, AUDIT_ROTATED] {
        let path = dir.join(name);
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("remove {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

/// Absolute path of the audit dir (for the "open folder" button).
#[tauri::command]
pub fn audit_dir_path() -> Result<String, String> {
    audit_dir().map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_line_replaces_newlines_and_nul() {
        assert_eq!(one_line("a\nb\rc\0d"), "a b c d");
        assert_eq!(one_line("clean"), "clean");
        // Empty and multi-byte-safe.
        assert_eq!(one_line("héllo→ok"), "héllo→ok");
    }

    #[test]
    fn scrub_neutralizes_token_prefixes() {
        let out = scrub("curl -H 'Authorization: Bearer sk-abc1234567890xyz' https://x");
        assert!(out.contains("[REDACTED:key]"), "got: {out}");
        assert!(!out.contains("sk-abc1234567890xyz"));

        // `GITHUB_TOKEN=ghp_…` matches the assignment rule at `TOKEN=`; either
        // rule neutralizes the secret — assert the value is gone, not which
        // rule fired.
        let gh = scrub("GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx");
        assert!(!gh.contains("ghp_abcdefghijklmnopqrstuvwx"), "got: {gh}");
        assert!(gh.contains("[REDACTED"), "got: {gh}");

        let aws = scrub("aws AKIAIOSFODNN7EXAMPLE more");
        assert!(aws.contains("[REDACTED:key]"), "got: {aws}");
        assert!(!aws.contains("AKIAIOSFODNN7EXAMPLE"));

        let ant = scrub("sk-ant-api03-XXXXXXXXXXXXXXXX");
        assert!(ant.contains("[REDACTED:key]"), "got: {ant}");
    }

    #[test]
    fn scrub_keeps_short_noncredentials() {
        // `sk-` with a short tail is too short to be a real key — untouched.
        let out = scrub("echo sk-ab");
        assert_eq!(out, "echo sk-ab");
        // AKIA followed by <16 chars — untouched.
        let out2 = scrub("AKIAshort");
        assert_eq!(out2, "AKIAshort");
    }

    #[test]
    fn scrub_neutralizes_assignments() {
        let out = scrub("export DB_PASSWORD=hunter2secret --verbose");
        assert!(out.contains("[REDACTED:assign]"), "got: {out}");
        assert!(!out.contains("hunter2secret"));

        let out2 = scrub("config token: abc123xyz");
        assert!(out2.contains("[REDACTED:assign]"), "got: {out2}");
    }

    #[test]
    fn scrub_neutralizes_long_hex() {
        let out = scrub("digest=0123456789abcdef0123456789abcdef01234567");
        assert!(out.contains("[REDACTED:hex]"), "got: {out}");
        // Short hex (git shas) survive.
        let keep = scrub("commit abc1234");
        assert_eq!(keep, "commit abc1234");
    }

    #[test]
    fn scrub_is_idempotent() {
        let once = scrub("password=supersecretvalue123");
        let twice = scrub(&once);
        assert_eq!(once, twice);
    }

    #[test]
    fn encode_is_single_line_and_roundtrips() {
        let ev = AuditEvent {
            ts: 123,
            kind: "tool.exec".into(),
            subject: "bash_run".into(),
            summary: "cargo test".into(),
            root: "D:/proj".into(),
        };
        let line = serde_json::to_string(&ev).unwrap();
        assert!(!line.contains('\n'));
        let back: AuditEvent = serde_json::from_str(&line).unwrap();
        assert_eq!(back.kind, "tool.exec");
        assert_eq!(back.ts, 123);
    }

    #[test]
    fn rotate_moves_live_to_backup_above_cap() {
        let dir = std::env::temp_dir().join(format!("kai-audit-rot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(AUDIT_FILENAME);
        std::fs::write(&path, "x".repeat(1024)).unwrap();
        rotate_if_needed(&dir); // under cap → untouched
        assert!(path.exists());
        assert!(!dir.join(AUDIT_ROTATED).exists());
        std::fs::write(&path, vec![b'x'; 6 * 1024 * 1024]).unwrap();
        rotate_if_needed(&dir); // over cap → moved
        assert!(!path.exists());
        assert!(dir.join(AUDIT_ROTATED).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Serializes the env-override tests (they set KAI_AUDIT_DIR; cargo test
    /// runs tests in parallel threads within one process).
    static AUDIT_ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn appended_events_roundtrip_newest_first() {
        let _env = crate::modules::lock::mutex_lock(&AUDIT_ENV_LOCK);
        let dir = std::env::temp_dir().join(format!("kai-audit-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("KAI_AUDIT_DIR", &dir);
        audit_append(
            "tool.exec".into(),
            "bash_run".into(),
            "ping 1.2.3.4".into(),
            "D:/proj".into(),
        );
        audit_append(
            "approval.approve".into(),
            "bash_run".into(),
            "user approved".into(),
            "D:/proj".into(),
        );
        let evs = audit_recent(Some(10)).unwrap();
        assert!(evs.len() >= 2, "expected >=2 events, got {}", evs.len());
        // Newest first.
        assert_eq!(evs[0].kind, "approval.approve");
        assert_eq!(evs[1].kind, "tool.exec");
        assert_eq!(evs[1].summary, "ping 1.2.3.4");
        std::env::remove_var("KAI_AUDIT_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_trailing_line_is_skipped() {
        let _env = crate::modules::lock::mutex_lock(&AUDIT_ENV_LOCK);
        let dir = std::env::temp_dir().join(format!("kai-audit-corrupt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("KAI_AUDIT_DIR", &dir);
        audit_append(
            "tool.exec".into(),
            "bash_run".into(),
            "good event".into(),
            "D:/proj".into(),
        );
        // Simulate a crash mid-write: a truncated JSON line.
        {
            let path = dir.join(AUDIT_FILENAME);
            let mut f = OpenOptions::new().append(true).open(&path).unwrap();
            let _ = writeln!(f, "{{\"ts\":1,\"kind\":\"tool.ex");
        }
        let evs = audit_recent(Some(10)).unwrap();
        assert_eq!(evs.len(), 1, "corrupt line must be skipped");
        assert_eq!(evs[0].summary, "good event");
        std::env::remove_var("KAI_AUDIT_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn audit_dir_override_env_var_wins() {
        let _env = crate::modules::lock::mutex_lock(&AUDIT_ENV_LOCK);
        let dir = std::env::temp_dir().join(format!("kai-audit-ov-{}", std::process::id()));
        std::env::set_var("KAI_AUDIT_DIR", &dir);
        let got = audit_dir().unwrap();
        assert_eq!(got, dir);
        std::env::remove_var("KAI_AUDIT_DIR");
    }
}
