import { invoke } from "@tauri-apps/api/core";
import type { ImageGenerateOpts, ImageResult } from "./types";

const ENDPOINT = "https://api.openai.com/v1/images/generations";
const MODEL = "gpt-image-2";

/** Generate an image via OpenAI GPT Image 2. */
export async function generateOpenAIImage(
  apiKey: string,
  opts: ImageGenerateOpts,
): Promise<ImageResult> {
  const size = opts.size ?? "1024x1024";
  const quality = opts.quality ?? "auto";

  const body = JSON.stringify({
    model: MODEL,
    prompt: opts.prompt,
    n: 1,
    size,
    quality,
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
    const err = tryParseError(text);
    throw new Error(`OpenAI image generation failed (${resp.status}): ${err}`);
  }

  const json = JSON.parse(text) as {
    data: { b64_json?: string; url?: string }[];
  };
  const item = json.data[0];
  if (!item) throw new Error("OpenAI returned no image data");

  const [w, h] = size.split("x").map(Number);

  return {
    base64: item.b64_json,
    url: item.url,
    mimeType: "image/png",
    width: w ?? 1024,
    height: h ?? 1024,
    provider: "openai",
  };
}

function tryParseError(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } };
    return j.error?.message ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}
