/**
 * WAV (16-bit PCM, 16kHz, mono) encoder + local TTS playback.
 *
 * whisper.cpp's CLI takes a WAV file on stdin — the browser MediaRecorder
 * only produces webm/ogg, so local STT needs a real WAV. We tap the mic
 * stream with a ScriptProcessorNode (widely supported in WebView2, no
 * AudioWorklet module hassle), downsample from the track rate to 16kHz,
 * and encode a canonical WAV in JS (~70 lines, zero deps).
 *
 * TTS playback mirrors the radio module's pattern: a shared <audio>
 * element + blob URL, fail-safe (every op degrades to a no-op/error state).
 */

import { native } from "./native";
import { usePreferencesStore } from "@/modules/settings/preferences";

// ── WAV encode ─────────────────────────────────────────────────────────────

/** Encode Float32 samples (at sampleRate) into a 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const targetRate = 16000;
  // Downsample by simple linear interpolation (speech bandwidth — fine).
  const ratio = sampleRate / targetRate;
  const outLen = Math.max(0, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const t = src - i0;
    out[i] = samples[i0] * (1 - t) + samples[i1] * t;
  }
  const bytesPerSample = 2;
  const dataSize = out.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++)
      view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < out.length; i++) {
    const s = Math.max(-1, Math.min(1, out[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

// ── Local STT ──────────────────────────────────────────────────────────────

/** Transcribe a WAV blob via the local whisper.cpp engine (Rust command).
 *  Fail-safe: throws on missing engine with a user-actionable message. */
export async function transcribeLocal(wav: Blob): Promise<string> {
  const buf = new Uint8Array(await wav.arrayBuffer());
  let binary = "";
  // Chunked btoa: build in 8KB slices to avoid call-stack limits on ~MB clips.
  for (let i = 0; i < buf.length; i += 8192) {
    binary += String.fromCharCode(...buf.subarray(i, i + 8192));
  }
  const b64 = btoa(binary);
  return native.voiceTranscribe(b64);
}

// ── Speech sanitization ─────────────────────────────────────────────────

/** OpenAI /v1/audio/speech rejects inputs over 4096 chars, so chunks stay
 *  under it with headroom. Piper has no hard limit, but chunking also keeps
 *  first-audio latency low (speak chunk 1 while later chunks synthesize). */
const SPEECH_CHUNK_CHARS = 3800;
/** Pathological-dump guard (~15+ min of audio). A reply beyond this is a
 *  file dump, not prose; cut at a sentence boundary rather than reading it. */
const SPEECH_TOTAL_CAP = 24000;

/**
 * Reduce an assistant message's raw markdown to natural prose for TTS.
 * Spoken output must never include code, thinking, or markup — a reply that
 * reads fine on screen becomes nonsense when read aloud. Order matters:
 * block-level noise first, then inline formatting, then whitespace.
 *
 * Handles:
 *  - KAI's trust-boundary fence blocks (`[start tool_x]…[end tool_x]`)
 *  - thinking tags, including an UNTERMINATED tail (some local models emit
 *     a stray opening tag as the very first token of a text part)
 *  - fenced code blocks (``` / ~~~), incl. an unterminated fence tail
 *  - inline code, markdown links (keep the label), images (drop)
 *  - headings, list/bullets, blockquotes, horizontal rules, tables
 *  - bold/italic/strikethrough markers, raw HTML tags, checkbox syntax
 *
 * Conservative by design: anything it doesn't recognize is kept verbatim.
 * Pure — unit-tested in voiceTts.test.ts.
 */
