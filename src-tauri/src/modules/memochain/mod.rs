//! MemoChain embedded memory handler (per-model toggle, 2026-11-26).
//!
//! Replaces the external `proxy-custom` HTTP slot: KAI now folds overflowing
//! conversation prefixes into the verifiable 22,606-byte Capsule entirely
//! in-process. The 3,605,932-byte distilled student `weights.bin` is BUNDLED
//! as a Tauri resource (verified by SHA-256), so the feature works offline on
//! first toggle with no download step.
//!
//! On-disk layout under `app_local_data_dir()/memochain/<session_id>/` is
//! byte-compatible with standalone MemoChain (capsule.bin v1, meta.json,
//! receipts.jsonl), so any capsule KAI writes can be verified or SP1-proved
//! by the standalone Python tooling. `chunks.bin` is KAI's pure-Rust verbatim
//! recall store (no SQLite dependency; verification never reads it).
//!
//! Command split (mirrors the TS handler in src/modules/ai/lib/memochain.ts):
//!   memochain_status       weights presence + digest + store stats
//!   memochain_session_info folded hashes + rolling summary + step (per turn)
//!   memochain_fold         fold evicted entries into the capsule + receipts
//!   memochain_set_summary  persist the LLM-updated rolling fact sheet
//!   memochain_recall       hybrid top-K verbatim chunk recall
//!   memochain_verify       receipt-chain + capsule integrity audit
//!   memochain_delete       drop one session's memory
//!   memochain_clear_all    wipe the whole store (Settings)

pub mod chunks;
pub mod core;

use core::{
    Capsule, ChainHead, ReceiptRow, StudentWriter, EXPECTED_WEIGHTS_SHA256, STATE_PARAMS,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Manager;

/// Per-session mutex table so concurrent IPC calls (memochain_fold vs
/// memochain_set_summary / memochain_delete) on the same session serialize
/// their read-modify-write on meta.json + capsule.bin instead of clobbering
/// step/state_digest and tripping tamper detection.
fn session_lock(session_id: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let key = sanitize_session_id(session_id);
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Per-message clipping before embedding (matches Python `max_doc_chars`).
const MAX_DOC_CHARS: usize = 2000;

/// FIFO cap for the verbatim chunk store.
const MAX_CHUNKS: usize = chunks::MAX_CHUNKS_DEFAULT;

struct Weights {
    bytes: Vec<u8>,
    digest: String,
}

static WEIGHTS: OnceLock<Weights> = OnceLock::new();

/// Locate the bundled weights: resource dir first (packaged builds), then
/// repo-relative (dev runs), then exe-relative (portable layouts). Same
/// fallback chain as the CHANGELOG.md resource probe in fs/file.rs.
fn weights_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = app
        .path()
        .resolve("memochain/weights.bin", tauri::path::BaseDirectory::Resource)
    {
        out.push(p);
    }
    out.push(PathBuf::from("resources/memochain/weights.bin"));
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join("resources/memochain/weights.bin"));
        }
    }
    out
}

fn load_weights(app: &tauri::AppHandle) -> Result<&'static Weights, String> {
    if let Some(w) = WEIGHTS.get() {
        return Ok(w);
    }
    let mut last_err = String::from("weights.bin not found");
    for cand in weights_candidates(app) {
        match fs::read(&cand) {
            Ok(bytes) => {
                let digest = {
                    let writer = StudentWriter::from_bytes(&bytes)?;
                    writer.weights_digest()
                };
                if digest != EXPECTED_WEIGHTS_SHA256 {
                    last_err = format!(
                        "weights digest mismatch at {}: {}",
                        cand.display(),
                        digest
                    );
                    continue;
                }
                let w = Weights { bytes, digest };
                return Ok(WEIGHTS.get_or_init(|| w));
            }
            Err(e) => last_err = format!("{}: {}", cand.display(), e),
        }
    }
    Err(last_err)
}

/// Store root: `app_local_data_dir()/memochain/`.
fn store_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|p| p.join("memochain"))
        .map_err(|e| format!("app local data dir unavailable: {e}"))
}

/// Match the Python proxy's session-id sanitization so a session folder is
/// identical whether it was created by KAI or the standalone proxy.
fn sanitize_session_id(session_id: &str) -> String {
    session_id
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .take(80)
        .collect()
}

