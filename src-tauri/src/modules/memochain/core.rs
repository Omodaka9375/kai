//! MemoChain core math + capsule/embedding primitives.
//!
//! Bit-exact with `mina/crates/memochain-core` and `mina/src/memochain/`:
//! - 11 heads x 32 keys x 32 values of int16 in Q14 fixed point (22,528 bytes).
//! - Distilled student writer (`StudentWriter`) operating zero-copy over the
//!   3,605,932-byte `weights.bin`.
//! - SHA-256 receipt chain (`step|prev_head|doc_hash|state_digest`, rolling
//!   accumulator `sha256(prev_head + binding)`).
//! - Version 1 `Capsule` binary envelope (78-byte header + 22,528-byte state =
//!   22,606 bytes), byte-identical with Python `memochain.state.Capsule`.
//! - Deterministic 2560-d SHA-256 feature-hashing embedder (`hash_embed`),
//!   matching Python `memochain.server.app._hash_embed`.

use sha2::{Digest, Sha256};

pub const N_HEADS: usize = 11;
pub const KEY_DIM: usize = 32;
pub const VAL_DIM: usize = 32;
pub const KEY_PART: usize = N_HEADS * KEY_DIM; // 352
pub const HEAD_PARAMS: usize = KEY_DIM * VAL_DIM; // 1024
pub const STATE_PARAMS: usize = N_HEADS * HEAD_PARAMS; // 11264
pub const STATE_BYTES: usize = STATE_PARAMS * 2; // 22528

pub const Q_SHIFT: i64 = 14;
pub const Q_ONE: i64 = 1 << Q_SHIFT; // 16384

pub const EMBED_DIM: usize = 2560;

pub const WEIGHTS_BYTES: usize = KEY_PART * EMBED_DIM * 2 // w_key
    + KEY_PART * 2 // b_key
    + KEY_PART * EMBED_DIM * 2 // w_val
    + KEY_PART * 2 // b_val
    + N_HEADS * 2 // beta
    + N_HEADS * 2; // decay (3,605,932 B)

pub const EXPECTED_WEIGHTS_SHA256: &str =
    "626e2089fe38bc593ebf8421873739438aa47b86408db10bafc4eb424f82d67b";

pub const CAPSULE_MAGIC: [u8; 4] = *b"MCN1";
pub const CAPSULE_V1_HEADER_SIZE: usize = 78;
pub const CAPSULE_V1_BYTES: usize = CAPSULE_V1_HEADER_SIZE + STATE_BYTES; // 22,606

const I16_MAX: i64 = 32767;
const I16_MIN: i64 = -32768;

/// Deterministic integer square root (Newton, integer only).
pub fn isqrt(n: i64) -> i64 {
    if n <= 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

#[inline]
fn floor_div(a: i64, b: i64) -> i64 {
    a.div_euclid(b)
}

#[inline]
pub fn clip16(x: i64) -> i16 {
    x.clamp(I16_MIN, I16_MAX) as i16
}

/// Scale a key to Q14 unit norm using integer math only.
pub fn unit_key(k: &[i64]) -> Vec<i16> {
    let norm = isqrt(k.iter().map(|&x| x * x).sum());
    if norm == 0 {
        return vec![0i16; k.len()];
    }
    k.iter()
        .map(|&x| clip16(floor_div(x * Q_ONE, norm)))
        .collect()
}

pub fn zero_state() -> Vec<i16> {
    vec![0i16; STATE_PARAMS]
}

/// Lowercase SHA-256 hex digest.
pub fn sha256_hex(data: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut hasher = Sha256::new();
    hasher.update(data);
    let out = hasher.finalize();
    let mut buf = [0u8; 64];
    for (i, &b) in out.iter().enumerate() {
        buf[i * 2] = HEX[(b >> 4) as usize];
        buf[i * 2 + 1] = HEX[(b & 0xf) as usize];
    }
    String::from_utf8(buf.to_vec()).expect("ascii hex")
}

pub fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

pub fn hex_to_32(hex: &str) -> Result<[u8; 32], String> {
    if hex.is_empty() {
        return Ok([0u8; 32]);
    }
    if hex.len() != 64 {
        return Err(format!(
            "chain head must be empty or 64 hex chars, got {}",
            hex.len()
        ));
    }
    let bytes = hex.as_bytes();
    let mut out = [0u8; 32];
    for i in 0..32 {
        let hi = from_hex_nibble(bytes[i * 2])?;
        let lo = from_hex_nibble(bytes[i * 2 + 1])?;
        out[i] = (hi << 4) | lo;
    }
    Ok(out)
}

fn from_hex_nibble(b: u8) -> Result<u8, String> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => Err(format!("invalid hex char: {}", b as char)),
    }
}

pub fn bytes_to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0xf) as usize] as char);
    }
    out
}

