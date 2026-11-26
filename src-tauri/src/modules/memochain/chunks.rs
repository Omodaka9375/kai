//! Pure-Rust per-session verbatim chunk store (int8 unit vectors + hybrid search).
//!
//! Avoids pulling `rusqlite` / C SQLite into `src-tauri` while matching Python
//! MemoChain's hybrid recall scoring (0.65 cosine + 0.35 lexical overlap) and
//! 2,000-row FIFO cap. Verification and SP1 proving never read chunks; they
//! operate purely on `capsule.bin`, `meta.json`, and `receipts.jsonl`.

use super::core::{quantize_i8, EMBED_DIM};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

pub const MAX_CHUNKS_DEFAULT: usize = 2000;
const CHUNKS_MAGIC: [u8; 4] = *b"MCC1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredChunk {
    pub step: u64,
    pub msg_hash: String,
    pub role: String,
    pub text: String,
    pub scale: f32,
    pub vec: Vec<i8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecalledChunk {
    pub score: f64,
    pub step: u64,
    pub role: String,
    pub text: String,
}

/// Binary layout:
///   magic(4 = "MCC1") | count(u32 LE) |
///   repeated `count` times:
///     step(u64 LE) | hash_len(u32) | hash_utf8 | role_len(u32) | role_utf8 |
///     text_len(u32) | text_utf8 | scale(f32 LE) | dim(u32 LE) | vec_i8[dim]
pub fn load_chunks(path: &Path) -> Result<Vec<StoredChunk>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read(path).map_err(|e| format!("read chunks failed: {e}"))?;
    if raw.len() < 8 {
        return Err("chunks file truncated".into());
    }
    if raw[0..4] != CHUNKS_MAGIC {
        return Err("invalid chunks file magic".into());
    }
    let count = u32::from_le_bytes(raw[4..8].try_into().unwrap()) as usize;
    let mut pos = 8usize;
    let mut out = Vec::with_capacity(count.min(MAX_CHUNKS_DEFAULT));

    for _ in 0..count {
        if pos + 8 > raw.len() {
            return Err("chunks file truncated at step".into());
        }
        let step = u64::from_le_bytes(raw[pos..pos + 8].try_into().unwrap());
        pos += 8;

        let msg_hash = read_str(&raw, &mut pos)?;
        let role = read_str(&raw, &mut pos)?;
        let text = read_str(&raw, &mut pos)?;

        if pos + 8 > raw.len() {
            return Err("chunks file truncated at vec header".into());
        }
        let scale = f32::from_le_bytes(raw[pos..pos + 4].try_into().unwrap());
        pos += 4;
        let dim = u32::from_le_bytes(raw[pos..pos + 4].try_into().unwrap()) as usize;
        pos += 4;

        if pos + dim > raw.len() {
            return Err("chunks file truncated at vec bytes".into());
        }
        let vec: Vec<i8> = raw[pos..pos + dim].iter().map(|&b| b as i8).collect();
        pos += dim;

        out.push(StoredChunk {
            step,
            msg_hash,
            role,
            text,
            scale,
            vec,
        });
    }
    Ok(out)
}