fn session_dir(app: &tauri::AppHandle, session_id: &str) -> Result<PathBuf, String> {
    Ok(store_root(app)?.join(sanitize_session_id(session_id)))
}

#[derive(Debug, Serialize, Deserialize)]
struct Meta {
    session_id: String,
    step: u64,
    state_digest: String,
    accumulator: String,
    folded_hashes: Vec<String>,
    summary: String,
    weights_digest: String,
    updated_at: String,
}

fn now_iso() -> String {
    // Local-time ISO-8601 with offset, matching Python time.strftime("%Y-%m-%dT%H:%M:%S%z").
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant's algorithm), UTC.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}+0000")
}

fn read_meta(dir: &Path) -> Option<Meta> {
    let raw = fs::read_to_string(dir.join("meta.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_meta(dir: &Path, meta: &Meta) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("mkdir failed: {e}"))?;
    let tmp = dir.join("meta.tmp");
    let body = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())? + "\n";
    fs::write(&tmp, body).map_err(|e| format!("write meta failed: {e}"))?;
    fs::rename(&tmp, dir.join("meta.json")).map_err(|e| format!("rename meta failed: {e}"))
}

/// Load (state, head) from capsule.bin + meta.json. Returns None when the
/// session has no capsule yet (fresh session).
fn load_session_state(dir: &Path) -> Result<Option<(Vec<i16>, ChainHead)>, String> {
    let Some(meta) = read_meta(dir) else {
        return Ok(None);
    };
    let raw = fs::read(dir.join("capsule.bin"))
        .map_err(|e| format!("read capsule failed: {e}"))?;
    let cap = Capsule::from_bytes(&raw)?;
    if cap.state.len() != STATE_PARAMS {
        return Err("capsule state length mismatch".into());
    }
    if core::state_digest(&cap.state) != meta.state_digest || cap.head != meta.accumulator {
        return Err("capsule does not match meta (tamper detected)".into());
    }
    Ok(Some((
        cap.state,
        ChainHead {
            step: cap.step,
            accumulator: cap.head,
            state_digest: meta.state_digest,
        },
    )))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoChainStatus {
    pub available: bool,
    pub error: Option<String>,
    pub weights_digest: Option<String>,
    pub store_root: Option<String>,
    pub session_count: usize,
}

#[tauri::command]
pub fn memochain_status(app: tauri::AppHandle) -> MemoChainStatus {
    let mut status = MemoChainStatus {
        available: false,
        error: None,
        weights_digest: None,
        store_root: None,
        session_count: 0,
    };
    let root = match store_root(&app) {
        Ok(r) => r,
        Err(e) => {
            status.error = Some(e);
            return status;
        }
    };
    status.store_root = Some(root.to_string_lossy().into_owned());
    if let Ok(entries) = fs::read_dir(&root) {
        status.session_count = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.path().join("capsule.bin").exists())
            .count();
    }
    match load_weights(&app) {
        Ok(w) => {
            status.available = true;
            status.weights_digest = Some(w.digest.clone());
        }
        Err(e) => status.error = Some(e),
    }
    status
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoChainSessionInfo {
    pub exists: bool,
    pub step: u64,
    pub state_digest: String,
    pub accumulator: String,
    pub summary: String,
    pub folded_hashes: Vec<String>,
    pub weights_digest: Option<String>,
    pub tampered: bool,
}

#[tauri::command]
pub fn memochain_session_info(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<MemoChainSessionInfo, String> {
    let dir = session_dir(&app, &session_id)?;
    // WEIGHTS LAZY (2026-11-26 specialist review): this command runs on the
    // UI poll path (the context dropdown hits it every 5s) - it must not
    // load the 3.6MB weights file per call. Only report the digest when
    // the weights are ALREADY loaded; a null digest is honest (engine not
    // spun up yet - memochain_status remains the authoritative probe).
    let weights_digest = WEIGHTS.get().map(|w| w.digest.clone());
    let Some(meta) = read_meta(&dir) else {
        return Ok(MemoChainSessionInfo {
            exists: false,
            step: 0,
            state_digest: String::new(),
            accumulator: String::new(),
            summary: String::new(),
            folded_hashes: Vec::new(),
            weights_digest,
            tampered: false,
        });
    };
    // Tamper probe: capsule must still match meta.
    let tampered = match load_session_state(&dir) {
        Ok(Some(_)) => false,
        Ok(None) => true, // meta exists but capsule missing
        Err(_) => true,
    };
    Ok(MemoChainSessionInfo {
        exists: true,
        step: meta.step,
        state_digest: meta.state_digest,
        accumulator: meta.accumulator,
        summary: meta.summary,
        folded_hashes: meta.folded_hashes,
        weights_digest,
        tampered,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FoldEntry {
    pub msg_hash: String,
    pub role: String,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoChainFoldResult {
    pub step: u64,
    pub state_digest: String,
    pub weights_digest: String,
    pub receipt_rows: usize,
    pub chunk_count: usize,
    pub docs_folded: usize,
}

#[tauri::command]
pub fn memochain_fold(
    app: tauri::AppHandle,
    session_id: String,
    entries: Vec<FoldEntry>,
) -> Result<MemoChainFoldResult, String> {
    let lock = session_lock(&session_id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let w = load_weights(&app)?;
    let writer = StudentWriter::from_bytes(&w.bytes)?;
    let dir = session_dir(&app, &session_id)?;

    let (mut state, mut head) = match load_session_state(&dir)? {
        Some((s, h)) => (s, h),
        None => (core::zero_state(), ChainHead {
            step: 0,
            accumulator: "0".repeat(64),
            state_digest: core::state_digest(&core::zero_state()),
        }),
    };

    // Docs: non-empty clipped texts (matches Python `_fold_messages`).
    // DEDUPE (2026-11-26 specialist review): a message hash already in
    // meta.folded_hashes has ALREADY been folded into the capsule - its
    // receipt is in the chain. Folding it again appends a duplicate receipt
    // and double-counts the doc in the student state. The TS side trims the
    // folded prefix from the request now, but any interleaving (mid-run fold
    // racing the next pre-run fold, a failed run replaying) must not be able
    // to re-fold; the store itself refuses.
    let mut docs: Vec<(String, String, String)> = Vec::new(); // (hash, role, clipped text)
    let existing_meta = read_meta(&dir);
    let already_folded: std::collections::HashSet<&String> = existing_meta
        .as_ref()
        .map(|m| m.folded_hashes.iter().collect())
        .unwrap_or_default();
    let mut skipped_dupes: usize = 0;
    let mut entries_folded: Vec<String> = Vec::new();
    for e in &entries {
        if already_folded.contains(&e.msg_hash) {
            skipped_dupes += 1;
            continue;
        }
        let t = e.text.trim();
        if !t.is_empty() {
            let clipped: String = t.chars().take(MAX_DOC_CHARS).collect();
            docs.push((e.msg_hash.clone(), e.role.clone(), clipped));
        }
        // Recorded even when the text was empty (matches the original
        // meta.folded_hashes semantics: every entry's hash lands in meta).
        entries_folded.push(e.msg_hash.clone());
    }
    if docs.is_empty() && skipped_dupes == 0 {
        // Fresh fold with no text at all: keep the sentinel so the capsule
        // still advances a step (matches Python `_fold_messages`).
        docs.push((
            "(empty tool exchange)".to_string(),
            "user".to_string(),
            "(empty tool exchange)".to_string(),
        ));
        entries_folded.push("(empty tool exchange)".to_string());
    }
    let texts: Vec<String> = docs.iter().map(|(_, _, t)| t.clone()).collect();

    // ALL-DUPES FAST PATH (2026-11-26 specialist review): every entry was
    // already folded - the capsule, receipts and meta are unchanged. Return
    // the current state WITHOUT touching disk (a no-op fold used to append
    // nothing to receipts but still rewrote capsule+meta with an identical
    // step - harmless but wasteful on every turn's re-fold race).
    if texts.is_empty() {
        let chunk_count = chunks::load_chunks(&dir.join("chunks.bin"))
            .map(|c| c.len())
            .unwrap_or(0);
        return Ok(MemoChainFoldResult {
            step: head.step,
            state_digest: head.state_digest.clone(),
            weights_digest: w.digest.clone(),
            receipt_rows: 0,
            chunk_count,
            docs_folded: 0,
        });
    }

    let receipts_path = dir.join("receipts.jsonl");
    let mut appended: usize = 0;
    let mut receipt_rows: Vec<String> = Vec::new();
    for text in &texts {
        let embed = core::hash_embed(text);
        let q14 = core::embed_to_q14(&embed);
        let (new_state, receipt, new_head) = writer.fold_doc_with_receipt(&state, &q14, Some(&head));
        state = new_state;
        head = new_head;
        let row: ReceiptRow = receipt;
        receipt_rows.push(serde_json::to_string(&ReceiptJson {
            step: row.step,
            doc_hash: row.doc_hash,
            state_digest: row.state_digest,
            binding: row.binding,
            accumulator: row.accumulator,
        }).map_err(|e| e.to_string())?);
        appended += 1;
    }

    // Persist capsule + receipts + meta atomically-ish (receipts append first,
    // capsule next, meta last — meta is the commit marker on load).
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {e}"))?;
    if !receipt_rows.is_empty() {
        let mut body = String::new();
        for r in &receipt_rows {
            body.push_str(r);
            body.push('\n');
        }
        append_to_file(&receipts_path, &body)?;
    }

    let cap = Capsule {
        state: state.clone(),
        step: head.step,
        head: head.accumulator.clone(),
    };
    let cap_bytes = cap.to_bytes()?;
    let tmp = dir.join("capsule.tmp");
    fs::write(&tmp, &cap_bytes).map_err(|e| format!("write capsule failed: {e}"))?;
    fs::rename(&tmp, dir.join("capsule.bin"))
        .map_err(|e| format!("rename capsule failed: {e}"))?;

    // Verbatim chunk store (embeds from the same hash_embed as the docs).
    if !docs.is_empty() {
        let chunk_entries: Vec<(String, String, String, Vec<f32>)> = docs
            .iter()
            .map(|(h, role, t)| (h.clone(), role.clone(), t.clone(), core::hash_embed(t)))
            .collect();
        chunks::append_chunks(&dir.join("chunks.bin"), head.step, &chunk_entries, MAX_CHUNKS)?;
    }
    let chunk_count = chunks::load_chunks(&dir.join("chunks.bin"))?.len();

    // meta: folded_hashes gains the NEW hashes only (deduped above).
    let mut meta = existing_meta.unwrap_or(Meta {
        session_id: sanitize_session_id(&session_id),
        step: 0,
        state_digest: String::new(),
        accumulator: String::new(),
        folded_hashes: Vec::new(),
        summary: String::new(),
        weights_digest: w.digest.clone(),
        updated_at: String::new(),
    });
    for h in &entries_folded {
        meta.folded_hashes.push(h.clone());
    }
    meta.step = head.step;
    meta.state_digest = head.state_digest.clone();
    meta.accumulator = head.accumulator.clone();
    meta.weights_digest = w.digest.clone();
    meta.updated_at = now_iso();
    write_meta(&dir, &meta)?;

    Ok(MemoChainFoldResult {
        step: head.step,
        state_digest: head.state_digest,
        weights_digest: w.digest.clone(),
        receipt_rows: appended,
        chunk_count,
        docs_folded: texts.len(),
    })
}

#[derive(Debug, Serialize)]
struct ReceiptJson {
    step: u64,
    doc_hash: String,
    state_digest: String,
    binding: String,
    accumulator: String,
}

#[tauri::command]
pub fn memochain_set_summary(
    app: tauri::AppHandle,
    session_id: String,
    summary: String,
) -> Result<bool, String> {
    let lock = session_lock(&session_id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let dir = session_dir(&app, &session_id)?;
    let mut meta = read_meta(&dir).ok_or("session has no meta (fold first)")?;
    meta.summary = summary;
    meta.updated_at = now_iso();
    write_meta(&dir, &meta)?;
    Ok(true)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoChainRecallResult {
    pub summary: String,
    pub step: u64,
    pub state_digest: String,
    pub chunks: Vec<chunks::RecalledChunk>,
}

#[tauri::command]
pub fn memochain_recall(
    app: tauri::AppHandle,
    session_id: String,
    query_text: String,
    top_k: u32,
) -> Result<MemoChainRecallResult, String> {
    let dir = session_dir(&app, &session_id)?;
    let Some(meta) = read_meta(&dir) else {
        return Ok(MemoChainRecallResult {
            summary: String::new(),
            step: 0,
            state_digest: String::new(),
            chunks: Vec::new(),
        });
    };
    let query_embed = core::hash_embed(query_text.trim());
    let chunks = chunks::search_chunks(
        &dir.join("chunks.bin"),
        query_text.trim(),
        &query_embed,
        top_k as usize,
    )?;
    Ok(MemoChainRecallResult {
        summary: meta.summary,
        step: meta.step,
        state_digest: meta.state_digest,
        chunks,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoChainVerifyResult {
    pub ok: bool,
    pub error: Option<String>,
    pub step: u64,
    pub receipt_rows: usize,
    pub state_matches_meta: bool,
    pub head_matches_meta: bool,
    pub receipt_chain_ok: bool,
    pub receipt_head_matches: bool,
    pub capsule_bytes: usize,
}

fn verify_session_dir(dir: &Path) -> MemoChainVerifyResult {
    let mut res = MemoChainVerifyResult {
        ok: false,
        error: None,
        step: 0,
        receipt_rows: 0,
        state_matches_meta: false,
        head_matches_meta: false,
        receipt_chain_ok: true,
        receipt_head_matches: false,
        capsule_bytes: 0,
    };

    let cap_raw = match fs::read(dir.join("capsule.bin")) {
        Ok(r) => r,
        Err(_) => {
            res.error = Some("missing capsule".into());
            return res;
        }
    };
    res.capsule_bytes = cap_raw.len();
    let Some(meta) = read_meta(dir) else {
        res.error = Some("missing meta".into());
        return res;
    };
    let cap = match Capsule::from_bytes(&cap_raw) {
        Ok(c) => c,
        Err(e) => {
            res.error = Some(e);
            return res;
        }
    };
    res.step = cap.step;
    res.state_matches_meta = core::state_digest(&cap.state) == meta.state_digest;
    res.head_matches_meta = cap.head == meta.accumulator && cap.step == meta.step;

    // Replay the binding chain from receipts.jsonl (Python verify semantics).
    // A capsule at step > 0 MUST have matching sequential receipts; missing or
    // truncated receipts.jsonl must fail verification instead of passing.
    let mut acc = "0".repeat(64);
    let mut expected_step: u64 = 1;
    match fs::read_to_string(dir.join("receipts.jsonl")) {
        Ok(body) => {
            for line in body.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let row: serde_json::Value = match serde_json::from_str(line) {
                    Ok(v) => v,
                    Err(e) => {
                        res.receipt_chain_ok = false;
                        res.error = Some(format!("bad receipt row: {e}"));
                        break;
                    }
                };
                res.receipt_rows += 1;
                let step = row["step"].as_u64().unwrap_or(0);
                if step != expected_step {
                    res.receipt_chain_ok = false;
                    res.error = Some(format!(
                        "receipt step out of order: expected {expected_step}, got {step}"
                    ));
                    break;
                }
                expected_step += 1;
                let doc_hash = row["doc_hash"].as_str().unwrap_or("");
                let state_digest = row["state_digest"].as_str().unwrap_or("");
                let binding_expected = row["binding"].as_str().unwrap_or("");
                let accumulator_expected = row["accumulator"].as_str().unwrap_or("");
                let binding = core::sha256_hex(
                    format!("{step}|{acc}|{doc_hash}|{state_digest}").as_bytes(),
                );
                acc = core::sha256_hex(format!("{acc}{binding}").as_bytes());
                if binding != binding_expected || acc != accumulator_expected {
                    res.receipt_chain_ok = false;
                    break;
                }
            }
        }
        Err(_) if cap.step > 0 => {
            res.receipt_chain_ok = false;
            res.error = Some("missing receipts.jsonl".into());
        }
        Err(_) => {}
    }
    res.receipt_head_matches = if cap.step == 0 {
        res.receipt_rows == 0
    } else {
        res.receipt_rows as u64 == cap.step && acc == cap.head
    };
    res.ok = res.state_matches_meta
        && res.head_matches_meta
        && res.receipt_chain_ok
        && res.receipt_head_matches;
    res
}

#[tauri::command]
pub fn memochain_verify(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<MemoChainVerifyResult, String> {
    let dir = session_dir(&app, &session_id)?;
    Ok(verify_session_dir(&dir))
}

#[tauri::command]
pub fn memochain_delete(app: tauri::AppHandle, session_id: String) -> Result<bool, String> {
    let lock = session_lock(&session_id);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let dir = session_dir(&app, &session_id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("remove session failed: {e}"))?;
    }
    Ok(true)
}

#[tauri::command]
pub fn memochain_clear_all(app: tauri::AppHandle) -> Result<usize, String> {
    let root = store_root(&app)?;
    let mut removed = 0usize;
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            if entry.path().join("capsule.bin").exists()
                && fs::remove_dir_all(entry.path()).is_ok()
            {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

fn append_to_file(path: &Path, body: &str) -> Result<(), String> {
    use std::io::Write;
    let mut fh = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open receipts failed: {e}"))?;
    fh.write_all(body.as_bytes())
        .map_err(|e| format!("append receipts failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_matches_python_proxy_semantics() {
        assert_eq!(sanitize_session_id("s-abc_123"), "s-abc_123");
        assert_eq!(sanitize_session_id("a b/c:d"), "a-b-c-d");
        let long: String = "x".repeat(200);
        assert_eq!(sanitize_session_id(&long).len(), 80);
    }

    #[test]
    fn session_id_alnum_unicode_kept() {
        // is_alphanumeric is unicode-aware, matching Python's str.isalnum.
        assert_eq!(sanitize_session_id("sé"), "sé");
    }

    #[test]
    fn fold_two_docs_advances_chain_and_meta() {
        // Uses a fake AppHandle-less path: exercise via the pure core instead.
        let embed = core::hash_embed("hello world");
        let q14 = core::embed_to_q14(&embed);
        let w_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/memochain/weights.bin");
        let raw = fs::read(&w_path).unwrap();
        let writer = StudentWriter::from_bytes(&raw).unwrap();
        let (s1, r1, h1) = writer.fold_doc_with_receipt(&core::zero_state(), &q14, None);
        assert_eq!(r1.step, 1);
        let (s2, r2, h2) = writer.fold_doc_with_receipt(&s1, &q14, Some(&h1));
        assert_eq!(r2.step, 2);
        assert_ne!(h1.state_digest, h2.state_digest);
        assert_eq!(core::state_digest(&s2), h2.state_digest);

        // Receipt-row JSON shape matches the Python receipts.jsonl keys.
        let row = serde_json::to_value(ReceiptJson {
            step: r2.step,
            doc_hash: r2.doc_hash.clone(),
            state_digest: r2.state_digest.clone(),
            binding: r2.binding.clone(),
            accumulator: r2.accumulator.clone(),
        })
        .unwrap();
        for key in ["step", "doc_hash", "state_digest", "binding", "accumulator"] {
            assert!(row.get(key).is_some(), "missing key {key}");
        }
    }

    #[test]
    fn receipt_replay_logic_matches_python_verify() {
        let w_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/memochain/weights.bin");
        let raw = fs::read(&w_path).unwrap();
        let writer = StudentWriter::from_bytes(&raw).unwrap();

        // Fold 3 docs, serialize receipts, then replay exactly like
        // memochain_verify does.
        let mut state = core::zero_state();
        let mut head: Option<ChainHead> = None;
        let mut rows = Vec::new();
        for i in 0..3 {
            let embed = core::hash_embed(&format!("doc number {i} with content"));
            let q14 = core::embed_to_q14(&embed);
            let (s, r, h) = writer.fold_doc_with_receipt(&state, &q14, head.as_ref());
            state = s;
            head = Some(h);
            rows.push(serde_json::to_string(&ReceiptJson {
                step: r.step,
                doc_hash: r.doc_hash,
                state_digest: r.state_digest,
                binding: r.binding,
                accumulator: r.accumulator,
            })
            .unwrap());
        }

        let mut acc = "0".repeat(64);
        for line in &rows {
            let row: serde_json::Value = serde_json::from_str(line).unwrap();
            let step = row["step"].as_u64().unwrap();
            let doc_hash = row["doc_hash"].as_str().unwrap();
            let state_digest = row["state_digest"].as_str().unwrap();
            let binding = core::sha256_hex(
                format!("{step}|{acc}|{doc_hash}|{state_digest}").as_bytes(),
            );
            acc = core::sha256_hex(format!("{acc}{binding}").as_bytes());
            assert_eq!(binding, row["binding"].as_str().unwrap());
            assert_eq!(acc, row["accumulator"].as_str().unwrap());
        }
        assert_eq!(acc, head.as_ref().unwrap().accumulator);

        // Tampered row (mutate the doc_hash VALUE, keep valid JSON) breaks the replay.
        let mut bad_val: serde_json::Value = serde_json::from_str(&rows[1]).unwrap();
        let mut bad_hash = bad_val["doc_hash"].as_str().unwrap().to_string();
        bad_hash.replace_range(0..2, "ff");
        bad_val["doc_hash"] = serde_json::Value::String(bad_hash);
        let bad = serde_json::to_string(&bad_val).unwrap();
        let mut acc = "0".repeat(64);
        let mut ok = true;
        for line in [rows[0].clone(), bad, rows[2].clone()] {
            let row: serde_json::Value = serde_json::from_str(&line).unwrap();
            let step = row["step"].as_u64().unwrap();
            let doc_hash = row["doc_hash"].as_str().unwrap();
            let state_digest = row["state_digest"].as_str().unwrap();
            let binding = core::sha256_hex(
                format!("{step}|{acc}|{doc_hash}|{state_digest}").as_bytes(),
            );
            acc = core::sha256_hex(format!("{acc}{binding}").as_bytes());
            if binding != row["binding"].as_str().unwrap() {
                ok = false;
                break;
            }
        }
        assert!(!ok);
    }

    #[test]
    fn verify_rejects_missing_or_empty_receipts_and_step_mismatch() {
        let w_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/memochain/weights.bin");
        let raw = fs::read(&w_path).unwrap();
        let writer = StudentWriter::from_bytes(&raw).unwrap();

        let dir = std::env::temp_dir().join(format!(
            "kai-memochain-verify-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let embed = core::hash_embed("verify receipt presence");
        let q14 = core::embed_to_q14(&embed);
        let (state, r1, h1) = writer.fold_doc_with_receipt(&core::zero_state(), &q14, None);
        let cap = Capsule {
            state,
            step: h1.step,
            head: h1.accumulator.clone(),
        };
        fs::write(dir.join("capsule.bin"), cap.to_bytes().unwrap()).unwrap();
        let meta = Meta {
            session_id: "s-verify".into(),
            step: h1.step,
            state_digest: h1.state_digest.clone(),
            accumulator: h1.accumulator.clone(),
            folded_hashes: vec!["h1".into()],
            summary: String::new(),
            weights_digest: writer.weights_digest(),
            updated_at: now_iso(),
        };
        write_meta(&dir, &meta).unwrap();

        // 1. Missing receipts.jsonl MUST fail when step > 0.
        let missing = verify_session_dir(&dir);
        assert!(!missing.ok);
        assert!(!missing.receipt_chain_ok);
        assert!(!missing.receipt_head_matches);

        // 2. Empty receipts.jsonl MUST also fail when step > 0.
        fs::write(dir.join("receipts.jsonl"), "").unwrap();
        let empty = verify_session_dir(&dir);
        assert!(!empty.ok);
        assert!(!empty.receipt_head_matches);

        // 3. Valid receipts.jsonl passes.
        let valid_row = serde_json::to_string(&ReceiptJson {
            step: r1.step,
            doc_hash: r1.doc_hash.clone(),
            state_digest: r1.state_digest.clone(),
            binding: r1.binding.clone(),
            accumulator: r1.accumulator.clone(),
        })
        .unwrap();
        fs::write(dir.join("receipts.jsonl"), format!("{valid_row}\n")).unwrap();
        let ok = verify_session_dir(&dir);
        assert!(ok.ok, "expected valid session to pass: {:?}", ok);
        assert_eq!(ok.receipt_rows, 1);

        // 4. Meta step mismatch fails even when digest/head match.
        let mut bad_meta = meta;
        bad_meta.step = 99;
        write_meta(&dir, &bad_meta).unwrap();
        let mismatch = verify_session_dir(&dir);
        assert!(!mismatch.ok);
        assert!(!mismatch.head_matches_meta);

        let _ = fs::remove_dir_all(&dir);
    }
}
