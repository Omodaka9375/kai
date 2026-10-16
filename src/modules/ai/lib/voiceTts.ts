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
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true);  // PCM
  view.setUint16(22, 1, true);  // mono
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

/** Upper bound on spoken text. Piper and OpenAI TTS both degrade with long
 *  inputs (Piper generates minutes of audio linearly; the API charges per
 *  character) — replies longer than this are cut at a sentence boundary. */
const SPEECH_TEXT_CAP = 4000;

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
  s = s.replace(/(?:^|\n)[ \t]*(?:```|~~~)[^\n]*(?:\n[\s\S]*?)?(?:```|~~~)/g, " ");
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

/** Truncate to SPEECH_TEXT_CAP at a sentence boundary when possible. */
function capForSpeech(s: string): string {
  if (s.length <= SPEECH_TEXT_CAP) return s;
  const head = s.slice(0, SPEECH_TEXT_CAP);
  const cut = head.lastIndexOf(". ");
  return (cut > SPEECH_TEXT_CAP * 0.5 ? s.slice(0, cut + 1) : head.trim()) ;
}

// ── TTS playback ───────────────────────────────────────────────────────────

let sharedAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

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

/** Stop any in-flight playback and release the blob URL. Fail-safe. */
export function ttsStop(): void {
  const el = getAudioEl();
  if (!el) return;
  try {
    el.pause();
    el.removeAttribute("src");
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
      currentUrl = null;
    }
  } catch {
    // ignore
  }
}

/** True when a TTS utterance is playing. */
export function ttsPlaying(): boolean {
  try {
    return !!sharedAudio && !sharedAudio.paused && !sharedAudio.ended;
  } catch {
    return false;
  }
}

/** Speak `text` via the configured TTS mode (local Piper or OpenAI API).
 *  The input is SANITIZED first — code blocks, thinking tags, and markdown
 *  formatting are stripped so only the natural prose is spoken (see
 *  toSpeechText). Fail-safe: logs and returns false rather than throwing;
 *  pass `onError` to surface the reason in UI (settings sections do). */
export async function speakText(
  text: string,
  onError?: (message: string) => void,
): Promise<boolean> {
  const cleaned = capForSpeech(toSpeechText(text));
  if (!cleaned) return false;
  const prefs = usePreferencesStore.getState();
  const mode = prefs.voiceTtsMode;
  if (mode === "off") return false;
  ttsStop();
  try {
    let bytes: ArrayBuffer;
    if (mode === "local") {
      const b64 = await native.voiceTts(cleaned);
      bytes = base64ToBytes(b64);
    } else {
      bytes = await speakViaOpenAi(cleaned, prefs.voiceTtsApiModel, prefs.voiceTtsApiVoice);
    }
    const blob = new Blob([bytes], { type: "audio/wav" });
    currentUrl = URL.createObjectURL(blob);
    const el = getAudioEl();
    if (!el) return false;
    el.src = currentUrl;
    await el.play();
    return true;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e);
    console.error("[kai] tts failed:", e);
    onError?.(msg);
    return false;
  }
}

function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** OpenAI /v1/audio/speech via the SSRF-hardened Rust proxy (binary response).
 *  The key comes straight from the OS keyring, NOT the chat store: the
 *  settings window is a separate webview whose chatStore never hydrates
 *  apiKeys, so a store read silently fails there. keyring.getKey works in
 *  every window. */
async function speakViaOpenAi(text: string, model: string, voice: string): Promise<ArrayBuffer> {
  const { getKey } = await import("../lib/keyring");
  const apiKey = await getKey("openai");
  if (!apiKey) throw new Error("TTS needs an OpenAI API key (Settings → Models).");
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
    throw new Error(`OpenAI TTS failed (${resp.status}): ${detail.slice(0, 200)}`);
  }
  return await resp.arrayBuffer();
}