pub fn save_chunks(path: &Path, chunks: &[StoredChunk]) -> Result<(), String> {
    let mut buf = Vec::with_capacity(8 + chunks.len() * (EMBED_DIM + 128));
    buf.extend_from_slice(&CHUNKS_MAGIC);
    buf.extend_from_slice(&(chunks.len() as u32).to_le_bytes());

    for c in chunks {
        buf.extend_from_slice(&c.step.to_le_bytes());
        write_str(&mut buf, &c.msg_hash);
        write_str(&mut buf, &c.role);
        write_str(&mut buf, &c.text);
        buf.extend_from_slice(&c.scale.to_le_bytes());
        buf.extend_from_slice(&(c.vec.len() as u32).to_le_bytes());
        buf.extend(c.vec.iter().map(|&v| v as u8));
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    let tmp = path.with_extension("bin.tmp");
    fs::write(&tmp, &buf).map_err(|e| format!("write chunks tmp failed: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename chunks tmp failed: {e}"))?;
    Ok(())
}

/// Append new entries (deduping by `msg_hash`) and apply the FIFO cap.
pub fn append_chunks(
    path: &Path,
    step: u64,
    entries: &[(String, String, String, Vec<f32>)],
    max_chunks: usize,
) -> Result<usize, String> {
    let mut chunks = load_chunks(path).unwrap_or_default();
    let mut seen: HashSet<String> = chunks.iter().map(|c| c.msg_hash.clone()).collect();

    for (msg_hash, role, text, embed) in entries {
        if !seen.insert(msg_hash.clone()) {
            continue;
        }
        let (vec, scale) = quantize_i8(embed);
        chunks.push(StoredChunk {
            step,
            msg_hash: msg_hash.clone(),
            role: role.clone(),
            text: text.clone(),
            scale,
            vec,
        });
    }

    if max_chunks > 0 && chunks.len() > max_chunks {
        let drop_n = chunks.len() - max_chunks;
        chunks.drain(0..drop_n);
    }

    save_chunks(path, &chunks)?;
    Ok(chunks.len())
}

/// Tokenize matching Python `re.findall(r"[a-z0-9_./:-]{2,}", text.lower())`.
fn lexical_tokens(text: &str) -> HashSet<String> {
    let mut set = HashSet::new();
    let mut cur = String::new();
    for ch in text.chars() {
        let lc = ch.to_ascii_lowercase();
        let ok = lc.is_ascii_alphanumeric() || matches!(lc, '_' | '.' | '/' | ':' | '-');
        if ok {
            cur.push(lc);
        } else {
            if cur.len() >= 2 {
                set.insert(std::mem::take(&mut cur));
            } else {
                cur.clear();
            }
        }
    }
    if cur.len() >= 2 {
        set.insert(cur);
    }
    set
}

pub fn search_chunks(
    path: &Path,
    query_text: &str,
    query_embed: &[f32],
    top_k: usize,
) -> Result<Vec<RecalledChunk>, String> {
    if top_k == 0 || !path.exists() {
        return Ok(Vec::new());
    }
    let chunks = load_chunks(path)?;
    if chunks.is_empty() {
        return Ok(Vec::new());
    }

    // Normalize query vector
    let q_norm = query_embed.iter().map(|&v| v * v).sum::<f32>().sqrt();
    let q: Vec<f32> = if q_norm > 0.0 {
        query_embed.iter().map(|&v| v / q_norm).collect()
    } else {
        query_embed.to_vec()
    };
    let q_toks = lexical_tokens(query_text);

    let mut scored: Vec<(f64, u64, String, String)> = Vec::with_capacity(chunks.len());
    for c in chunks {
        let cos = if c.vec.len() == q.len() && c.scale > 0.0 {
            let mut dot = 0.0f32;
            for (&qv, &cv) in q.iter().zip(c.vec.iter()) {
                dot += qv * (cv as f32);
            }
            (dot * c.scale) as f64
        } else {
            0.0
        };
        let lex = if !q_toks.is_empty() {
            let c_toks = lexical_tokens(&c.text);
            if c_toks.is_empty() {
                0.0
            } else {
                let overlap = q_toks.intersection(&c_toks).count();
                overlap as f64 / q_toks.len() as f64
            }
        } else {
            0.0
        };
        let score = 0.65 * cos + 0.35 * lex;
        scored.push((score, c.step, c.role, c.text));
    }

    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    Ok(scored
        .into_iter()
        .take(top_k)
        .map(|(score, step, role, text)| RecalledChunk {
            score: (score * 10_000.0).round() / 10_000.0,
            step,
            role,
            text,
        })
        .collect())
}

fn write_str(buf: &mut Vec<u8>, s: &str) {
    let bytes = s.as_bytes();
    buf.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(bytes);
}

fn read_str(raw: &[u8], pos: &mut usize) -> Result<String, String> {
    if *pos + 4 > raw.len() {
        return Err("chunks file truncated at string len".into());
    }
    let len = u32::from_le_bytes(raw[*pos..*pos + 4].try_into().unwrap()) as usize;
    *pos += 4;
    if *pos + len > raw.len() {
        return Err("chunks file truncated at string bytes".into());
    }
    let s = String::from_utf8(raw[*pos..*pos + len].to_vec())
        .map_err(|e| format!("invalid utf8 in chunks: {e}"))?;
    *pos += len;
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::memochain::core::hash_embed;

    #[test]
    fn chunk_store_roundtrip_dedup_fifo_and_search() {
        let dir = std::env::temp_dir().join(format!(
            "kai-memochain-chunks-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("chunks.bin");

        let e1 = (
            "h1".into(),
            "user".into(),
            "deploy api server on port 8080".into(),
            hash_embed("deploy api server on port 8080"),
        );
        let e2 = (
            "h2".into(),
            "assistant".into(),
            "switched database to postgres 16".into(),
            hash_embed("switched database to postgres 16"),
        );
        let e1_dup = e1.clone();

        let count = append_chunks(&path, 1, &[e1, e2, e1_dup], 2000).unwrap();
        assert_eq!(count, 2);

        let hits = search_chunks(&path, "which port is the api server", &hash_embed("which port is the api server"), 2).unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits[0].text.contains("8080"), "expected port 8080 hit first, got {:?}", hits);

        // FIFO cap trims oldest
        let e3 = (
            "h3".into(),
            "user".into(),
            "enable tls cert rotation".into(),
            hash_embed("enable tls cert rotation"),
        );
        let capped = append_chunks(&path, 2, &[e3], 2).unwrap();
        assert_eq!(capped, 2);
        let loaded = load_chunks(&path).unwrap();
        assert_eq!(loaded[0].msg_hash, "h2");
        assert_eq!(loaded[1].msg_hash, "h3");

        let _ = fs::remove_dir_all(&dir);
    }
}
