import { invoke } from "@tauri-apps/api/core";
import type { ImageGenerateOpts, ImageResult } from "./types";

const ENDPOINT = "https://api.openai.com/v1/images/generations";
const MODEL = "gpt-image-2";

/** Quality values the GPT image models accept. Anything else is dropped
 *  rather than sent (an unknown enum value 400s the whole request). */
const QUALITY = new Set(["low", "medium", "high", "auto"]);

/** `WIDTHxHEIGHT` with both sides a positive integer. */
const SIZE_RE = /^\d{2,5}x\d{2,5}$/;

/** Generate an image via OpenAI GPT Image 2. */
export async function generateOpenAIImage(
  apiKey: string,
  opts: ImageGenerateOpts,
): Promise<ImageResult> {
  const size = SIZE_RE.test(opts.size ?? "") ? opts.size! : "1024x1024";
  const quality = QUALITY.has(opts.quality ?? "") ? opts.quality! : "auto";

  if (opts.signal?.aborted) throw new Error("Generation cancelled.");

  // GPT image models ALWAYS return base64 and REJECT `response_format` with
  // a 400 ("Unknown parameter: 'response_format'") — that parameter is
  // deprecated and only valid for the retired DALL-E models. Never send it.
  //
  // `size`/`quality` are forwarded because they are supported, but the
  // caller's free-text values are validated above first.
  const body = JSON.stringify({
    model: MODEL,
    prompt: opts.prompt,
    n: 1,
    size,
    quality,
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

  // The response reports the format/dimensions it actually produced; prefer
  // those over what we asked for (the API may adjust an unsupported size).
  const [rw, rh] = (json.size ?? size).split("x").map(Number);
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
    width: rw ?? 1024,
    height: rh ?? 1024,
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
