//! Text-only model handling for image attachments.
//!
//! The model catalog marks which models accept images via the `vision` tag.
//! Text-only models (DeepSeek-class, GLM base, etc.) reject `file` parts, so
//! before the request goes out the agent swaps image parts for extracted
//! text (dimensions + OCR when tesseract is available). The UI keeps the
//! image part untouched — the transcript still shows the thumbnail.

import { getModel, type VisionOverride } from "./config";
import { native } from "./lib/native";
import type { ModelMessage } from "ai";

export type FileAttachment = {
  id: string;
  name: string;
  kind: "image" | "text" | "selection";
  mediaType: string;
  url?: string;
  text?: string;
  size: number;
};

/**
 * True when the model can't accept multimodal messages (no `vision` tag).
 *
 * For cloud models the registry knows the answer. For custom endpoints
 * (LM Studio / OpenAI-compatible) the REGISTRY entry is a placeholder — the
 * real model is user-supplied at runtime (`lmstudioModelId` etc.), so the
 * catalog can't know its capabilities. Resolution order:
 *   1. A user-set override (`lmstudioVision` / `openaiCompatibleVision`
 *      prefs, "on"/"off") wins — for models whose name gives no hint.
 *   2. Otherwise ("auto") guess from the runtime model NAME (vision
 *      families are recognizable: qwen2-vl, llava, minicpm-v, …) so a
 *      locally-hosted vision model actually receives the image instead of
 *      being silently OCR'd.
 */
export function modelTextOnly(
  modelId: string,
  runtimeModelName?: string | null,
  visionOverride?: VisionOverride | null,
): boolean {
  const m = getModel(modelId as never);
  if (m.tags?.includes("vision")) return false;
  if (m.id === "openai-compatible-custom") {
    // Explicit user override beats both the registry and the name guess.
    if (visionOverride === "on") return false;
    if (visionOverride === "off") return true;
    return !looksLikeVisionModel(runtimeModelName);
  }
  return true;
}

/**
 * Positive framing of {@link modelTextOnly}: can this model receive actual
 * image content? Use this at capability sites (what to tell the model it can
 * do); keep using modelTextOnly at the swap site in agent.ts (what to strip
 * from the request).
 *
 * NOT the same question as `supportsToolResultImages` (chatRuntime.ts): that
 * one asks whether the PROVIDER WIRE can serialize image parts inside a tool
 * result — openai-compatible-family endpoints stringify them, so even a
 * vision model on those endpoints gets OCR text from look_at_screen. A model
 * can pass this check and fail that one; a predicate that merged them would
 * either lie to the model or strip images a capable wire could deliver.
 */
export function modelCanSee(
  modelId: string,
  runtimeModelName?: string | null,
  visionOverride?: VisionOverride | null,
): boolean {
  return !modelTextOnly(modelId, runtimeModelName, visionOverride);
}

/** Heuristic: does the runtime model name look like a vision-capable family?
 *  Deliberately permissive — false positives (claiming vision on a text model)
 *  only surface as a provider error on that one request; false negatives
 *  silently downgrade the user's image to OCR text. Covers the common local
 *  GGUF vision families (LM Studio / Ollama / vLLM names). */
export function looksLikeVisionModel(name?: string | null): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  // "vl" as a token (qwen2-vl-7b, internvl2, smolvlm-instruct) — not a
  // mid-word accident ("evolved" has no vl boundary).
  if (/(^|[^a-z])vl([^a-z]|$)/.test(n)) return true;
  const families = [
    "vision",
    "llava",
    "moondream",
    "minicpm-v",
    "cogvlm",
    "cogagent",
    "idefics",
    "paligemma",
    "florence",
    "pixtral",
    "internvl",
  ];
  return families.some((f) => n.includes(f));
}

const DATA_URL_RE = /^data:([^;]+);base64,(.*)$/s;

/** Extract text from an image attachment's data-URL (dimensions + OCR).
 *  Returns null when it isn't an image or extraction yields nothing. */
