/**
 * CARD PASTE (Workspaces, 2026-11-19): the card inputs had NO paste
 * handling - screenshots pasted as nothing, walls of markdown flooded a
 * 48px textarea. This module gives the grid's CellInput + group input the
 * same semantics as the main AiInputBar, without the full composer:
 *
 * - text: same thresholds as shouldAttachPaste (exported from AiInputBar)
 *   -> long/structured pastes become a removable text chip instead of
 *   flooding the field
 * - images: pasted/clipboard image items are read as data URLs (with the
 *   same provider gate: downscale >1568px long edge, transcode exotic
 *   types to PNG) and render as a tiny thumbnail pill above the input;
 *   sending attaches them as inline image file parts (same wire shape the
 *   main composer uses, so vision + steering behave identically)
 */

import {
  downscaleOversizeImage,
  isProviderImageType,
  transcodeToProviderImage,
} from "../extraction";
import { shouldAttachPaste } from "../components/AiInputBar";
import { persistUploadedMedia } from "./media/persist";
import { native } from "./native";

/** A paste-pending attachment shown as a pill on a card input. */
export type CardAttachment = {
  id: string;
  /** Chip label: basename for files, "Pasted: …" for text. */
  name: string;
  kind: "image" | "text";
  mediaType: string;
  /** Image: full data URL. Text: the full pasted body. */
  payload: string;
};

/** Small chip label, like the composer's attachPastedText. */
export function cardChipName(text: string): string {
  const firstLine =
    text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "text";
  return firstLine.length > 24 ? `${firstLine.slice(0, 24)}...` : firstLine;
}

/** Wrapper so the two paste rules live beside each other (docs live on the main rule). */
export function shouldAttachCardPaste(text: string): boolean {
  return shouldAttachPaste(text);
}

/** Build the `Pasted: <chip>` label for a text paste (composer parity). */
export function cardPasteChip(text: string): CardAttachment {
  return {
    id: `paste-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    name: `Pasted: ${cardChipName(text)}`,
    kind: "text",
    mediaType: "text/plain",
    payload: text,
  };
}

async function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Extract image files from a paste event (clipboard items OR files). */
export function imageFilesFromClipboard(
  dt: DataTransfer | null,
): File[] {
  if (!dt) return [];
  const out: File[] = [];
  // Items first (screenshot tooling exposes image items).
  const items = dt.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  // Fallback: some sources only fill the files list.
  if (out.length === 0 && dt.files) {
    for (const f of Array.from(dt.files)) {
      if (f.type.startsWith("image/")) out.push(f);
    }
  }
  return out;
}

/**
 * One pasted image -> CardAttachment. Same provider gates as
 * composer.readAttachment: transcode exotic types to PNG, downscale the
 * oversized. Failure degrades to a text chip describing the failure (the
 * main composer's contract) instead of attaching poison.
 */
export async function cardImageAttachment(
  file: File,
): Promise<CardAttachment> {
  const id = `${file.name}-${file.size}-${file.lastModified}`;
  const rawUrl = await readAsDataURL(file);
  if (isProviderImageType(file.type)) {
    const downscaled = await downscaleOversizeImage(rawUrl);
    if (downscaled) {
      return {
        id,
        name: file.name || "image.png",
        kind: "image",
        mediaType: "image/jpeg",
        payload: downscaled,
      };
    }
    return {
      id,
      name: file.name || "image.png",
      kind: "image",
      mediaType: file.type,
      payload: rawUrl,
    };
  }
  const pngUrl = await transcodeToProviderImage(rawUrl);
  if (pngUrl) {
    return {
      id,
      name: file.name || "image.png",
      kind: "image",
      mediaType: "image/png",
      payload: pngUrl,
    };
  }
  return {
    id,
    name: file.name || "image",
    kind: "text",
    mediaType: "text/plain",
    payload: `[image attachment "${file.name}" (${file.type || "unknown type"}) could not be converted to a provider-safe format]`,
  };
}

/**
 * Persist one image attachment to ~/.kai/media/ and return the <attachment>
 * block for the composed message (main-composer parity: the model gets the
 * durable path for image-edit / media tools).
 */
export async function cardAttachmentPathBlock(
  att: CardAttachment,
): Promise<string | null> {
  if (att.kind !== "image") return null;
  const b64 = att.payload.split(",")[1] ?? "";
  try {
    const path = await persistUploadedMedia(native, {
      name: att.name,
      mimeType: att.mediaType,
      base64: b64,
    });
    if (!path) return null;
    return `<attachment name="${att.name}" savedAt="${path}">The attached image ${att.name} is also saved at the file path above — pass that path to tools that need a file.</attachment>`;
  } catch {
    return null;
  }
}

/** Group text chips into <file> blocks (composer parity). */
export function cardTextFileBlock(att: CardAttachment): string {
  return `<file name="${att.name}" mediaType="${att.mediaType}">\n${att.payload}\n</file>`;
}
