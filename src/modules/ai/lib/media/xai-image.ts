import { invoke } from "@tauri-apps/api/core";
import type { ImageGenerateOpts, ImageResult } from "./types";

const ENDPOINT = "https://api.x.ai/v1/images/generations";
const MODEL = "grok-imagine-image-quality";

/** Generate an image via xAI Grok Imagine. */
export async function generateXAIImage(
  apiKey: string,
  opts: ImageGenerateOpts,
): Promise<ImageResult> {
  const body = JSON.stringify({
    model: MODEL,
    prompt: opts.prompt,
    n: 1,
    response_format: "b64_json",
  });

  const resp = await invoke<{
    status: number;
    headers: Record<string, string>;
    body: number[];
  }>("ai_http_request", {
    url: ENDPOINT,
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: Array.from(new TextEncoder().encode(body)),
  });

  const text = new TextDecoder().decode(new Uint8Array(resp.body));
  if (resp.status !== 200) {
    throw new Error(`xAI image generation failed (${resp.status}): ${text.slice(0, 300)}`);
  }

  const json = JSON.parse(text) as {
    data: { b64_json?: string; url?: string }[];
  };
  const item = json.data[0];
  if (!item) throw new Error("xAI returned no image data");

  return {
    base64: item.b64_json,
    url: item.url,
    mimeType: "image/jpeg",
    width: 1024,
    height: 1024,
    provider: "xai",
  };
}
