import { invoke } from "@tauri-apps/api/core";
import { sniffImageMime } from "./google-image";
import type { VideoResult } from "./types";

// Gemini Omni Flash via the Interactions API. The old path — the Veo 3.1
// preview model's long-running predict method — was shut down by Google on
// 2026-10-22 and every submit 404s with NOT_FOUND since. The replacement:
//   POST /v1beta/interactions
//        { model, input: [{type:"text",text} | {type:"image",data,mime_type}],
//          response_format: { type:"video", aspect_ratio, resolution,
//                              duration, delivery:"uri" },
//          store:false, background:false, stream:false }
//   → SYNCHRONOUS unary: the POST blocks until the render finishes (the
//     Rust proxy allows 600s) and returns
//     steps[].model_output.content[] = { type:"video", uri, mime_type }.
//     `delivery:"uri"` is mandatory for >4MB videos — inline base64
//     (`data`) hits a payload cap and Omni clips exceed it.
//   GET  /v1beta/files/{id}  → poll `state` until ACTIVE
//   GET  {uri} + x-goog-api-key header → the bytes (the URI 401s bare).
const MODEL = "gemini-omni-1.2-flash";
const BASE = "https://generativelanguage.googleapis.com/v1beta";

const FILE_POLL_INTERVAL_MS = 5000;
const MAX_FILE_POLLS = 60; // 5 min for the file to reach ACTIVE after render.

// Omni accepts whole seconds 3..15 ONLY (interpolation/extension cap at 10,
// but KAI's tool is plain text/image-to-video where 15 is allowed).
// Anything else 400s the submit.
function clampDuration(d: number | undefined): number {
  if (!Number.isFinite(d ?? NaN)) return 8;
  return Math.min(15, Math.max(3, Math.round(d as number)));
}

// Omni renders 16:9 (default) or 9:16 — nothing else. Normalize the usual
// synonyms and drop anything unknown to the default instead of letting
// the submit 400 on e.g. "1:1".
function normalizeAspect(a: string | undefined): "16:9" | "9:16" {
  const s = (a ?? "").trim().toLowerCase();
  if (s === "9:16" || s === "portrait" || s === "vertical") return "9:16";
  return "16:9";
}

/** One content part of an interaction step (only the fields we read). */
type VideoPart = {
  type?: string;
  mime_type?: string;
  /** Inline base64 (delivery:"data") — NOT requested, tolerated if present. */
  data?: string;
  /** Google-hosted download URL (delivery:"uri"). */
  uri?: string;
};