export function toSpeechText(raw: string): string {
  let s = raw;
  // Trust-boundary fence blocks (tool output echo) — never speech.
  s = s.replace(/\[start [^\]]*\][\s\S]*?\[end [^\]]*\]/g, " ");
  // Thinking blocks. `thinking` variant first so it isn't left behind by the
  // shorter `think` pattern.
  s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, " ");
  s = s.replace(/<thinking>[\s\S]*$/i, " ");
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, " ");
  s = s.replace(/<think>[\s\S]*$/i, " ");
  // Fenced code blocks (with language tag), incl. an unterminated tail.
  s = s.replace(
    /(?:^|\n)[ \t]*(?:```|~~~)[^\n]*(?:\n[\s\S]*?)?(?:```|~~~)/g,
    " ",
  );
  s = s.replace(/(?:^|\n)[ \t]*(?:```|~~~)[\s\S]*$/g, " ");
  // Images before links (![alt](url) contains [alt](url)).
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Inline code.
  s = s.replace(/`([^`\n]*)`/g, "$1");
  // Block-level markers (per-line).
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, "");
  s = s.replace(/^[ \t]*\d+\.[ \t]+/gm, "");
  s = s.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, " ");
  // Table rows — pipes and alignment rows read as garbage.
  s = s.replace(/^[ \t]*\|[^\n]*\|?[ \t]*$/gm, " ");
  // Emphasis markers (bold+italic in one pass each).
  s = s.replace(/\*\*?([^*\n]+)\*\*?/g, "$1");
  s = s.replace(/__?([^_\n]+)__?/g, "$1");
  s = s.replace(/~~([^~\n]+)~~/g, "$1");
  // Checkboxes: [x] → "done", [ ] → nothing.
  s = s.replace(/\[[xX]\]/g, "done");
  s = s.replace(/\[ \]/g, "");
  // Stray raw HTML tags.
  s = s.replace(/<\/?[a-z][^<>]*>/gi, " ");
  // Collapse whitespace.
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{2,}/g, ". ");
  s = s.replace(/\n/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

/** Truncate to `cap` chars at a sentence boundary when possible. */
function capForSpeech(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const head = s.slice(0, cap);
  const cut = head.lastIndexOf(". ");
  return cut > cap * 0.5 ? s.slice(0, cut + 1) : head.trim();
}

/**
 * Split sanitized speech text into engine-sized chunks at sentence
 * boundaries. Greedy sentence packing — a sentence longer than the chunk
 * cap itself is hard-split at a word boundary. Exported for tests.
 */
export function splitForSpeech(s: string): string[] {
  if (!s.trim()) return [];
  const sentences = s.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [s];
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
    cur = "";
  };
  for (const sentence of sentences) {
    if (sentence.length > SPEECH_CHUNK_CHARS) {
      flush();
      let rest = sentence.trim();
      while (rest.length > SPEECH_CHUNK_CHARS) {
        let cut = rest.lastIndexOf(" ", SPEECH_CHUNK_CHARS);
        if (cut <= 0) cut = SPEECH_CHUNK_CHARS;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut);
      }
      cur = rest;
      continue;
    }
    if (cur && cur.length + sentence.length > SPEECH_CHUNK_CHARS) {
      flush();
    }
    cur += sentence;
  }
  flush();
  return chunks;
}

// ── Auto-speak extraction (bridge contract) ────────────────────────────────

/** Structural slice of UIMessage pickSpeakSegments consumes. */
export type SpeakMsg = {
  id: string;
  role: string;
  parts?: ReadonlyArray<{ type?: string; text?: unknown }>;
};

/** What to speak for one settled run: the run's FINAL message, in full —
 *  with a length tier for long answers (2026-11-01 research pass). */
export type SpeakPlan = {
  text: string;
  /** Message id of the LAST text part's message — the run's final answer,
   *  used as the speak dedupe key (a new run's answer id is always fresh). */
  lastMessageId: string;
};

/** Below this, an answer reads in under a minute — speak it in FULL. */
export const SPEAK_FULL_CHARS = 700;
/** The spoken sign-off when a long answer is trimmed to its lead paragraph. */
const LONG_REPLY_SIGNOFF = "The full answer is on screen.";

/** Trim a long answer to its lead paragraph (through the first blank-line
 *  break, ~1–2 sentences — the direct answer) for the spoken tier. */
function leadParagraph(s: string): string {
  const idx = s.search(/\n\s*\n/);
  return (idx > 0 ? s.slice(0, idx) : s).trim();
}