export async function extractAttachmentText(
  attach: Pick<FileAttachment, "url" | "mediaType">,
): Promise<string | null> {
  if (!attach.url) return null;
  const m = DATA_URL_RE.exec(attach.url);
  if (!m) return null; // not an inline image (e.g. stripped after reload)
  const bytes = base64ToBytes(m[2]);
  if (bytes.length === 0) return null;
  try {
    const meta = await native.extractImageBytes(bytes);
    if (!meta) return null;
    const text = meta.content.trim();
    if (!text) return null;
    return `[image attachment — ${meta.format}, ${formatBytes(meta.size)}${metaText(meta.meta)}]\n${text}`;
  } catch (e) {
    console.warn("extractAttachmentText:", e);
    return null;
  }
}

/** Fallback text when extraction produced nothing — tells the model the
 *  user attached an image without inventing content. */
export function attachmentFallbackText(name: string): string {
  return `[attachment "${name}" — image could not be extracted to text; the selected model has no vision support]`;
}

// ── Image → text swap for non-vision models (shared: desktop + assistant) ──
//
// A single implementation used by BOTH callers so the two never drift. It
// accepts either shape a converted ModelMessage can carry an image in: the
// desktop path's `{type:"file", mediaType:"image/…", data}` and the assistant
// path's `{type:"image", image}`. Extraction runs once per payload (cached by
// the base64 body) because agent steps / history replay re-convert every turn.
//
// Extraction is best-effort and NEVER throws: with no OCR engine the primitive
// still yields format/size/dimensions, and a total failure falls back to
// attachmentFallbackText — so a text-only model degrades to "there was an
// image," never a hard request error.

const imageTextCache = new Map<string, string | null>();

type SwapPart = {
  type: string;
  mediaType?: unknown;
  data?: unknown;
  image?: unknown;
  [k: string]: unknown;
};

/** Base64 payload of an image part, or null when this part is not an image
 *  with an inline (string) payload (e.g. a URL reference — left untouched). */
function inlineImageBase64(part: SwapPart): string | null {
  if (part.type === "image") {
    return typeof part.image === "string" && part.image.length > 0
      ? part.image
      : null;
  }
  if (
    part.type === "file" &&
    typeof part.mediaType === "string" &&
    part.mediaType.startsWith("image/") &&
    typeof part.data === "string" &&
    part.data.length > 0
  ) {
    return part.data;
  }
  return null;
}

/** True when any message carries an inline image part (so a failed request is
 *  worth an OCR retry). */
export function hasInlineImageParts(messages: ModelMessage[]): boolean {
  return messages.some((m) => {
    if (!Array.isArray(m.content)) return false;
    return (m.content as SwapPart[]).some((p) => inlineImageBase64(p) != null);
  });
}

/** How many inline image parts a model-bound history carries. Used to journal
 *  the vision→OCR swap (event: how many images the model did NOT actually
 *  see as pixels). Mirrors hasInlineImageParts' probe exactly. */
export function countInlineImageParts(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as SwapPart[]) {
      if (inlineImageBase64(p) != null) n++;
    }
  }
  return n;
}

/** Replace every inline image part with its extracted text. Messages with no
 *  image parts are returned by identity (no needless clones). */
export async function swapImagePartsToText(
  messages: ModelMessage[],
): Promise<ModelMessage[]> {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const parts = m.content as SwapPart[];
    if (!parts.some((p) => inlineImageBase64(p) != null)) {
      out.push(m);
      continue;
    }
    const content: SwapPart[] = [];
    for (const part of parts) {
      const b64 = inlineImageBase64(part);
      if (b64 != null) content.push({ type: "text", text: await cachedImageText(b64) });
      else content.push(part);
    }
    out.push({ ...m, content } as ModelMessage);
  }
  return out;
}

/** Cached extraction for one base64 image payload. */
/** Real format from the base64 head instead of a hardcoded png (2026-11-04
 *  assistant-trace review): the assistant photo pipeline is JPEG end to end
 *  (Telegram downloads + downscalePhotoJpeg), and the extraction request's
 *  data-URL should not mislabel it. Magic heads: PNG is 0x89 50 4E 47
 *  ("iVBOR"), JPEG is FF D8 FF ("/9j/"); anything else keeps the png default -
 *  extract.rs sniffs the real magic for the temp-file extension regardless,
 *  so this is labeling, not parsing. */
export function sniffImageMime(base64: string): string {
  const head = base64.slice(0, 4);
  if (head.startsWith("iVBOR")) return "image/png";
  if (head.startsWith("/9j/")) return "image/jpeg";
  return "image/png";
}

