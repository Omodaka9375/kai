import { invoke } from "@tauri-apps/api/core";
import type { ImageGenerateOpts, ImageResult } from "./types";

const ENDPOINT = "https://api.x.ai/v1/images/generations";
// Grok Imagine image 2.0 — the current generation model. The retired
// `grok-imagine-image-quality` id 404s on the endpoint.
const MODEL = "grok-imagine-image-2.0";

/** xAI's documented quality values. `high` is NOT one of them (the API
 *  accepts low/medium/auto and rejects anything else). */
const QUALITY = new Set(["low", "medium", "auto"]);

/** Map a `WIDTHxHEIGHT` request onto xAI's aspect_ratio enum. It sizes the
 *  output itself (1k/2k), so a pixel pair cannot be passed through. */
function aspectRatioFor(size: string | undefined): string | undefined {
  if (!size) return undefined;
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(size);
  if (!m) return undefined;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return undefined;
  const ratio = w / h;
  const table: [number, string][] = [
    [1, "1:1"],
    [16 / 9, "16:9"],
    [9 / 16, "9:16"],
    [4 / 3, "4:3"],
    [3 / 4, "3:4"],
    [3 / 2, "3:2"],
    [2 / 3, "2:3"],
    [21 / 9, "21:9"],
  ];
  let best: string | undefined;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const [value, label] of table) {
    const delta = Math.abs(value - ratio);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = label;
    }
  }
  // Anything further than ~15% off is not a representable ratio.
  return bestDelta / ratio < 0.15 ? best : undefined;
}

/** Generate an image via xAI Grok Imagine. */
export async function generateXAIImage(
  apiKey: string,
  opts: ImageGenerateOpts,
): Promise<ImageResult> {
  if (opts.signal?.aborted) throw new Error("Generation cancelled.");

  const quality = QUALITY.has(opts.quality ?? "") ? opts.quality : undefined;
  const aspectRatio = aspectRatioFor(opts.size);

  const body = JSON.stringify({
    model: MODEL,
    prompt: opts.prompt,
    n: 1,
    // No response_format: URLs are the default and b64_json is an opt-in
    // that some deployments reject. We accept either in the response.
    ...(quality ? { quality } : {}),
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
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
    throw new Error(
      `xAI image generation failed (${resp.status}): ${tryParseError(text)}`,
    );
  }

  const json = JSON.parse(text) as {
    data?: { b64_json?: string; url?: string; mime_type?: string }[];
  };
  const item = json.data?.[0];
  if (!item) throw new Error("xAI returned no image data");
  if (!item.b64_json && !item.url) {
    throw new Error("xAI returned an image entry with no data");
  }

  return {
    base64: item.b64_json,
    url: item.url,
    mimeType: item.mime_type ?? "image/jpeg",
    width: 1024,
    height: 1024,
    provider: "xai",
  };
}

function tryParseError(text: string): string {
  try {
    const j = JSON.parse(text) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof j.error === "string") return j.error;
    return j.error?.message ?? j.message ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}