/**
 * Pick what a settled agent run should SAY (2026-11-01, redesign after the
 * narration research pass).
 *
 * PREVIOUS contract: FIRST part + LAST part of the run, middle skipped.
 * That answered "say the lead-in and the final" — but in practice a
 * multi-part reply reads as an incoherent abridgment: "Let me check…"
 * glued to a conclusion the middle set up, and the step narrations the
 * user DID want context for are gone. The industry splits into three
 * models (speech-native generation; a voice layer over summaries like
 * VS Code Voice Mode; verbatim read-aloud with user-paced controls like
 * Safari Listen-to-Page). KAI is a narrator of its own agent's prose, so
 * the closest fit is the third — READ THE REPLY, and give the user the
 * pace controls.
 *
 * NEW contract: speak the COMPLETE text of the FINAL assistant message of
 * the run (all its text parts, in order). The step-by-step narrations in
 * EARLIER messages are not the reply — the final message is. Length
 * tiers: short answers (<= SPEAK_FULL_CHARS) speak in full; long answers
 * speak the lead paragraph + a short sign-off pointing at the screen
 * ("The full answer is on screen.") — honest about what was cut, instead
 * of silently swallowing the middle.
 *
 * Causality is the bridge's boundary contract, passed in: only messages at
 * index >= `from` are this run's, EXCEPT an in-place tail replacement
 * (regenerate/stall-recovery rewrites the boundary assistant object into
 * a NEW object with fresh text — same slot, new identity), which is still
 * this run's reply. The boundary OBJECT is matched by identity, never id:
 * the SDK deep-clones on replaceMessage, so a regenerated reply has the
 * same id but a new object.
 */
export function pickSpeakSegments(
  msgs: readonly SpeakMsg[],
  from: number,
  boundaryObj: SpeakMsg | null,
): SpeakPlan | null {
  // The run's final assistant message: the last message (at or after the
  // boundary) holding any text part. Walked from the tail; the boundary
  // object itself is replaced-in-place for regenerate, so a NEW object in
  // that slot counts as this run's too.
  const start = Math.max(from, 0);
  const isAnswer = (m: SpeakMsg | undefined): m is SpeakMsg =>
    !!m &&
    m.role === "assistant" &&
    m !== boundaryObj &&
    (m.parts ?? []).some(
      (p) => p.type === "text" && typeof p.text === "string" && p.text.trim(),
    );
  let finalMsg: SpeakMsg | null = null;
  for (let i = msgs.length - 1; i >= start; i--) {
    if (isAnswer(msgs[i])) {
      finalMsg = msgs[i]!;
      break;
    }
  }
  // Regenerate/stall-recovery: no assistant after `from`, but the boundary
  // slot itself holds a NEW object (identity swap, same id) with fresh
  // text — that object IS this run's reply.
  if (!finalMsg && boundaryObj != null && start > 0) {
    const slot = msgs[start - 1];
    if (slot && slot !== boundaryObj && isAnswer(slot)) finalMsg = slot;
  }
  if (!finalMsg) return null;
  const texts = (finalMsg.parts ?? [])
    .filter(
      (p): p is { type: "text"; text: string } =>
        p.type === "text" && typeof p.text === "string" && !!p.text.trim(),
    )
    .map((p) => p.text.trim());
  if (texts.length === 0) return null;
  let text = texts.join("\n\n");
  // LENGTH TIERS: short answers speak in full; long answers speak the lead
  // paragraph + sign-off. The sign-off names WHAT WAS CUT (everything after
  // the lead) — never a silent elision.
  if (text.length > SPEAK_FULL_CHARS) {
    const lead = leadParagraph(text);
    text =
      lead.length > 0 && lead.length < text.length
        ? `${lead} ${LONG_REPLY_SIGNOFF}`
        : `${text.slice(0, SPEAK_FULL_CHARS)}… ${LONG_REPLY_SIGNOFF}`;
  }
  return { text, lastMessageId: finalMsg.id };
}

// ── TTS playback ───────────────────────────────────────────────────────────

let sharedAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
/** Identifies the newest speakText call; every older queue self-terminates
 *  when it observes a token mismatch. Monotonic — never reused. */
let runToken = 0;
/** Highest token still synthesizing/queueing — lets ttsPlaying() report
 *  in-flight synthesis for the current run. 0 = idle. */
let synthesizingRun = 0;
/** Chunk boundary skip: set by ttsSkip() while a chunk is playing; consumed
 *  by playBuffer's ended-listener so the promise resolves immediately. */
let skipRequested = false;
/** Pause/resume: paused playback keeps the element + blob URL alive; the
 *  run loop holds at the await until resumed (or superseded/stopped). */
let pauseRequested = false;
let resumeResolve: (() => void) | null = null;
/** Playback rate (pacing control) — clamped, applied to every chunk. */
let playbackRate = 1;

