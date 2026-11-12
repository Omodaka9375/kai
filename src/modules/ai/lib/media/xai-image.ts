import { invoke } from "@tauri-apps/api/core";
import { imageDimensionsFromBase64 } from "./bytes";
import { sniffImageMime } from "./google-image";
import { aspectRatioForSize } from "./options";
import type { ImageGenerateOpts, ImageResult } from "./types";

const GENERATE_ENDPOINT = "https://api.x.ai/v1/images/generations";
const EDIT_ENDPOINT = "https://api.x.ai/v1/images/edits";
// Current Grok Imagine model; grok-imagine-image-quality retired 2026-11-02.
const MODEL = "grok-imagine-image-2.0";
const ASPECT_RATIOS = [
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2",
  "19.5:9", "9:19.5", "20:9", "9:20", "21:9", "5:2",
] as const;

/** Generate an image via xAI Grok Imagine Image 2.0. */
export async function generateXAIImage(
  apiKey: string,
  opts: ImageGenerateOpts,
): Promise<ImageResult> {
  if (opts.signal?.aborted) throw new Error("Generation cancelled.");

  const quality = opts.quality === "high" ? "medium" : opts.quality;
  const aspectRatio = aspectRatioForSize(opts.size, ASPECT_RATIOS);
  const body = JSON.stringify({
    model: MODEL,
    prompt: opts.prompt,
    n: 1,
    // Supported by current Grok Imagine. Inline bytes let KAI persist the
    // image before its temporary hosted URL expires, so edit/animate
    // follow-ups have a local path instead of an unusable link.
    response_format: "b64_json",
    ...(quality === "low" || quality === "medium" || quality === "auto" ? { quality } : {}),
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(opts.referenceImage
      ? {
          image: {
            type: "image_url",
            url: `data:${sniffImageMime(opts.referenceImage)};base64,${opts.referenceImage}`,
          },
        }
      : {}),
  });

  const resp = await invoke<{
    status: number;
    headers: Record<string, string>;
    body: number[];
  }>("ai_http_request", {
    url: opts.referenceImage ? EDIT_ENDPOINT : GENERATE_ENDPOINT,
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
    ...imageDimensionsFromBase64(item.b64_json),
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
