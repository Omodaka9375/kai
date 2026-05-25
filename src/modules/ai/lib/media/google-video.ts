import { invoke } from "@tauri-apps/api/core";
import type { VideoResult } from "./types";

const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 120;

/** Generate a video via Google Veo 3.1. */
export async function generateGoogleVideo(
  apiKey: string,
  opts: { prompt: string; duration?: number; aspectRatio?: string },
): Promise<VideoResult> {
  // Submit generation request
  const submitUrl = `https://generativelanguage.googleapis.com/v1beta/models/veo-3.1:generateVideos?key=${apiKey}`;
  const body = JSON.stringify({
    prompt: { text: opts.prompt },
    config: {
      aspectRatio: opts.aspectRatio ?? "16:9",
      durationSeconds: opts.duration ?? 8,
    },
  });

  const submitResp = await httpPost(submitUrl, body);
  const submitJson = JSON.parse(submitResp) as { name?: string; error?: { message?: string } };
  if (!submitJson.name) {
    throw new Error(`Veo submit failed: ${submitJson.error?.message ?? "no operation name"}`);
  }

  // Poll operation
  const opName = submitJson.name;
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const pollUrl = `https://generativelanguage.googleapis.com/v1beta/${opName}?key=${apiKey}`;
    const pollResp = await httpGet(pollUrl, apiKey);
    const pollJson = JSON.parse(pollResp) as {
      done?: boolean;
      response?: {
        generatedVideos?: { video?: { uri?: string } }[];
      };
      error?: { message?: string };
    };

    if (pollJson.error) {
      throw new Error(`Veo generation failed: ${pollJson.error.message}`);
    }

    if (pollJson.done) {
      const videoUri = pollJson.response?.generatedVideos?.[0]?.video?.uri;
      if (!videoUri) throw new Error("Veo returned no video URI");
      return {
        url: videoUri,
        mimeType: "video/mp4",
        durationSeconds: opts.duration ?? 8,
        provider: "google",
      };
    }
  }

  throw new Error("Veo video generation timed out");
}

async function httpPost(url: string, body: string): Promise<string> {
  const resp = await invoke<{ status: number; body: number[] }>("ai_http_request", {
    url,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: Array.from(new TextEncoder().encode(body)),
  });
  const text = new TextDecoder().decode(new Uint8Array(resp.body));
  if (resp.status !== 200) {
    throw new Error(`Google API error (${resp.status}): ${text.slice(0, 300)}`);
  }
  return text;
}

async function httpGet(url: string, _apiKey: string): Promise<string> {
  const resp = await invoke<{ status: number; body: number[] }>("ai_http_request", {
    url,
    method: "GET",
    headers: {},
  });
  return new TextDecoder().decode(new Uint8Array(resp.body));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
