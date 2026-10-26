/**
 * Photo-intake hygiene for the Telegram assistant (see index.ts).
 *
 * The problem this solves: the assistant persists its whole chat history as
 * JSON in the prefs store, and photo turns used to carry the full inline
 * base64 — every phone picture added megabytes to the store AND to every
 * later model request (each turn re-sends the whole history).
 *
 * The design, per vendor guidance + internal precedent:
 *  - ANTHROPIC VISION DOCS: "each request resends the full conversation
 *    history. If images are base64-encoded, the full image bytes are
 *    included in the payload on every turn" — the recommended shape is
 *    store-once + reference (their Files API `file_id`). Our local analog:
 *    the scratch dir (~/.kai/assistant/photo-*.jpg) + `sourcePath` on the
 *    file part — exactly how the assistant already persists DOCUMENTS and
 *    VIDEOS (they save bytes, history keeps the path).
 *  - RESIZE BEFORE SENDING: Claude standard tier downscales images larger
 *    than 1568px long edge server-side anyway (and caps visual tokens at
 *    ~1568), so pixels beyond that are pure payload cost with zero model
 *    benefit. We downscale to the same ceiling once, client-side.
 *  - THE WINDOW: vision survives history reload — the most recent
 *    PHOTO_CONTEXT_WINDOW persisted photos are rehydrated from disk into
 *    the model context; older ones drop out gracefully (empty payload =
 *    no image part, the text of that turn remains).
 */
import { invoke } from "@tauri-apps/api/core";
import type { UIMessage } from "ai";

/** Claude standard-tier native long-edge limit (docs, "Resolution and token
 *  cost"): larger images are downscaled by the API regardless. */
export const PHOTO_MAX_LONG_EDGE = 1568;
/** Single lossy pass at moderate quality — heavy compression hurts text
 *  legibility in photos (same docs page, "Image quality guidance"). */
export const PHOTO_JPEG_QUALITY = 0.85;
/** How many persisted (already-answered) photos stay rehydratable into
 *  model context. Recent follow-ups keep working; the store/payload stays
 *  bounded regardless of how chatty the photo session gets. */
export const PHOTO_CONTEXT_WINDOW = 8;
/** Keep the newest N photo files in the assistant scratch dir. */
export const PHOTO_SCRATCH_KEEP = 200;

/** File parts in the assistant history carry an extra local field: the
 *  scratch-dir path of the original bytes (the persist-time reference). */
export type AssistantFilePart = {
  type: "file";
  mediaType?: string;
  data?: string;
  sourcePath?: string;
};

export type PhotoDims = { scale: number; tw: number; th: number };

/** Target draw size for an image of (w,h): unchanged when the long edge is
 *  already within the limit, else aspect-preserving scale to the limit. */