/** First video part in an interaction's steps, if any. */
function findVideoPart(json: unknown): VideoPart | undefined {
  const steps = (json as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return undefined;
  for (const step of steps) {
    const content = (step as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if ((part as VideoPart)?.type === "video") return part as VideoPart;
    }
  }
  return undefined;
}

/** File id from a files download URI (`.../v1beta/files/ID:download?alt=media`). */
function fileIdFromUri(uri: string): string | null {
  const m = /\/files\/([^:/?#]+)/.exec(uri);
  return m?.[1] ?? null;
}

/** Generate a video via Google Gemini Omni Flash (Interactions API).
 *  `referenceImage` (base64) = IMAGE-TO-VIDEO: Omni animates that exact
 *  image as the opening frame — an image input part ahead of the text —
 *  instead of synthesizing a start frame from text. The prompt then
 *  describes the MOTION ("pan left, rain begins"), not the whole scene. */
export async function generateGoogleVideo(
  apiKey: string,
  opts: { prompt: string; duration?: number; aspectRatio?: string; referenceImage?: string; signal?: AbortSignal },
): Promise<VideoResult> {
  if (opts.signal?.aborted) throw abortError();

  const duration = clampDuration(opts.duration);
  const image = opts.referenceImage;

  // Text-only → let the model infer text_to_video (unambiguous); with an
  // image, pin the task so the image is treated as the OPENING FRAME
  // (task adds strict constraints — exactly one image here, so safe).
  const generationConfig = image
    ? { video_config: { task: "image_to_video" } }
    : undefined;

  const createResp = await httpPost(
    `${BASE}/interactions`,
    JSON.stringify({
      model: MODEL,
      // Image part first (opening frame), text part second (motion).
      input: image
        ? [
            { type: "image", data: image, mime_type: sniffImageMime(image) },
            { type: "text", text: opts.prompt },
          ]
        : [{ type: "text", text: opts.prompt }],
      response_format: {
        type: "video",
        aspect_ratio: normalizeAspect(opts.aspectRatio),
        // 720p explicit: deterministic cost/latency, and URI delivery
        // avoids the 4MB inline-base64 cap for longer clips.
        resolution: "720p",
        duration: `${duration}s`,
        delivery: "uri",
      },
      generation_config: generationConfig,
      // Synchronous unary, nothing retained server-side (no multi-turn).
      background: false,
      store: false,
      stream: false,
    }),
    apiKey,
  );
  const created = JSON.parse(createResp) as {
    id?: string;
    status?: string;
    error?: { message?: string };
  };

  if (created.error) {
    throw new Error(`Video submit failed: ${created.error.message ?? "unknown error"}`);
  }
  if (created.status === "failed" || created.status === "cancelled") {
    throw new Error(`Video generation failed (status: ${created.status ?? "unknown"})`);
  }

  // Defensive: background=false should block until done, but if the POST
  // ever returns early (docs drift, proxy edge), poll the interaction
  // instead of failing on the first response. GET returns the video inline
  // or with its uri, so the same parser covers both.
  let video = findVideoPart(created);
  if (!video && created.id) {
    video = await pollInteraction(created.id, apiKey, opts.signal);
  }

  // Inline base64 fallback (delivery:"data" or a GET re-poll that ignores
  // the delivery choice) — bytes are already here, no download needed.
  if (video?.data) {
    return {
      url: video.uri ?? "",
      base64: video.data,
      mimeType: video.mime_type ?? "video/mp4",
      durationSeconds: duration,
      provider: "google",
    };
  }

  const uri = video?.uri;
  if (!uri) {
    throw new Error("Video generation returned no video (missing uri/data in the interaction)");
  }

  // URI delivery: the clip is a Files-API object that may still be
  // PROCESSING when the interaction completes. Wait for ACTIVE.
  const fileId = fileIdFromUri(uri);
  if (fileId) await pollFileActive(fileId, apiKey, opts.signal);

  // The download URI needs the API key header — fetch the bytes here so
  // downstream consumers (chat UI, Telegram delivery) don't 401.
  const download = await httpGetBytes(uri, apiKey);
  return {
    url: uri,
    base64: download,
    mimeType: video?.mime_type ?? "video/mp4",
    durationSeconds: duration,
    provider: "google",
  };
}

/** Fallback poll of an interaction that returned before completing. */
async function pollInteraction(id: string, apiKey: string, signal?: AbortSignal): Promise<VideoPart> {
  const MAX_POLLS = 120;
  for (let i = 0; i < MAX_POLLS; i++) {
    if (signal?.aborted) throw abortError();
    await sleep(FILE_POLL_INTERVAL_MS);
    const resp = await httpGet(`${BASE}/interactions/${encodeURIComponent(id)}`, apiKey);
    const json = JSON.parse(resp) as { status?: string; error?: { message?: string } };
    if (json.error) throw new Error(`Video generation failed: ${json.error.message}`);
    const part = findVideoPart(json);
    if (part && (part.data || part.uri)) return part;
    if (json.status === "failed" || json.status === "cancelled") {
      throw new Error(`Video generation failed (status: ${json.status})`);
    }
    if (json.status === "completed" && !part) {
      throw new Error("Video generation completed without a video part");
    }
  }
  throw new Error("Video generation timed out");
}

/** Wait until the Files-API object behind a delivery:"uri" is downloadable. */
async function pollFileActive(fileId: string, apiKey: string, signal?: AbortSignal): Promise<void> {
  for (let i = 0; i < MAX_FILE_POLLS; i++) {
    if (signal?.aborted) throw abortError();
    const resp = await httpGet(`${BASE}/files/${encodeURIComponent(fileId)}`, apiKey);
    const json = JSON.parse(resp) as {
      state?: string;
      error?: { message?: string };
      file?: { state?: string };
    };
    if (json.error) throw new Error(`Video file check failed: ${json.error.message}`);
    // v1beta returns the File resource directly; tolerate a wrapped form.
    const state = (json.state ?? json.file?.state ?? "").toUpperCase();
    if (state === "ACTIVE") return;
    if (state === "FAILED") throw new Error("Video file processing failed");
    await sleep(FILE_POLL_INTERVAL_MS);
  }
  // Not fatal: attempt the download anyway — a slow-processing file is
  // still worth one try before giving up on the whole render.
}

async function httpPost(url: string, body: string, apiKey: string): Promise<string> {
  const resp = await invoke<{ status: number; body: number[] }>("ai_http_request", {
    url,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: Array.from(new TextEncoder().encode(body)),
  });
  const text = new TextDecoder().decode(new Uint8Array(resp.body));
  if (resp.status !== 200) {
    throw new Error(`Google API error (${resp.status}): ${text.slice(0, 300)}`);
  }
  return text;
}

async function httpGet(url: string, apiKey: string): Promise<string> {
  const resp = await invoke<{ status: number; body: number[] }>("ai_http_request", {
    url,
    method: "GET",
    headers: { "x-goog-api-key": apiKey },
  });
  const text = new TextDecoder().decode(new Uint8Array(resp.body));
  if (resp.status !== 200) {
    throw new Error(`Google API error (${resp.status}): ${text.slice(0, 300)}`);
  }
  return text;
}

/** GET returning base64 (binary bodies must not round-trip through strings). */
async function httpGetBytes(url: string, apiKey: string): Promise<string> {
  const resp = await invoke<{ status: number; body: number[] }>("ai_http_request", {
    url,
    method: "GET",
    headers: { "x-goog-api-key": apiKey },
  });
  if (resp.status !== 200) {
    const text = new TextDecoder().decode(new Uint8Array(resp.body));
    throw new Error(`Video download failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  return bytesToBase64(new Uint8Array(resp.body));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError(): Error {
  return new Error("Generation cancelled.");
}
