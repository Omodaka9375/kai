import { invoke } from "@tauri-apps/api/core";
import type { VideoResult } from "./types";

const BASE_URL = "https://api.klingai.com/v1";
const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 120; // 10 minutes max

type KlingTaskResponse = {
  code: number;
  data?: {
    task_id: string;
    task_status: string;
    task_result?: {
      videos?: { url: string; duration: string }[];
    };
  };
  message?: string;
};

/** Generate a video via Kling 3.0 API. */
export async function generateKlingVideo(
  apiKey: string,
  opts: { prompt: string; duration?: number; aspectRatio?: string; referenceImage?: string },
): Promise<VideoResult> {
  const body: Record<string, unknown> = {
    model_name: "kling-v3",
    prompt: opts.prompt,
    duration: String(opts.duration ?? 5),
    aspect_ratio: opts.aspectRatio ?? "16:9",
    mode: "standard",
  };

  if (opts.referenceImage) {
    body.image = opts.referenceImage;
  }

  // Submit task
  const submitResp = await klingRequest(apiKey, "POST", "/videos/text2video", body);
  const taskId = submitResp.data?.task_id;
  if (!taskId) {
    throw new Error(`Kling submit failed: ${submitResp.message ?? "no task_id"}`);
  }

  // Poll for completion
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const status = await klingRequest(apiKey, "GET", `/videos/text2video/${taskId}`);
    const taskStatus = status.data?.task_status;

    if (taskStatus === "succeed") {
      const video = status.data?.task_result?.videos?.[0];
      if (!video) throw new Error("Kling returned no video");
      return {
        url: video.url,
        mimeType: "video/mp4",
        durationSeconds: parseFloat(video.duration) || opts.duration || 5,
        provider: "kling",
      };
    }

    if (taskStatus === "failed") {
      throw new Error(`Kling video generation failed: ${status.message ?? "unknown error"}`);
    }
    // "submitted" | "processing" → keep polling
  }

  throw new Error("Kling video generation timed out");
}

async function klingRequest(
  apiKey: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<KlingTaskResponse> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const resp = await invoke<{
    status: number;
    headers: Record<string, string>;
    body: number[];
  }>("ai_http_request", {
    url,
    method,
    headers,
    body: body ? Array.from(new TextEncoder().encode(JSON.stringify(body))) : undefined,
  });

  const text = new TextDecoder().decode(new Uint8Array(resp.body));
  if (resp.status !== 200) {
    throw new Error(`Kling API error (${resp.status}): ${text.slice(0, 300)}`);
  }

  return JSON.parse(text) as KlingTaskResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
