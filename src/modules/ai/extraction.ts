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

/** True when the model can't accept multimodal messages (no `vision` tag). */
export function modelTextOnly(modelId: string): boolean {
  const m = getModel(modelId as never);
  return !m.tags?.includes("vision");
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