/**
 * Media types every vision-capable provider accepts for base64 image parts
 * (Anthropic: png/jpeg/webp/gif ONLY - anything else 400s the whole request;
 * OpenAI/Google accept the same set). This is the allowlist gate for the
 * model-bound path: an unsupported type (avif, heic, bmp, tiff, ...) must
 * never reach a provider, because the part PERSISTS into the session
 * history and one such attachment bricks every later request on replay
 * (2026-11-06 report: an AVIF upload via the + button broke the whole
 * conversation; re-uploading a good file did not help because the poison
 * part kept replaying).
 */
export const PROVIDER_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

// ── Generated-media summarization for the model-bound history ──────────────
//
// 2026-11-12 report: "generate an image, then a video FROM the image" blew
// the context window (712k tokens over a 262k limit). The resolved
// generate_image/generate_video tool result carries the FULL base64 payload
// (megabytes), `convertToModelMessages` serializes it into the tool-result
// text, and it re-rides EVERY later request of the session. The model never
// needs the pixels — it needs to know the generation SUCCEEDED and where
// the file lives (savedPath powers the edit/animate follow-ups).
//
// The UI transcript keeps the full payload (MediaMessage renders from it);
// only the MODEL-bound copy is summarized. Runs before compaction so the
// compact pass sees small strings, not base64 monsters it cannot fit.

/**
 * Replace generated-media payloads in tool-result parts with a short
 * summary. A result matches when it looks like a media tool output
 * (`type: "image" | "video"` with base64/bytes). Non-matching parts and
 * messages pass through by identity.
 */
export function summarizeMediaOutputs(messages: ModelMessage[]): ModelMessage[] {
  let touched = false;
  const out = messages.map((m): ModelMessage => {
    if (!Array.isArray(m.content)) return m;
    let msgTouched = false;
    const content = (m.content as Record<string, unknown>[]).map((part) => {
      if (part.type !== "tool-result") return part;
      const output = part.output;
      if (!isMediaResultShape(output)) return part;
      msgTouched = true;
      return { ...part, output: mediaSummary(output) };
    });
    if (!msgTouched) return m;
    touched = true;
    return { ...m, content } as ModelMessage;
  });
  return touched ? out : messages;
}

type MediaResultShape = {
  type: "image" | "video";
  provider?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  savedPath?: string;
  url?: string;
  error?: string;
  prompt?: string;
  count?: number;
  [k: string]: unknown;
};

/** Recognize a resolved generate_image/generate_video tool output. */
export function isMediaResultShape(v: unknown): v is MediaResultShape {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    (o.type === "image" || o.type === "video") &&
    (typeof o.base64 === "string" || typeof o.url === "string")
  );
}

/** Short stand-in for a resolved media payload, referenced by path. */
function mediaSummary(o: MediaResultShape): Record<string, unknown> {
  const bits: string[] = [];
  bits.push(o.type === "video" ? "video" : "image");
  if (o.width && o.height) bits.push(`${o.width}x${o.height}`);
  if (typeof o.durationSeconds === "number" && o.durationSeconds > 0) {
    bits.push(`${o.durationSeconds}s`);
  }
  if (o.provider) bits.push(`provider: ${o.provider}`);
  const summary: Record<string, unknown> = {
    type: o.type,
    summary: `generated ${bits.join(", ")}`,
    savedPath: o.savedPath,
  };
  if (o.savedPath) {
    summary.note =
      o.type === "image"
        ? "The image is saved at savedPath. Pass that path to generate_image (imagePath) to EDIT it or generate_video (imagePath) to ANIMATE it."
        : "The video is saved at savedPath.";
  } else {
    // No path (persist failed): the file exists ONLY in the chat card — the
    // model must not claim it can read or re-use it.
    summary.note = "The media is displayed in the chat card only (not saved to disk).";
  }
  return summary;
}

/** True when a media type is a provider-safe IMAGE payload. */
export function isProviderImageType(mediaType: string | null | undefined): boolean {
  if (!mediaType) return false;
  return PROVIDER_IMAGE_TYPES.has(mediaType);
}

