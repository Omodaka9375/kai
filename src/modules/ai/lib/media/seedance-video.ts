import { invoke } from "@tauri-apps/api/core";
import type { VideoResult } from "./types";

const BASE_URL = "https://api.seedance.ai/v1";
const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 120;

/** Generate a video via ByteDance Seedance 2.0. */
export async function generateSeedanceVideo(
  apiKey: string,
  opts: { prompt: string; duration?: number; aspectRatio?: string; referenceImage?: string },
): Promise<VideoResult> {
  const body: Record<string, unknown> = {
    model: "seedance-2",
    prompt: opts.prompt,
    duration: opts.duration ?? 5,
    aspect_ratio: opts.aspectRatio ?? "16:9",
  };

  if (opts.referenceImage) {
    body.first_frame_image = opts.referenceImage;
  }

  // Submit task
  const submitText = await httpPost(apiKey, "/generations", body);
  const submitJson = JSON.parse(submitText) as { id?: string; error?: { message?: string } };
  if (!submitJson.id) {
    throw new Error(`Seedance submit failed: ${submitJson.error?.message ?? "no task id"}`);
  }

  // Poll for completion
  const taskId = submitJson.id;
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const pollText = await httpGet(apiKey, `/generations/${taskId}`);
    const poll = JSON.parse(pollText) as {
      status?: string;
      output?: { video_url?: string };
      error?: { message?: string };
    };

    if (poll.status === "completed") {
      const videoUrl = poll.output?.video_url;
      if (!videoUrl) throw new Error("Seedance returned no video URL");
      return {
        url: videoUrl,
        mimeType: "video/mp4",
        durationSeconds: opts.duration ?? 5,
        provider: "seedance",
      };
    }

    if (poll.status === "failed") {
      throw new Error(`Seedance failed: ${poll.error?.message ?? "unknown"}`);
    }
  }

  throw new Error("Seedance video generation timed out");
}

async function httpPost(apiKey: string, path: string, body: Record<string, unknown>): Promise<string> {
  const resp = await invoke<{ status: number; body: number[] }>("ai_http_request", {
    url: `${BASE_URL}${path}`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: Array.from(new TextEncoder().encode(JSON.stringify(body))),
  });
  const text = new TextDecoder().decode(new Uint8Array(resp.body));
  if (resp.status !== 200 && resp.status !== 201) {
    throw new Error(`Seedance API error (${resp.status}): ${text.slice(0, 300)}`);
  }
  return text;
}

async function httpGet(apiKey: string, path: string): Promise<string> {
  const resp = await invoke<{ status: number; body: number[] }>("ai_http_request", {
    url: `${BASE_URL}${path}`,
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return new TextDecoder().decode(new Uint8Array(resp.body));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
