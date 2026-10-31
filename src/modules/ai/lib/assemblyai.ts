/**
 * AssemblyAI voice engine - STT (Sync API) + TTS (HTTP API).
 *
 * Both surfaces ride the SSRF-hardened Rust proxy (proxyFetch), the same
 * path the OpenAI voice engines use. The key lives in the OS keyring
 * (`assemblyai` provider id, set via Settings > Models), read lazily per
 * call so the settings window works too.
 *
 * STT - Sync API (`POST https://sync.assemblyai.com/v1/transcribe`):
 * one multipart call, transcript in the same response, no polling. Our
 * mic clips are WebM/Opus from MediaRecorder - the Sync API accepts
 * compressed formats directly (up to 20 min / 256 MB; our clips are
 * seconds), so no transcoding is needed. Universal-3.5 Pro is the model
 * behind it (the `X-AAI-Model` header is REQUIRED on every request).
 *
 * TTS - HTTP API (`POST https://tts.us.assemblyai.com/v1/speech`):
 * `{text, voice_id, container: "wav"}` -> WAV bytes, exactly the shape
 * speakText's playback path expects. Voice slugs are `aai-*` (see
 * ASSEMBLY_VOICES); default aai-jane. Text per request should stay
 * sentence-sized - speakText already chunks via splitForSpeech, and
 * AssemblyAI bills per character.
 */

import { getKey } from "./keyring";
import { proxyFetch } from "./proxyFetch";

/** Built-in AssemblyAI-TTS-1 voices (always loaded, English). Curated to
 *  a compact picker; the full catalog is addressable by slug too - a
 *  custom slug typed in the picker is passed through verbatim. */
export const ASSEMBLY_VOICES: ReadonlyArray<{ id: string; label: string; note: string }> = [
  { id: "aai-jane", label: "Jane", note: "default - steady American English" },
  { id: "aai-audrey", label: "Audrey", note: "middle-aged woman, even intonation" },
  { id: "aai-sara", label: "Sara", note: "young woman, steady American English" },
  { id: "aai-michael", label: "Michael", note: "male, American English" },
  { id: "aai-paul", label: "Paul", note: "male, American English" },
  { id: "aai-charles", label: "Charles", note: "male, British English" },
  { id: "aai-eve", label: "Eve", note: "female, expressive" },
  { id: "aai-george", label: "George", note: "male, calm delivery" },
];

/** Sync STT model (required header; pinned so a future default change on
 *  their side can't silently alter behavior). */
const SYNC_STT_MODEL = "universal-3-5-pro";

/**
 * Build a multipart/form-data body BY HAND, byte-exact.
 *
 * proxyFetch's IPC encoder cannot carry FormData: its fallback runs the body
 * through `new Response(body).text()`, which drops the multipart boundary
 * (generated inside the Response's Content-Type header, never forwarded)
 * and corrupts binary parts through a UTF-8 text round-trip. AssemblyAI
 * answered that with a 415. So the boundary is ours, the parts are ours,
 * and the outer Content-Type header is set explicitly by the caller.
 */
function buildMultipartAudio(
  boundary: string,
  audio: Uint8Array,
  filename: string,
  contentType: string,
): Uint8Array {
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="audio"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.length + audio.length + tail.length);
  out.set(head, 0);
  out.set(audio, head.length);
  out.set(tail, head.length + audio.length);
  return out;
}

/** File extension matching the recorder's MIME (cosmetic - the part's
 *  Content-Type is what the server reads). */
function extFromMime(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mp4")) return "m4a";
  return "webm";
}

async function requireKey(): Promise<string> {
  const key = await getKey("assemblyai");
  if (!key) {
    throw new Error(
      "AssemblyAI needs an API key (Settings > Models).",
    );
  }
  return key;
}

/**
 * Transcribe a recorded mic clip via the AssemblyAI Sync API.
 * `blob` is the MediaRecorder output (WebM/Opus typically). Returns the
 * transcript text (trimmed by the caller).
 */
export async function transcribeViaAssemblyAi(blob: Blob): Promise<string> {
  const key = await requireKey();
  const mime = blob.type || "audio/webm";
  const audio = new Uint8Array(await blob.arrayBuffer());
  const boundary = `kai-${crypto.randomUUID()}`;
  const body = buildMultipartAudio(
    boundary,
    audio,
    `clip.${extFromMime(mime)}`,
    mime,
  );
  const resp = await proxyFetch("https://sync.assemblyai.com/v1/transcribe", {
    method: "POST",
    headers: {
      Authorization: key,
      "X-AAI-Model": SYNC_STT_MODEL,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  if (!resp.ok) {
    let detail = "";
    try {
      const problem = (await resp.json()) as { title?: string; detail?: string };
      detail = [problem.title, problem.detail].filter(Boolean).join(": ");
    } catch {
      detail = (await resp.text().catch(() => "")).slice(0, 200);
    }
    throw new Error(
      `AssemblyAI STT failed (${resp.status}): ${detail || "unknown error"}`,
    );
  }
  const result = (await resp.json()) as { text?: string };
  return result.text ?? "";
}

/**
 * Synthesize speech via the AssemblyAI HTTP TTS API. Returns WAV bytes.
 * `voice` is an `aai-*` slug (default aai-jane when empty).
 */
export async function speakViaAssemblyAi(
  text: string,
  voice: string,
): Promise<ArrayBuffer> {
  const key = await requireKey();
  const resp = await proxyFetch("https://tts.us.assemblyai.com/v1/speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: key,
    },
    body: JSON.stringify({
      text: text.slice(0, 2000),
      voice_id: voice || "aai-jane",
      container: "wav",
    }),
  });
  if (!resp.ok) {
    let detail = "";
    try {
      const problem = (await resp.json()) as { title?: string; detail?: string };
      detail = [problem.title, problem.detail].filter(Boolean).join(": ");
    } catch {
      detail = (await resp.text().catch(() => "")).slice(0, 200);
    }
    throw new Error(
      `AssemblyAI TTS failed (${resp.status}): ${detail || "unknown error"}`,
    );
  }
  return await resp.arrayBuffer();
}