/**
 * Decode ANY image the browser can read and re-encode as a provider-safe
 * PNG/JPEG data-URL. This is the ATTACH-INTIME transcode for exotic image
 * formats (avif/heic/bmp/tiff...): the browser's codec does the conversion,
 * so a 1x1 AVIF never reaches a provider to 400 the request. Never throws:
 * a transcode failure returns null and the caller falls back to the text
 * ("could not be displayed as an image") path instead of attaching poison.
 *
 * Downscale cap: providers token-count the long edge (~1568px for Claude);
 * a 12MP phone AVIF would become an enormous PNG. Cap at 1568 before the
 * encode, mirroring the assistant's photo pipeline.
 */
export async function transcodeToProviderImage(
  dataUrl: string,
  maxLongEdge = 1568,
  encode: "image/png" | "image/jpeg" = "image/png",
  quality = 0.92,
): Promise<string | null> {
  try {
    if (typeof createImageBitmap !== "function") return null;
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    try {
      const long = Math.max(bmp.width, bmp.height);
      const scale = long > maxLongEdge ? maxLongEdge / long : 1;
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = new OffscreenCanvas(w, h);
      const g = canvas.getContext("2d");
      if (!g) return null;
      // JPEG has no alpha channel: flatten onto white so a transparent PNG
      // re-encoded as JPEG doesn't come out with a black background.
      if (encode === "image/jpeg") {
        g.fillStyle = "#ffffff";
        g.fillRect(0, 0, w, h);
      }
      g.drawImage(bmp, 0, 0, w, h);
      const out = await canvas.convertToBlob({ type: encode, quality });
      const buf = new Uint8Array(await out.arrayBuffer());
      let binary = "";
      for (let i = 0; i < buf.length; i += 8192) {
        binary += String.fromCharCode(...buf.subarray(i, i + 8192));
      }
      return `data:${encode};base64,${btoa(binary)}`;
    } finally {
      bmp.close?.();
    }
  } catch {
    return null;
  }
}

/**
 * SIZE GATE for already-provider-safe image attachments (2026-11-09 report:
 * "when the agent works with images the context fills quickly"). Provider-safe
 * formats (png/jpeg/webp/gif) used to ride in RAW - a 4K screenshot is 10+
 * MB of base64 that PERSISTS in the session history and re-sends on EVERY
 * request of the conversation. Providers token-count images by tiles over the
 * long edge (~1568px for Claude), so pixels past that are pure payload with
 * no fidelity the model could read anyway.
 *
 * Returns a downscaled JPEG data-URL when the long edge exceeds the cap, and
 * null when the image is ALREADY small (caller keeps the exact original bytes
 * - no re-encode, no quality loss) or cannot be measured (no codec, decode
 * failure) - best-effort, never throws.
 */
export async function downscaleOversizeImage(
  dataUrl: string,
  maxLongEdge = 1568,
): Promise<string | null> {
  try {
    if (typeof createImageBitmap !== "function") return null;
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    let long: number;
    try {
      long = Math.max(bmp.width, bmp.height);
    } finally {
      bmp.close?.();
    }
    if (long <= maxLongEdge) return null;
    return transcodeToProviderImage(dataUrl, maxLongEdge, "image/jpeg", 0.92);
  } catch {
    return null;
  }
}

async function cachedImageText(base64: string): Promise<string> {
  if (imageTextCache.has(base64)) {
    return imageTextCache.get(base64) ?? attachmentFallbackText("image");
  }
  const mime = sniffImageMime(base64);
  const dataUrl = `data:${mime};base64,${base64}`;
  let text: string | null = null;
  try {
    text = await extractAttachmentText({ url: dataUrl, mediaType: mime });
  } catch (e) {
    console.warn("[kai] image extraction failed:", e);
  }
  const finalText = text ?? attachmentFallbackText("image");
  // Bound the cache: payloads are large; a session rarely exceeds a handful.
  if (imageTextCache.size >= 16) {
    const first = imageTextCache.keys().next().value;
    if (first !== undefined) imageTextCache.delete(first);
  }
  imageTextCache.set(base64, text);
  return finalText;
}

function metaText(meta: [string, string][]): string {
  const dims = meta
    .filter(([k]) => k === "width" || k === "height")
    .map(([, v]) => v)
    .join("x");
  return dims ? `, ${dims}px` : "";
}

function base64ToBytes(b64: string): Uint8Array {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
