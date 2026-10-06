//! Text-only model handling for image attachments.
//!
//! The model catalog marks which models accept images via the `vision` tag.
//! Text-only models (DeepSeek-class, GLM base, etc.) reject `file` parts, so
//! before the request goes out the agent swaps image parts for extracted
//! text (dimensions + OCR when tesseract is available). The UI keeps the
//! image part untouched — the transcript still shows the thumbnail.

import { getModel } from "./config";
import { native } from "./lib/native";

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
 * catalog can't know its capabilities. Guess from the runtime model NAME
 * (vision families are recognizable: qwen2-vl, llava, minicpm-v, …) so a
 * locally-hosted vision model actually receives the image instead of being
 * silently OCR'd. Wrong guesses fall back to text-only — harmless, the
 * request still succeeds, the user just doesn't get image input.
 */
export function modelTextOnly(
  modelId: string,
  runtimeModelName?: string | null,
): boolean {
  const m = getModel(modelId as never);
  if (m.tags?.includes("vision")) return false;
  // Registry says text-only — but a custom endpoint's REAL model may differ.
  if (
    (m.id === "openai-compatible-custom" || m.id === "lmstudio-local") &&
    looksLikeVisionModel(runtimeModelName)
  ) {
    return false;
  }
  return true;
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
