import { invoke } from "@tauri-apps/api/core";
import type { VideoResult } from "./types";

const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 120;

// Veo 3.1 via the Gemini API long-running operations pattern:
//   POST /v1beta/models/veo-3.1-generate-preview:predictLongRunning
//        { instances: [{ prompt }], parameters: { aspectRatio, durationSeconds } }
//   →  { name } (operation)
//   GET  /v1beta/{name}  → { done, response.generateVideoResponse.generatedSamples[0].video.uri }
// The URI is then downloaded WITH the API key header (a bare GET 401s).
const MODEL = "veo-3.1-generate-preview";
const BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Generate a video via Google Veo 3.1 (Gemini API). */
export async function generateGoogleVideo(
  apiKey: string,
  opts: { prompt: string; duration?: number; aspectRatio?: string; signal?: AbortSignal },
): Promise<VideoResult> {
  if (opts.signal?.aborted) throw abortError();

  const submitResp = await httpPost(
    `${BASE}/models/${MODEL}:predictLongRunning?key=${encodeURIComponent(apiKey)}`,
    JSON.stringify({
      instances: [{ prompt: opts.prompt }],
      parameters: {
        aspectRatio: opts.aspectRatio ?? "16:9",
        durationSeconds: opts.duration ?? 8,
      },
    }),
  );
  const submitJson = JSON.parse(submitResp) as { name?: string; error?: { message?: string } };
  if (!submitJson.name) {
    throw new Error(`Veo submit failed: ${submitJson.error?.message ?? "no operation name"}`);
  }

  const opName = submitJson.name;
  for (let i = 0; i < MAX_POLLS; i++) {
    if (opts.signal?.aborted) throw abortError();
    await sleep(POLL_INTERVAL_MS);
    const pollResp = await httpGet(`${BASE}/${opName}?key=${encodeURIComponent(apiKey)}`);
    const pollJson = JSON.parse(pollResp) as {
      done?: boolean;
      response?: {
        generateVideoResponse?: {
          generatedSamples?: { video?: { uri?: string } }[];
        };
      };
      error?: { message?: string };
    };

    if (pollJson.error) {
      throw new Error(`Veo generation failed: ${pollJson.error.message}`);
    }

    if (pollJson.done) {
      const videoUri =
        pollJson.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!videoUri) throw new Error("Veo returned no video URI");
      // The URI needs the API key header to download — fetch the bytes here
      // so downstream consumers (chat UI, Telegram delivery) don't 401.
      const download = await httpGetBytes(videoUri, apiKey);
      return {
        url: videoUri,
        base64: download,
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

async function httpGet(url: string): Promise<string> {
  const resp = await invoke<{ status: number; body: number[] }>("ai_http_request", {
    url,
    method: "GET",
    headers: {},
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
    throw new Error(`Veo download failed (${resp.status}): ${text.slice(0, 200)}`);
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