/** User pause/resume of the current utterance. Fail-safe no-ops. */
export function ttsPause(): void {
  if (!ttsPlaying()) return;
  pauseRequested = true;
  try {
    sharedAudio?.pause();
  } catch {
    // ignore
  }
  notifyTtsListeners();
}
export function ttsResume(): void {
  if (!pauseRequested) return;
  pauseRequested = false;
  try {
    void sharedAudio?.play().catch(() => {});
  } catch {
    // ignore
  }
  const r = resumeResolve;
  resumeResolve = null;
  r?.();
  notifyTtsListeners();
}
/** True when the current utterance is PAUSED (a paused player is not
 *  "playing", but the run is still alive). */
export function ttsPaused(): boolean {
  return pauseRequested;
}
/** Skip the REMAINDER of the current chunk (jump to the next one). */
export function ttsSkip(): void {
  if (!ttsPlaying()) return;
  skipRequested = true;
  try {
    sharedAudio?.pause();
  } catch {
    // ignore
  }
}
/** Set the playback rate for current + future utterances (0.5–2). */
export function ttsSetRate(rate: number): void {
  playbackRate = Math.min(2, Math.max(0.5, rate || 1));
  try {
    if (sharedAudio) sharedAudio.playbackRate = playbackRate;
  } catch {
    // ignore
  }
}

function getAudioEl(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (!sharedAudio) {
    try {
      sharedAudio = new window.Audio();
    } catch {
      return null;
    }
  }
  return sharedAudio;
}

/** Revoke the current chunk's blob URL (idempotent). */
function releaseUrl(): void {
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
}

/** Stop any in-flight playback and discard the queued remainder. Fail-safe. */
export function ttsStop(): void {
  runToken++; // invalidates every queued/synthesizing chunk of older runs
  // Clear the pacing state so a stopped utterance can't leave pause/skip
  // latched for the NEXT speak.
  skipRequested = false;
  if (pauseRequested) {
    pauseRequested = false;
    const r = resumeResolve;
    resumeResolve = null;
    r?.();
  }
  const el = getAudioEl();
  if (!el) return;
  try {
    el.pause();
    el.removeAttribute("src");
    releaseUrl();
  } catch {
    // ignore
  }
  notifyTtsListeners();
}

/** True when a TTS utterance is playing (or synthesizing, for the latest
 *  run). A PAUSED utterance reports false — the run is alive but silent;
 *  ttsPaused() distinguishes the two. */
export function ttsPlaying(): boolean {
  try {
    if (pauseRequested) return false;
    const audioActive =
      !!sharedAudio && !sharedAudio.paused && !sharedAudio.ended;
    return (
      audioActive || (synthesizingRun >= runToken && synthesizingRun !== 0)
    );
  } catch {
    return false;
  }
}

// ── Playing-state subscription (UI needs a live indicator, not a poll) ──────

type TtsPlayingListener = (playing: boolean) => void;
const ttsListeners = new Set<TtsPlayingListener>();

/** Subscribe to playing-state changes. Returns an unsubscribe function.
 *  The callback fires ONLY on transitions (idle→playing / playing→idle),
 *  not on every internal state poll. */
export function subscribeTtsPlaying(cb: TtsPlayingListener): () => void {
  ttsListeners.add(cb);
  // Deliver the current state synchronously so the subscriber is immediately
  // consistent (a button appearing/disappearing must not depend on the next
  // transition happening to occur).
  try {
    cb(ttsPlaying());
  } catch {
    // Listener errors must not break the TTS pipeline.
  }
  return () => {
    ttsListeners.delete(cb);
  };
}

/** Notify subscribers on playing-state transitions. Cheap — compare with the
 *  last broadcast to suppress duplicate notifications. */
let lastNotified: boolean | null = null;
function notifyTtsListeners(): void {
  const playing = ttsPlaying();
  if (playing === lastNotified) return;
  lastNotified = playing;
  for (const cb of ttsListeners) {
    try {
      cb(playing);
    } catch {
      // Listener errors must not break the TTS pipeline.
    }
  }
}

/**
 * Speak `text` — the WHOLE thing, not a truncated fragment. The sanitized
 * text is split into engine-sized chunks (splitForSpeech) and spoken
 * sequentially: chunk 1 starts as soon as it is synthesized while later
 * chunks synthesize in the background. A newer speakText/ttsStop call
 * invalidates every pending chunk of an older run (monotonic run token).
 * Fail-safe: logs and returns false rather than throwing; pass `onError`
 * to surface the reason in UI (settings sections do).
 */
