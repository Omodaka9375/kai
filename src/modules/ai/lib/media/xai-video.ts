import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { bytesToBase64 } from "./bytes";
import { sniffImageMime } from "./google-image";
import type { VideoGenerateOpts, VideoResult } from "./types";

const BASE = "https://api.x.ai/v1/videos";
// xAI recommends Lite for straightforward text/image-to-video generation.
// The full 1.5 model is for references, voices, pinned frames, or native 1080p.
const MODEL = "grok-imagine-video-1.5-lite";
const ASPECT_RATIOS = new Set([
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "5:2",
]);
const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 180; // 15 minutes, matching xAI's documented maximum.

const createResponseSchema = z.object({ request_id: z.string().min(1) });
const pollResponseSchema = z.object({
  status: z.string(),
  video: z.object({
    url: z.string().url().optional(),
    duration: z.number().optional(),
  }).optional(),
  error: z.object({ message: z.string().optional() }).optional(),
}).passthrough();

/** Generate a video through xAI's current asynchronous Imagine Video API. */
export async function generateXAIVideo(
  apiKey: string,
  opts: VideoGenerateOpts,
): Promise<VideoResult> {
  if (opts.signal?.aborted) throw new Error("Generation cancelled.");
  const requested = Number.isFinite(opts.duration ?? NaN) ? Math.round(opts.duration!) : 8;
  const duration = Math.min(15, Math.max(1, requested));
  const aspectRatio = ASPECT_RATIOS.has(opts.aspectRatio ?? "") ? opts.aspectRatio : "16:9";
  const created = await request("POST", `${BASE}/generations`, apiKey, {
    model: MODEL,
    prompt: opts.prompt,
    duration,
    // xAI ignores aspect_ratio for image-to-video and matches the still.
    ...(opts.referenceImage ? {} : { aspect_ratio: aspectRatio }),
    resolution: "720p",
    ...(opts.referenceImage
      ? { image: { url: `data:${sniffImageMime(opts.referenceImage)};base64,${opts.referenceImage}` } }
      : {}),
  });
  const requestId = createResponseSchema.parse(created).request_id;

  for (let i = 0; i < MAX_POLLS; i++) {
    if (opts.signal?.aborted) throw new Error("Generation cancelled.");
    if (i > 0) await sleep(POLL_INTERVAL_MS);
    const result = pollResponseSchema.parse(
      await request("GET", `${BASE}/${encodeURIComponent(requestId)}`, apiKey),
    );
    if (result.status === "failed" || result.status === "expired") {
      throw new Error(`xAI video generation ${result.status}: ${result.error?.message ?? "unknown error"}`);
    }
    if (result.status !== "done") continue;
    if (!result.video?.url) throw new Error("xAI returned a completed video with no URL");
    // Temporary hosted URL: fetch it now so KAI can persist and play it
    // without relying on an expiring provider URL.
    const download = await invoke<{ status: number; body: number[] }>("ai_http_request", {
      url: result.video.url,
      method: "GET",
      headers: {},
    });
    if (download.status !== 200) {
      const text = new TextDecoder().decode(new Uint8Array(download.body));
      throw new Error(`xAI video download failed (${download.status}): ${text.slice(0, 200)}`);
    }
    return {
      url: result.video.url,
      base64: bytesToBase64(new Uint8Array(download.body)),
      mimeType: "video/mp4",
      durationSeconds: result.video.duration ?? duration,
      provider: "xai",
    };
  }
  throw new Error("xAI video generation timed out");
}

async function request(
  method: "GET" | "POST",
  url: string,
  apiKey: string,
  payload?: unknown,
): Promise<unknown> {
  const resp = await invoke<{ status: number; body: number[] }>("ai_http_request", {
    url,
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    ...(payload ? { body: Array.from(new TextEncoder().encode(JSON.stringify(payload))) } : {}),
  });
  const text = new TextDecoder().decode(new Uint8Array(resp.body));
  if (resp.status !== 200) {
    throw new Error(`xAI video API error (${resp.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