export function computePhotoDims(
  w: number,
  h: number,
  maxLongEdge = PHOTO_MAX_LONG_EDGE,
): PhotoDims {
  const long = Math.max(w, h);
  if (long === 0 || long <= maxLongEdge) return { scale: 1, tw: w, th: h };
  const scale = maxLongEdge / long;
  return {
    scale,
    tw: Math.max(1, Math.round(w * scale)),
    th: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * JPEG re-encode at ≤PHOTO_MAX_LONG_EDGE px. Returns the downscaled base64,
 * or null meaning "send the original" — image APIs are strictly best-effort
 * here: a codec the webview can't decode (a HEIC edge case), a missing
 * OffscreenCanvas, or any encoding failure must NEVER lose the user's
 * photo. The caller falls back to the untouched bytes.
 */
export async function downscalePhotoJpeg(
  b64: string,
  maxLongEdge = PHOTO_MAX_LONG_EDGE,
  quality = PHOTO_JPEG_QUALITY,
): Promise<string | null> {
  try {
    if (
      typeof createImageBitmap !== "function" ||
      typeof OffscreenCanvas !== "function"
    )
      return null;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    try {
      const { scale, tw, th } = computePhotoDims(
        bmp.width,
        bmp.height,
        maxLongEdge,
      );
      if (scale >= 1) return null; // already small: original passes untouched
      const canvas = new OffscreenCanvas(tw, th);
      const g = canvas.getContext("2d");
      if (!g) return null;
      g.drawImage(bmp, 0, 0, tw, th);
      const out = await canvas.convertToBlob({ type: "image/jpeg", quality });
      const buf = new Uint8Array(await out.arrayBuffer());
      let binary = "";
      for (let i = 0; i < buf.length; i += 8192) {
        binary += String.fromCharCode(...buf.subarray(i, i + 8192));
      }
      return btoa(binary);
    } finally {
      bmp.close?.();
    }
  } catch {
    return null;
  }
}

/** Copy-on-write clear of inline photo payloads for persistence: file parts
 *  keep `mediaType` + `sourcePath` and lose `data`. Untouched messages are
 *  returned BY IDENTITY (the caller's array is never mutated). */
export function stripPhotoPayloads(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => {
    const parts = m.parts as unknown as Array<Record<string, unknown>>;
    if (!parts.some((p) => p?.type === "file" && p.data)) return m;
    return {
      ...m,
      parts: parts.map((p) =>
        p?.type === "file" && p.data ? { ...p, data: "" } : p,
      ),
    } as UIMessage;
  });
}

/** Read a scratch photo back as base64. */
export async function readPhotoBytesAsBase64(path: string): Promise<string> {
  const arr = await invoke<number[]>("fs_read_file_bytes", {
    path,
    workspace: null,
  });
  let binary = "";
  const bytes = Uint8Array.from(arr);
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

/**
 * Fill the payloads of the most recent `windowSize` persisted photo parts
 * (empty `data` + a `sourcePath`) from disk, so earlier images stay in the
 * model's context across turns and reloads. Failed reads (pruned file,
 * disk error) leave the part empty → `toModelMessage` simply omits the
 * image; nothing throws and no turn is lost over one missing file.
 * Messages that need no change are returned by identity.
 */
export async function rehydratePhotoPayloads(
  messages: UIMessage[],
  windowSize = PHOTO_CONTEXT_WINDOW,
  read: (path: string) => Promise<string> = readPhotoBytesAsBase64,
): Promise<UIMessage[]> {
  type Slot = { mi: number; pi: number; path: string };
  const slots: Slot[] = [];
  messages.forEach((m, mi) => {
    const parts = m.parts as unknown as Array<Record<string, unknown>>;
    parts.forEach((p, pi) => {
      if (p?.type === "file" && !p.data && p.sourcePath)
        slots.push({ mi, pi, path: p.sourcePath as string });
    });
  });
  if (slots.length === 0 || windowSize <= 0) return messages;
  const targets = slots.slice(-windowSize);
  const payloads = await Promise.all(
    targets.map((t) => read(t.path).catch(() => "")),
  );
  const fills = new Map<number, Map<number, string>>();
  targets.forEach((t, i) => {
    if (payloads[i]) {
      let byPart = fills.get(t.mi);
      if (!byPart) fills.set(t.mi, (byPart = new Map()));
      byPart.set(t.pi, payloads[i]);
    }
  });
  if (fills.size === 0) return messages;
  return messages.map((m, mi) => {
    const byPart = fills.get(mi);
    if (!byPart) return m;
    const parts = (m.parts as unknown as Array<Record<string, unknown>>).slice();
    for (const [pi, data] of byPart) parts[pi] = { ...parts[pi], data };
    return { ...m, parts } as UIMessage;
  });
}

/** Delete all but the newest `keep` scratch photos. Best-effort: a prune
 *  failure just leaves disk usage as-is; a rehydrate miss on a vanished
 *  file degrades to "image omitted from context", never an error. */
export async function prunePhotoScratch(
  root: string,
  sep: string,
  keep = PHOTO_SCRATCH_KEEP,
): Promise<void> {
  try {
    const entries = await invoke<Array<{ name: string; kind: string }>>(
      "fs_read_dir",
      { path: root, showHidden: true, workspace: null },
    );
    const photos = entries
      .filter(
        (e) =>
          e.kind === "file" &&
          e.name.startsWith("photo-") &&
          e.name.endsWith(".jpg"),
      )
      .map((e) => e.name)
      .sort(); // photo-<epoch-ms>.jpg sorts chronologically
    const doomed = photos.slice(0, Math.max(0, photos.length - keep));
    for (const name of doomed) {
      await invoke("fs_delete", {
        path: `${root}${sep}${name}`,
        workspace: null,
      }).catch(() => {});
    }
  } catch {
    // scratch dir unreadable / command unavailable: skip silently.
  }
}