export async function speakText(
  text: string,
  onError?: (message: string) => void,
): Promise<boolean> {
  const cleaned = capForSpeech(toSpeechText(text), SPEECH_TOTAL_CAP);
  if (!cleaned) return false;
  const prefs = usePreferencesStore.getState();
  const mode = prefs.voiceTtsMode;
  if (mode === "off") return false;
  // A new utterance replaces whatever is playing/queued.
  ttsStop();
  const token = ++runToken;
  synthesizingRun = token;
  notifyTtsListeners();
  try {
    for (const chunk of splitForSpeech(cleaned)) {
      // Superseded by a newer utterance (or stopped) — abandon the rest.
      if (token !== runToken) return true;
      let bytes: ArrayBuffer;
      if (mode === "local") {
        const b64 = await native.voiceTts(chunk, prefs.voiceTtsLocalVoice);
        bytes = base64ToBytes(b64);
      } else if (mode === "assemblyai") {
        bytes = await speakViaAssemblyAi(chunk, prefs.voiceTtsAssemblyVoice);
      } else {
        bytes = await speakViaOpenAi(
          chunk,
          prefs.voiceTtsApiModel,
          prefs.voiceTtsApiVoice,
        );
      }
      if (token !== runToken) return true;
      await playBuffer(bytes, token);
    }
    return true;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    console.error("[kai] tts failed:", e);
    onError?.(msg);
    return false;
  } finally {
    if (synthesizingRun === token) synthesizingRun = 0;
    notifyTtsListeners();
  }
}

/** Blob → shared <audio> playback, resolved when the chunk finishes,
 *  is skipped, or the run is superseded. Honors pause/resume (holds the
 *  promise while paused) and the playback rate. */
function playBuffer(bytes: ArrayBuffer, token: number): Promise<void> {
  return new Promise((resolve) => {
    const el = getAudioEl();
    if (!el) {
      resolve();
      return;
    }
    releaseUrl();
    currentUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
    el.src = currentUrl;
    try {
      el.playbackRate = playbackRate;
    } catch {
      // ignore
    }
    skipRequested = false;
    const finish = () => {
      el.removeEventListener("ended", finish);
      el.removeEventListener("pause", onPaused);
      resolve();
    };
    const onPaused = () => {
      // Skip wins over pause (skip already paused the element): resolve now.
      if (skipRequested) {
        finish();
        return;
      }
      // A pause requested via ttsPause holds this chunk open until resumed.
      if (pauseRequested && !resumeResolve) {
        resumeResolve = finish;
      }
    };
    el.addEventListener("ended", finish);
    el.addEventListener("pause", onPaused);
    void el.play().catch(() => resolve());
    // Superseded while synthesizing this chunk: resolve so the loop exits.
    if (token !== runToken) {
      finish();
    }
    el.addEventListener("ended", () => notifyTtsListeners(), { once: true });
    // `play` can reject even on success path (autoplay quirks) — notify on
    // the next tick either way so the icon follows reality, not intent.
    setTimeout(notifyTtsListeners, 0);
  });
}

function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** AssemblyAI /v1/speech (WAV) via the SSRF-hardened Rust proxy - same
 *  keyring-read rule as the OpenAI path below (the settings window's
 *  chatStore never hydrates apiKeys). */
async function speakViaAssemblyAi(
  text: string,
  voice: string,
): Promise<ArrayBuffer> {
  const { speakViaAssemblyAi: synthesize } = await import("./assemblyai");
  return await synthesize(text, voice);
}

/** OpenAI /v1/audio/speech via the SSRF-hardened Rust proxy (binary response).
 *  The key comes straight from the OS keyring, NOT the chat store: the
 *  settings window is a separate webview whose chatStore never hydrates
 *  apiKeys, so a store read silently fails there. keyring.getKey works in
 *  every window. */
async function speakViaOpenAi(
  text: string,
  model: string,
  voice: string,
): Promise<ArrayBuffer> {
  const { getKey } = await import("../lib/keyring");
  const apiKey = await getKey("openai");
  if (!apiKey)
    throw new Error("TTS needs an OpenAI API key (Settings → Models).");
  const { proxyFetch } = await import("./proxyFetch");
  const resp = await proxyFetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || "gpt-4o-mini-tts",
      voice: voice || "alloy",
      input: text.slice(0, 4000),
      response_format: "wav",
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      `OpenAI TTS failed (${resp.status}): ${detail.slice(0, 200)}`,
    );
  }
  return await resp.arrayBuffer();
}
