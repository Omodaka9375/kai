//! Text-only model handling for file/image attachments.
//!
//! The model catalog marks which models accept images/audio via tags.
//! DeepSeek-style text-only models reject `file` parts. When a text-only
//! model is selected, file parts are replaced with safe local extraction
//! (OCR from tesseract, metadata card); otherwise the file goes through.

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

/** Extract text from a blob: image attachment. Returns extracted text or null. */
export async function extractAttachmentText(
  attach: FileAttachment,
): Promise<string | null> {
  if (attach.kind !== "image" || !attach.url?.startsWith("blob:")) return null;
  const resp = await fetch(attach.url);
  const buf = await resp.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const tmp = `kai-att-${attach.id}.dat`;
  try {
    await native.writeFileBytes(tmp, [...bytes]);
    const r = await native.readFile(tmp);
    native.deleteFile(tmp).catch(() => {});
    if (r.kind !== "text") return null;
    return r.content;
  } catch (e) {
    console.warn("extractAttachmentText:", e);
    return null;
  }
}
