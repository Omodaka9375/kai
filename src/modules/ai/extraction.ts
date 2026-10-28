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
  if (m.id === "openai-compatible-custom" || m.id === "lmstudio-local") {
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
async function cachedImageText(base64: string): Promise<string> {
  if (imageTextCache.has(base64)) {
    return imageTextCache.get(base64) ?? attachmentFallbackText("image");
  }
  const dataUrl = `data:image/png;base64,${base64}`;
  let text: string | null = null;
  try {
    text = await extractAttachmentText({ url: dataUrl, mediaType: "image/png" });
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
