/**
 * Download filenames for generated media.
 *
 * The prompt used to be handed straight to `a.download` (MediaLightbox), so a
 * request like "generate an image of Jhin and Mel from LoL ina coreography"
 * arrived at the OS save dialog as a 50-character sentence: the name field was
 * flooded and the extension was unparseable, which is why the save dialog
 * showed the description in BOTH the title and format slots. Everything here
 * is about producing a short, portable, extension-correct name instead.
 */

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

/** Names Windows refuses regardless of extension (case-insensitive). */
const RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** Longest stem we keep. Well under the 255-byte limit so the extension and
 *  a " (2)" de-duplication suffix always fit. */
const MAX_STEM = 60;

/** Characters invalid in a Windows filename, plus path separators. */
// eslint-disable-next-line no-control-regex
const INVALID = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * Turn arbitrary prompt text into a safe filename STEM (no extension).
 * Keeps letters/digits from any script, collapses everything else to single
 * dashes, and never returns an empty or reserved name.
 */
export function safeFileStem(text: string | undefined, fallback = "kai-image"): string {
  if (!text) return fallback;
  const cleaned = text
    .normalize("NFC")
    .replace(INVALID, " ")
    // Keep letters + digits (unicode aware) and single dashes between them.
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    // Windows also rejects names ending in a dot or space.
    .replace(/[. ]+$/g, "")
    .slice(0, MAX_STEM)
    .replace(/-$/, "");
  if (!cleaned) return fallback;
  if (RESERVED.has(cleaned.toLowerCase())) return `${cleaned}-file`;
  return cleaned;
}

export type MediaFilenameOpts = {
  /** Provider-declared mime type (drives the extension). */
  mimeType?: string;
  kind: "image" | "video";
  /** Injectable clock so tests are deterministic. */
  now?: number;
};

/** A complete, safe download filename: readable stem + correct extension. */
export function safeMediaFilename(
  prompt: string | undefined,
  { mimeType, kind, now = Date.now() }: MediaFilenameOpts,
): string {
  const stem = safeFileStem(prompt, kind === "image" ? "kai-image" : "kai-video");
  const ext =
    (mimeType ? MIME_EXT[mimeType.toLowerCase().split(";")[0]!.trim()] : undefined) ??
    (kind === "image" ? "png" : "mp4");
  // Short timestamp keeps two generations of the same prompt from silently
  // overwriting each other in the Downloads folder.
  const d = new Date(now);
  const stamp =
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}` +
    `${String(d.getDate()).padStart(2, "0")}-` +
    `${String(d.getHours()).padStart(2, "0")}` +
    `${String(d.getMinutes()).padStart(2, "0")}` +
    `${String(d.getSeconds()).padStart(2, "0")}`;
  return `${stem}-${stamp}.${ext}`;
}
