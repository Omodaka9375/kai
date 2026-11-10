import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { ImageGenerateOpts, ImageResult } from "./types";

const imageDataSchema = z.object({
  mimeType: z.string().optional(),
  data: z.string().optional(),
});
const responseSchema = z.object({
  candidates: z.array(z.object({
    finishReason: z.string().optional(),
    content: z.object({
      parts: z.array(z.object({
        inlineData: imageDataSchema.optional(),
        inline_data: imageDataSchema.optional(),
        text: z.string().optional(),
      }).passthrough()).optional(),
    }).passthrough().optional(),
  }).passthrough()).optional(),
  promptFeedback: z.object({
    blockReason: z.string().optional(),
    blockReasonMessage: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

// Nano Banana 2 (Gemini 3.1 Flash Image). The 2024 `gemini-2.0-flash-exp`
// id was long dead; this is the current image-gen workhorse.
const MODEL = "gemini-3.1-flash-image";

/** Sniff image/jpeg|png|webp|gif from magic bytes (base64-decoded head).
 *  Gemini needs the true mimeType in inlineData; text/unknown gets the
 *  request rejected. PNG/JPEG/WebP/GIF are the formats it accepts. */
export function sniffImageMime(b64: string): string {
  let head: Uint8Array;
  try {
    const bin = atob(b64.slice(0, 32));
    head = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) head[i] = bin.charCodeAt(i);
  } catch {
    return "image/png";
  }
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e) return "image/png";
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return "image/gif";
  if (head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42) return "image/webp";
  return "image/png";
}

/** Generate an image via Google Gemini (Nano Banana 2). */
export async function generateGoogleImage(
  apiKey: string,
  opts: ImageGenerateOpts,
): Promise<ImageResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  if (opts.signal?.aborted) throw new Error("Generation cancelled.");

  // EDITING: Nano Banana 2 (Gemini image) is natively multimodal INPUT —
  // a reference image rides as an inlineData part ahead of the text
  // instruction ("put a red hat on this", multi-image composites, style
  // transfer). No separate /edits endpoint; same generateContent call.
  const reqParts: Record<string, unknown>[] = [];
  if (opts.referenceImage) {
    reqParts.push({
      inlineData: { mimeType: sniffImageMime(opts.referenceImage), data: opts.referenceImage },
    });
  }
  reqParts.push({ text: opts.prompt });

  const body = JSON.stringify({
    contents: [
      {
        parts: reqParts,
      },
    ],
    // Gemini image generation: ONLY responseModalities. responseMimeType
    // accepts text/JSON types (never image/*) — sending it 400s the request
    // ("allowed mimetypes are text/plain, application/json, ...").
    generationConfig: {
      responseModalities: ["IMAGE", "TEXT"],
    },
  });

  const resp = await invoke<{
    status: number;
    headers: Record<string, string>;
    body: number[];
  }>("ai_http_request", {
    url,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: Array.from(new TextEncoder().encode(body)),
  });

  const text = new TextDecoder().decode(new Uint8Array(resp.body));
  if (resp.status !== 200) {
    throw new Error(`Google image generation failed (${resp.status}): ${text.slice(0, 300)}`);
  }

  const parsed = responseSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error("Google returned an unexpected image response shape.");
  }
  const json = parsed.data;
  const parts = json.candidates?.flatMap((c) => c.content?.parts ?? []) ?? [];
  // The REST API uses camelCase, but some proxies return the protobuf's
  // original snake_case. Accept both instead of losing a valid image.
  const imagePart = parts.map((p) => p.inlineData ?? p.inline_data)
    .find((data) => data?.data);
  if (!imagePart?.data) {
    const reason = json.promptFeedback?.blockReasonMessage ??
      json.promptFeedback?.blockReason ??
      json.candidates?.map((c) => c.finishReason).filter(Boolean).join(", ");
    const textReply = parts.map((p) => p.text).filter(Boolean).join(" ");
    throw new Error(`Google returned no image data${reason ? `: ${reason}` : ""}${textReply ? ` (${textReply.slice(0, 240)})` : ""}`);
  }

  return {
    base64: imagePart.data,
    mimeType: imagePart.mimeType || "image/png",
    width: 1024,
    height: 1024,
    provider: "google",
  };
}
