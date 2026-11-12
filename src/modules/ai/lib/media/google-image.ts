import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { imageDimensionsFromBase64 } from "./bytes";
import { aspectRatioForSize } from "./options";
import type { ImageGenerateOpts, ImageResult } from "./types";

const imageDataSchema = z.object({
  mimeType: z.string().optional(),
  mime_type: z.string().optional(),
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
const interactionResponseSchema = z.object({
  steps: z.array(z.object({
    type: z.string().optional(),
    content: z.array(z.object({
      type: z.string().optional(),
      mimeType: z.string().optional(),
      mime_type: z.string().optional(),
      data: z.string().optional(),
      text: z.string().optional(),
    }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough();

// Google's current high-efficiency image generation and editing model.
// gemini-3.1-flash-image is the previous generation; Google's image guide
// recommends this Nano Banana 2.1 successor for all new projects.
const MODEL = "gemini-nano-banana-2.1";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const ASPECT_RATIOS = [
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "5:2",
] as const;

/** Sniff image/jpeg|png|webp|gif from magic bytes (base64-decoded head).
 *  Gemini needs the true mime_type; text/unknown gets rejected. */
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

/** Generate or edit an image through Google's current Interactions API. */
export async function generateGoogleImage(
  apiKey: string,
  opts: ImageGenerateOpts,
): Promise<ImageResult> {
  if (opts.signal?.aborted) throw new Error("Generation cancelled.");

  const aspectRatio = aspectRatioForSize(opts.size, ASPECT_RATIOS);
  // Quality maps to the supported resolution enum. Do not silently discard
  // it, but do not invent an unsupported "high" tier either.
  const imageSize = opts.quality === "high" ? "2K" : "1K";
  const responseFormat = {
    type: "image",
    // The Interactions API only accepts image/jpeg here (400 invalid_request
    // for anything else); PNG output is not an option on this endpoint.
    mime_type: "image/jpeg",
    image_size: imageSize,
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
  };
  const body = JSON.stringify({
    model: MODEL,
    input: [
      ...(opts.referenceImage
        ? [{ type: "image", data: opts.referenceImage, mime_type: sniffImageMime(opts.referenceImage) }]
        : []),
      { type: "text", text: opts.prompt },
    ],
    response_format: responseFormat,
    // One-shot image generation/editing needs no server-side conversation
    // history. Unlike video URI delivery, image data needs no stored result.
    store: false,
    background: false,
    stream: false,
  });

  const resp = await invoke<{
    status: number;
    headers: Record<string, string>;
    body: number[];
  }>("ai_http_request", {
    url: ENDPOINT,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
      "Api-Revision": "2026-05-20",
    },
    body: Array.from(new TextEncoder().encode(body)),
  });

  const text = new TextDecoder().decode(new Uint8Array(resp.body));
  if (resp.status !== 200) {
    throw new Error(`Google image generation failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  const raw = JSON.parse(text) as unknown;
  const parsed = interactionResponseSchema.safeParse(raw);
  if (parsed.success) {
    const parts = (parsed.data.steps ?? []).flatMap((step) => step.content ?? []);
    const imagePart = parts.find((part) => part.type === "image" && part.data);
    if (imagePart?.data) {
      return imageResult(imagePart.data, imagePart.mimeType ?? imagePart.mime_type);
    }
  }

  // Compatibility with the previous generateContent response shape. This
  // also preserves useful parsing if a proxy returns the older resource.
  const legacy = responseSchema.safeParse(raw);
  if (!legacy.success) throw new Error("Google returned an unexpected image response shape.");
  const json = legacy.data;
  const parts = json.candidates?.flatMap((candidate) => candidate.content?.parts ?? []) ?? [];
  const imagePart = parts.map((part) => part.inlineData ?? part.inline_data)
    .find((data) => data?.data);
  if (!imagePart?.data) {
    const reason = json.promptFeedback?.blockReasonMessage ??
      json.promptFeedback?.blockReason ??
      json.candidates?.map((candidate) => candidate.finishReason).filter(Boolean).join(", ");
    const textReply = parts.map((part) => part.text).filter(Boolean).join(" ");
    throw new Error(`Google returned no image data${reason ? `: ${reason}` : ""}${textReply ? ` (${textReply.slice(0, 240)})` : ""}`);
  }
  return imageResult(imagePart.data, imagePart.mimeType ?? imagePart.mime_type);
}

function imageResult(base64: string, mimeType?: string): ImageResult {
  const dimensions = imageDimensionsFromBase64(base64);
  return {
    base64,
    mimeType: mimeType || "image/png",
    ...dimensions,
    provider: "google",
  };
}
