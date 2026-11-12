import { invoke } from "@tauri-apps/api/core";
import { sniffImageMime } from "./google-image";
import type { ImageGenerateOpts, ImageResult } from "./types";

const GENERATE_ENDPOINT = "https://api.openai.com/v1/images/generations";
const EDIT_ENDPOINT = "https://api.openai.com/v1/images/edits";
// gpt-image-2 is deprecated. Flare is the latest model intended for fast
// generation and editing; Sunburst remains the detail-first alternative.
const MODEL = "gpt-image-2.6-flare";

const QUALITY = new Set(["low", "medium", "high", "auto"]);

/** GPT Image accepts arbitrary resolutions only within these API limits. */
function validSize(size: string | undefined): size is string {
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(size ?? "");
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 && width % 16 === 0 && height % 16 === 0 &&
    width <= 3840 && height <= 2160 && width / height >= 1 / 3 && width / height <= 3;
}

/** Generate or edit an image via OpenAI GPT Image 2.6 Flare. */
export async function generateOpenAIImage(
  apiKey: string,
  opts: ImageGenerateOpts,
): Promise<ImageResult> {
  // Only send size when the user requested one; auto lets the model choose.
  const size = opts.size && validSize(opts.size) ? opts.size : undefined;
  const quality = QUALITY.has(opts.quality ?? "") ? opts.quality! : "auto";

  if (opts.signal?.aborted) throw new Error("Generation cancelled.");

  // GPT image models always return base64. Never send response_format: it is
  // a deprecated DALL-E parameter and GPT image endpoints reject it.
  const body = opts.referenceImage
    ? JSON.stringify({
        model: MODEL,
        prompt: opts.prompt,
        images: [{
          image_url: `data:${sniffImageMime(opts.referenceImage)};base64,${opts.referenceImage}`,
        }],
        n: 1,
        ...(size ? { size } : {}),
        quality,
      })
    : JSON.stringify({
        model: MODEL,
        prompt: opts.prompt,
        n: 1,
        ...(size ? { size } : {}),
        quality,
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
      `OpenAI image generation failed (${resp.status}): ${tryParseError(text)}`,
    );
  }

  const json = JSON.parse(text) as {
    data?: { b64_json?: string; url?: string }[];
    output_format?: string;
    size?: string;
  };
  const item = json.data?.[0];
  if (!item) throw new Error("OpenAI returned no image data");
  if (!item.b64_json && !item.url) {
    throw new Error("OpenAI returned an image entry with no data");
  }

  const [rw, rh] = (json.size ?? size ?? "0x0").split("x").map(Number);
  const mimeType =
    json.output_format === "jpeg"
      ? "image/jpeg"
      : json.output_format === "webp"
        ? "image/webp"
        : "image/png";

  return {
    base64: item.b64_json,
    url: item.url,
    mimeType,
    width: Number.isFinite(rw) ? rw! : 0,
    height: Number.isFinite(rh) ? rh! : 0,
    provider: "openai",
  };
}

function tryParseError(text: string): string {
  try {
    const j = JSON.parse(text) as {
      error?: { message?: string; code?: string; type?: string };
    };
    const msg = j.error?.message;
    if (msg) return j.error?.code ? `${msg} (${j.error.code})` : msg;
    return text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}
