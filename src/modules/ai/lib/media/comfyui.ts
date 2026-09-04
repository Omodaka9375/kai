import { invoke } from "@tauri-apps/api/core";
import type { ImageResult, VideoResult } from "./types";

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 300; // 10 minutes

/**
 * Generate media via a local ComfyUI instance.
 *
 * The user provides a workflow JSON exported from ComfyUI. We inject the
 * prompt into the first text node we find (CLIPTextEncode or similar),
 * submit it to the ComfyUI API, poll for completion, and return the output.
 */

/** Inject prompt into a ComfyUI workflow JSON. */
export function injectPrompt(workflow: Record<string, unknown>, prompt: string): Record<string, unknown> {
  const api = workflow as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
  for (const node of Object.values(api)) {
    if (!node.class_type || !node.inputs) continue;
    // Common text-input nodes in ComfyUI
    if (
      node.class_type === "CLIPTextEncode" ||
      node.class_type === "CLIPTextEncodeSDXL" ||
      node.class_type === "StringLiteral" ||
      node.class_type === "Text Multiline"
    ) {
      if (typeof node.inputs.text === "string") {
        node.inputs.text = prompt;
        return workflow; // inject into the first one only
      }
    }
  }
  // Fallback: look for any node with a "prompt" or "text" string input
  for (const node of Object.values(api)) {
    if (!node.inputs) continue;
    if (typeof node.inputs.prompt === "string") {
      node.inputs.prompt = prompt;
      return workflow;
    }
    if (typeof node.inputs.text === "string") {
      node.inputs.text = prompt;
      return workflow;
    }
  }
  return workflow;
}

/** Input keys (case-insensitive) that represent a video's frame count. */
const FRAME_KEYS = new Set([
  "length",
  "frames",
  "num_frames",
  "frame_count",
  "total_frames",
  "frame_length",
  "num_video_frames",
]);

/** Input keys (case-insensitive) that represent a video's frame rate. */
const FPS_KEYS = new Set(["fps", "frame_rate", "frames_per_second"]);

const DEFAULT_FPS = 24;