pub fn state_to_le_bytes(state: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(state.len() * 2);
    for &v in state {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    bytes
}

pub fn state_from_le_bytes(raw: &[u8]) -> Result<Vec<i16>, String> {
    if raw.len() != STATE_BYTES {
        return Err(format!(
            "expected {} state bytes, got {}",
            STATE_BYTES,
            raw.len()
        ));
    }
    let mut out = Vec::with_capacity(STATE_PARAMS);
    for chunk in raw.as_chunks::<2>().0 {
        out.push(i16::from_le_bytes([chunk[0], chunk[1]]));
    }
    Ok(out)
}

pub fn state_digest(state: &[i16]) -> String {
    sha256_hex(&state_to_le_bytes(state))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainHead {
    pub step: u64,
    pub accumulator: String,
    pub state_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiptRow {
    pub step: u64,
    pub doc_hash: String,
    pub state_digest: String,
    pub binding: String,
    pub accumulator: String,
}

/// Deterministic offline 2560-d L2-normalized feature-hashing embedding.
/// Matches Python `memochain.server.app._hash_embed`.
pub fn hash_embed(text: &str) -> Vec<f32> {
    let mut out = vec![0.0f32; EMBED_DIM];
    for token in text.to_lowercase().split_whitespace() {
        let h = sha256_bytes(token.as_bytes());
        let idx = (u32::from_le_bytes([h[0], h[1], h[2], h[3]]) as usize) % EMBED_DIM;
        let sign = if h[4].is_multiple_of(2) { 1.0f32 } else { -1.0f32 };
        out[idx] += sign;
    }
    let norm_sq: f32 = out.iter().map(|&v| v * v).sum();
    let norm = norm_sq.sqrt();
    if norm > 0.0 {
        for v in &mut out {
            *v /= norm;
        }
    }
    out
}

/// Convert an f32 embedding into Q14 int16, matching Python:
/// `np.clip(np.round(docs_f * (1 << 14)), -32768, 32767).astype("<i2")`.
/// Uses round-half-to-even (IEEE 754 `f32::round_ties_even`), matching numpy's `np.round`.
pub fn embed_to_q14(embed: &[f32]) -> Vec<i16> {
    let scale = (1u32 << Q_SHIFT) as f32;
    embed
        .iter()
        .map(|&v| {
            let scaled = (v * scale).round_ties_even();
            scaled.clamp(I16_MIN as f32, I16_MAX as f32) as i16
        })
        .collect()
}

/// Quantize a unit vector into int8 + float32 scale (matches Python `ChunkStore._quantize_i8`).
pub fn quantize_i8(unit_vec: &[f32]) -> (Vec<i8>, f32) {
    let mut max_abs = 0.0f32;
    for &v in unit_vec {
        let a = v.abs();
        if a > max_abs {
            max_abs = a;
        }
    }
    if max_abs <= 0.0 {
        return (vec![0i8; unit_vec.len()], 0.0);
    }
    let scale = max_abs / 127.0;
    let q = unit_vec
        .iter()
        .map(|&v| (v / scale).round_ties_even().clamp(-127.0, 127.0) as i8)
        .collect();
    (q, scale)
}

/// Zero-copy view over canonical little-endian quantized student weights.
pub struct StudentWriter<'a> {
    pub raw: &'a [u8],
}

impl<'a> StudentWriter<'a> {
    pub fn from_bytes(raw: &'a [u8]) -> Result<Self, String> {
        if raw.len() != WEIGHTS_BYTES {
            return Err(format!(
                "weights length {} != expected {}",
                raw.len(),
                WEIGHTS_BYTES
            ));
        }
        Ok(Self { raw })
    }

    pub fn weights_digest(&self) -> String {
        sha256_hex(self.raw)
    }

    #[inline]
    fn read_i16(&self, byte_offset: usize) -> i16 {
        i16::from_le_bytes([self.raw[byte_offset], self.raw[byte_offset + 1]])
    }

    #[inline]
    fn w_key_off() -> usize {
        0
    }
    #[inline]
    fn b_key_off() -> usize {
        KEY_PART * EMBED_DIM * 2
    }
    #[inline]
    fn w_val_off() -> usize {
        Self::b_key_off() + KEY_PART * 2
    }
    #[inline]
    fn b_val_off() -> usize {
        Self::w_val_off() + KEY_PART * EMBED_DIM * 2
    }
    #[inline]
    fn beta_off() -> usize {
        Self::b_val_off() + KEY_PART * 2
    }
    #[inline]
    fn decay_off() -> usize {
        Self::beta_off() + N_HEADS * 2
    }

    pub fn b_key(&self, r: usize) -> i64 {
        self.read_i16(Self::b_key_off() + r * 2) as i64
    }

    pub fn b_val(&self, r: usize) -> i64 {
        self.read_i16(Self::b_val_off() + r * 2) as i64
    }

    pub fn beta(&self, h: usize) -> i64 {
        self.read_i16(Self::beta_off() + h * 2) as i64
    }

    pub fn decay(&self, h: usize) -> i64 {
        self.read_i16(Self::decay_off() + h * 2) as i64
    }

    #[inline]
    fn row_dot(&self, matrix_base: usize, row: usize, x: &[i16]) -> i64 {
        let row_bytes = &self.raw
            [matrix_base + row * EMBED_DIM * 2..matrix_base + (row + 1) * EMBED_DIM * 2];
        let mut acc = 0i64;
        for (wb, &xv) in row_bytes.as_chunks::<2>().0.iter().zip(x.iter()) {
            let w = i16::from_le_bytes([wb[0], wb[1]]) as i64;
            acc += w * (xv as i64);
        }
        acc
    }

    pub fn project_dots(&self, doc: &[i16]) -> ([i64; KEY_PART], [i64; KEY_PART]) {
        assert_eq!(doc.len(), EMBED_DIM);
        let mut dk = [0i64; KEY_PART];
        let mut dv = [0i64; KEY_PART];
        let wk_base = Self::w_key_off();
        let wv_base = Self::w_val_off();
        for r in 0..KEY_PART {
            dk[r] = self.row_dot(wk_base, r, doc);
            dv[r] = self.row_dot(wv_base, r, doc);
        }
        (dk, dv)
    }

    pub fn fold_from_dots(&self, state: &[i16], dot_k: &[i64], dot_v: &[i64]) -> Vec<i16> {
        assert_eq!(state.len(), STATE_PARAMS);
        assert_eq!(dot_k.len(), KEY_PART);
        assert_eq!(dot_v.len(), KEY_PART);

        let mut tokens: Vec<i64> = state.iter().map(|&x| x as i64).collect();
        let mut raw_k_h = [0i64; KEY_DIM];
        let mut raw_v_h = [0i16; VAL_DIM];

        for h in 0..N_HEADS {
            for i in 0..KEY_DIM {
                let r = h * KEY_DIM + i;
                raw_k_h[i] = (dot_k[r] >> Q_SHIFT) + self.b_key(r);
                raw_v_h[i] = clip16((dot_v[r] >> Q_SHIFT) + self.b_val(r));
            }
            let uk = unit_key(&raw_k_h);
            if uk.iter().all(|&x| x == 0) {
                continue;
            }
            let base = h * HEAD_PARAMS;
            let beta_h = self.beta(h);
            let decay_h = self.decay(h);

            let mut recalled = [0i64; VAL_DIM];
            for (v, rec) in recalled.iter_mut().enumerate() {
                let mut acc = 0i64;
                for (kk, &k_signed) in uk.iter().enumerate() {
                    acc += k_signed as i64 * tokens[base + kk * VAL_DIM + v];
                }
                *rec = acc >> Q_SHIFT;
            }
            let mut delta = [0i64; VAL_DIM];
            for (v, &rv) in recalled.iter().enumerate() {
                delta[v] = (beta_h * (raw_v_h[v] as i64 - rv)) >> Q_SHIFT;
            }
            for (kk, &k_signed) in uk.iter().enumerate() {
                let k_val = k_signed as i64;
                for (v, &dv) in delta.iter().enumerate() {
                    let idx = base + kk * VAL_DIM + v;
                    let decayed = (decay_h * tokens[idx]) >> Q_SHIFT;
                    let update = (k_val * dv) >> Q_SHIFT;
                    tokens[idx] = decayed + update;
                }
            }
        }
        tokens.iter().map(|&x| clip16(x)).collect()
    }

    /// Fold one Q14 2560-d document into `state`, returning `(new_state, receipt, new_head)`.
    pub fn fold_doc_with_receipt(
        &self,
        state: &[i16],
        doc: &[i16],
        prev: Option<&ChainHead>,
    ) -> (Vec<i16>, ReceiptRow, ChainHead) {
        let mut doc_bytes = Vec::with_capacity(EMBED_DIM * 2);
        for &v in doc {
            doc_bytes.extend_from_slice(&v.to_le_bytes());
        }
        let d_hash = sha256_hex(&doc_bytes);
        let (dk, dv) = self.project_dots(doc);
        let new_state = self.fold_from_dots(state, &dk, &dv);
        let s_digest = state_digest(&new_state);

        let step = prev.map_or(1, |h| h.step + 1);
        let prev_acc = prev.map_or_else(|| "0".repeat(64), |h| h.accumulator.clone());
        let binding = sha256_hex(format!("{step}|{prev_acc}|{d_hash}|{s_digest}").as_bytes());
        let accumulator = sha256_hex(format!("{prev_acc}{binding}").as_bytes());

        let receipt = ReceiptRow {
            step,
            doc_hash: d_hash,
            state_digest: s_digest.clone(),
            binding,
            accumulator: accumulator.clone(),
        };
        let head = ChainHead {
            step,
            accumulator,
            state_digest: s_digest,
        };
        (new_state, receipt, head)
    }
}

/// Version 1 Capsule envelope (78-byte header + 22,528-byte state = 22,606 bytes).
/// Byte-identical to Python `memochain.state.Capsule` (v1) and verifiable by
/// standalone MemoChain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capsule {
    pub state: Vec<i16>,
    pub step: u64,
    pub head: String, // 64 lowercase hex chars, or empty
}

impl Capsule {
    pub fn to_bytes(&self) -> Result<Vec<u8>, String> {
        if self.state.len() != STATE_PARAMS {
            return Err(format!(
                "expected {} state params, got {}",
                STATE_PARAMS,
                self.state.len()
            ));
        }
        let payload = state_to_le_bytes(&self.state);
        let head_bytes = hex_to_32(&self.head)?;
        let payload_hash = sha256_bytes(&payload);

        let mut out = Vec::with_capacity(CAPSULE_V1_BYTES);
        out.extend_from_slice(&CAPSULE_MAGIC);
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&self.step.to_le_bytes());
        out.extend_from_slice(&head_bytes);
        out.extend_from_slice(&payload_hash);
        out.extend_from_slice(&payload);
        debug_assert_eq!(out.len(), CAPSULE_V1_BYTES);
        Ok(out)
    }

    pub fn from_bytes(raw: &[u8]) -> Result<Self, String> {
        if raw.len() < CAPSULE_V1_BYTES {
            return Err(format!("capsule too small: {} bytes", raw.len()));
        }
        if raw[0..4] != CAPSULE_MAGIC {
            return Err("not a MemoChain capsule (bad magic)".into());
        }
        let version = u16::from_le_bytes([raw[4], raw[5]]);
        let step = u64::from_le_bytes(raw[6..14].try_into().unwrap());
        let head_bytes = &raw[14..46];
        let payload_hash = &raw[46..78];

        if version != 1 {
            return Err(format!("unsupported capsule format version {version}"));
        }
        if raw.len() != CAPSULE_V1_BYTES {
            return Err(format!(
                "capsule size mismatch: expected {}, got {}",
                CAPSULE_V1_BYTES,
                raw.len()
            ));
        }
        let payload = &raw[CAPSULE_V1_HEADER_SIZE..];
        let actual_hash = sha256_bytes(payload);
        if actual_hash.as_slice() != payload_hash {
            return Err("capsule payload hash mismatch (corrupted or tampered)".into());
        }
        let head = if head_bytes.iter().all(|&b| b == 0) {
            String::new()
        } else {
            bytes_to_hex(head_bytes)
        };
        Ok(Self {
            state: state_from_le_bytes(payload)?,
            step,
            head,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capsule_roundtrip_and_tamper_detection() {
        let mut state = zero_state();
        state[0] = 1234;
        state[STATE_PARAMS - 1] = -4321;
        let head = sha256_hex(b"head-1");
        let cap = Capsule {
            state: state.clone(),
            step: 7,
            head: head.clone(),
        };
        let bytes = cap.to_bytes().unwrap();
        assert_eq!(bytes.len(), CAPSULE_V1_BYTES);
        assert_eq!(bytes.len(), 22_606);
        let decoded = Capsule::from_bytes(&bytes).unwrap();
        assert_eq!(decoded, cap);

        // Bit flip in payload must fail hash verification.
        let mut bad = bytes.clone();
        bad[CAPSULE_V1_HEADER_SIZE + 10] ^= 0x01;
        assert!(Capsule::from_bytes(&bad).is_err());
    }

    #[test]
    fn hash_embed_is_unit_norm_and_deterministic() {
        let a = hash_embed("Hello MemoChain World 42");
        let b = hash_embed("hello   memochain\nworld 42");
        assert_eq!(a.len(), EMBED_DIM);
        assert_eq!(a, b);
        let norm: f32 = a.iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5, "norm={norm}");
    }

    #[test]
    fn bundled_weights_match_expected_digest_and_fold() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/memochain/weights.bin");
        let raw = std::fs::read(&path).expect("bundled weights.bin must exist");
        let writer = StudentWriter::from_bytes(&raw).expect("valid weights");
        assert_eq!(writer.weights_digest(), EXPECTED_WEIGHTS_SHA256);

        let emb = hash_embed("deploy service on port 8080 with rust");
        let q14 = embed_to_q14(&emb);
        let (s1, r1, h1) = writer.fold_doc_with_receipt(&zero_state(), &q14, None);
        assert_eq!(r1.step, 1);
        assert_eq!(h1.step, 1);
        assert_eq!(state_digest(&s1), h1.state_digest);
        assert_ne!(s1, zero_state());
    }
}