/** Best-effort detection of the workflow's frame rate (defaults to 24). */
function detectFps(workflow: Record<string, unknown>): number {
  const api = workflow as Record<string, { inputs?: Record<string, unknown> }>;
  for (const node of Object.values(api)) {
    if (!node.inputs) continue;
    for (const [key, val] of Object.entries(node.inputs)) {
      if (!FPS_KEYS.has(key.toLowerCase())) continue;
      const n = typeof val === "number" ? val : Array.isArray(val) && typeof val[0] === "number" ? val[0] : NaN;
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return DEFAULT_FPS;
}

/**
 * Inject a duration (in seconds) into a ComfyUI video workflow where possible.
 *
 * ComfyUI video latent/sampler nodes take frames, not seconds, so we derive
 * `frames = duration * fps` (fps auto-detected, default 24) and write it into
 * any matching frame-count input. If a node exposes a plain `duration`/seconds
 * input, that is set directly. The workflow is mutated in place and returned.
 */
export function injectDuration(
  workflow: Record<string, unknown>,
  durationSeconds: number,
): Record<string, unknown> {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return workflow;
  const fps = detectFps(workflow);
  const frames = Math.max(1, Math.round(durationSeconds * fps));
  const api = workflow as Record<string, { inputs?: Record<string, unknown> }>;

  for (const node of Object.values(api)) {
    if (!node.inputs) continue;
    for (const key of Object.keys(node.inputs)) {
      const k = key.toLowerCase();
      const val = node.inputs[key];
      const isNumeric =
        typeof val === "number" || (Array.isArray(val) && typeof val[0] === "number");
      if (!isNumeric) continue;

      if (k === "duration" || k === "duration_seconds" || k === "seconds") {
        node.inputs[key] = durationSeconds;
      } else if (FRAME_KEYS.has(k)) {
        node.inputs[key] = Array.isArray(val) ? [frames] : frames;
      }
    }
  }
  return workflow;
}

/** Submit a workflow to ComfyUI and poll for the result. */
export async function runComfyWorkflow(
  baseUrl: string,
  workflow: Record<string, unknown>,
  prompt: string,
  opts: { duration?: number; signal?: AbortSignal } = {},
): Promise<{ images: string[]; videos: string[] }> {
  const injected = injectPrompt(structuredClone(workflow), prompt);
  if (opts.duration != null) injectDuration(injected, opts.duration);
  const clientId = `kai-${Date.now()}`;

  // Queue the prompt
  const queueBody = JSON.stringify({
    prompt: injected,
    client_id: clientId,
  });

  if (opts.signal?.aborted) throw abortError();
  const queueResp = await comfyPost(baseUrl, "/prompt", queueBody);
  const queueJson = JSON.parse(queueResp) as { prompt_id?: string; error?: string };
  if (!queueJson.prompt_id) {
    throw new Error(`ComfyUI queue failed: ${queueJson.error ?? "no prompt_id"}`);
  }

  const promptId = queueJson.prompt_id;

  // Poll history for completion
  for (let i = 0; i < MAX_POLLS; i++) {
    if (opts.signal?.aborted) throw abortError();
    await sleep(POLL_INTERVAL_MS);
    const historyResp = await comfyGet(baseUrl, `/history/${promptId}`);
    const history = JSON.parse(historyResp) as Record<
      string,
      { outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }> }
    >;

    const entry = history[promptId];
    if (!entry?.outputs) continue;

    const images: string[] = [];
    const videos: string[] = [];

    for (const output of Object.values(entry.outputs)) {
      if (!output.images) continue;
      for (const img of output.images) {
        const fileUrl = `${baseUrl}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder)}&type=${encodeURIComponent(img.type)}`;
        const ext = img.filename.split(".").pop()?.toLowerCase() ?? "";
        if (ext === "mp4" || ext === "webm" || ext === "mov") {
          videos.push(fileUrl);
        } else {
          images.push(fileUrl);
        }
      }
    }

    if (images.length > 0 || videos.length > 0) {
      return { images, videos };
    }
  }

  throw new Error("ComfyUI workflow timed out");
}

/** Generate an image via ComfyUI. */
export async function generateComfyImage(
  baseUrl: string,
  workflow: Record<string, unknown>,
  prompt: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ImageResult> {
  const result = await runComfyWorkflow(baseUrl, workflow, prompt, {
    signal: opts.signal,
  });
  const imageUrl = result.images[0];
  if (!imageUrl) throw new Error("ComfyUI returned no image output");

  // Fetch the image bytes and convert to base64
  if (opts.signal?.aborted) throw abortError();
  const resp = await invoke<{ status: number; body: number[] }>("ai_http_request", {
    url: imageUrl,
    method: "GET",
    headers: {},
    allowPrivateNetwork: true,
  });

  const bytes = new Uint8Array(resp.body);
  const base64 = btoa(String.fromCharCode(...bytes));

  return {
    base64,
    mimeType: "image/png",
    width: 1024,
    height: 1024,
    provider: "comfyui",
  };
}

/** Generate a video via ComfyUI. */
export async function generateComfyVideo(
  baseUrl: string,
  workflow: Record<string, unknown>,
  prompt: string,
  opts: { duration?: number; signal?: AbortSignal } = {},
): Promise<VideoResult> {
  const result = await runComfyWorkflow(baseUrl, workflow, prompt, {
    duration: opts.duration,
    signal: opts.signal,
  });
  const videoUrl = result.videos[0] ?? result.images[0];
  if (!videoUrl) throw new Error("ComfyUI returned no video output");

  return {
    url: videoUrl,
    mimeType: "video/mp4",
    durationSeconds: opts.duration ?? 5,
    provider: "comfyui",
  };
}

function abortError(): Error {
  return new Error("Generation cancelled.");
}

async function comfyPost(baseUrl: string, path: string, body: string): Promise<string> {
  const resp = await invoke<{ status: number; body: number[] }>("ai_http_request", {
    url: `${baseUrl}${path}`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: Array.from(new TextEncoder().encode(body)),
    allowPrivateNetwork: true,
  });
  return new TextDecoder().decode(new Uint8Array(resp.body));
}

async function comfyGet(baseUrl: string, path: string): Promise<string> {
  const resp = await invoke<{ status: number; body: number[] }>("ai_http_request", {
    url: `${baseUrl}${path}`,
    method: "GET",
    headers: {},
    allowPrivateNetwork: true,
  });
  return new TextDecoder().decode(new Uint8Array(resp.body));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
