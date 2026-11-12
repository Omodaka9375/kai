import { invoke } from "@tauri-apps/api/core";
import { MIME_EXT, safeMediaFilename } from "./filename";

/** One filter row for the native save dialog, keyed by file extension. */
function filterForExt(ext: string): { name: string; extensions: string[] }[] {
  return [{ name: `${ext.toUpperCase()} file`, extensions: [ext] }];
}

/**
 * Core save path: native `save_file_dialog` (OS dialog, starts in the
 * Downloads folder, extension filter) -> `fs_write_file_bytes` (atomic
 * tmp+rename write; the user explicitly chose the target, so it bypasses
 * the workspace sandbox). Returns the saved path, or null on cancel.
 */
export async function saveBytesViaDialog(opts: {
  defaultName: string;
  bytes: Uint8Array;
  extension: string;
}): Promise<string | null> {
  const { defaultName, bytes, extension } = opts;
  const target = await invoke<string | null>("save_file_dialog", {
    defaultName,
    filters: filterForExt(extension),
  });
  if (!target) return null;
  await invoke("fs_write_file_bytes", {
    path: target,
    bytes: Array.from(bytes),
    workspace: null,
  });
  return target;
}

/** Same as saveBytesViaDialog, encoding text as UTF-8 first. */
export async function saveTextViaDialog(opts: {
  defaultName: string;
  text: string;
  extension: string;
}): Promise<string | null> {
  return saveBytesViaDialog({
    defaultName: opts.defaultName,
    bytes: new TextEncoder().encode(opts.text),
    extension: opts.extension,
  });
}

/** Decode a `data:` URI into raw bytes. THROWS for a non-base64 data URI
 *  (never write a percent-encoded blob as if it were binary); returns null
 *  for blob:/http(s): URLs, which take the fetch path instead. */
function bytesFromDataUri(src: string): Uint8Array | null {
  const comma = src.indexOf(",");
  if (comma < 0) return null;
  const header = src.slice(0, comma);
  if (!/^data:[^;,]+;base64$/i.test(header)) {
    throw new Error("unsupported data URI (expected base64)");
  }
  const binary = atob(src.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Extract a mime type from a `data:` URI header (`data:image/png;base64`). */
export function mimeFromDataUri(src: string): string | undefined {
  const m = /^data:([^;,]+)[;,]/.exec(src);
  return m?.[1];
}

/**
 * Save generated media through the NATIVE save dialog.
 *
 * The old path was `document.createElement("a") + a.download + a.click()` —
 * the browser download trick. Under Tauri's WebView (wry) it is a silent
 * no-op: the download attribute needs a real browser download manager,
 * which the webview does not have, so the Save buttons did nothing at all.
 * There was also no error — the click simply vanished.
 *
 * Data-URI media (generated images) decode locally — CSP connect-src has no
 * data:/blob: entries, so fetching a data URL from the webview would be
 * blocked anyway. Remote URLs (provider CDN video links) go through plain
 * webview fetch, which CSP allows for https.
 * Returns the saved path, or null when the user cancelled.
 */
export async function saveMediaViaDialog(opts: {
  src: string;
  prompt: string | undefined;
  kind: "image" | "video";
}): Promise<string | null> {
  const { src, prompt, kind } = opts;
  const mimeType = mimeFromDataUri(src);
  const defaultName = safeMediaFilename(prompt, { mimeType, kind });
  const ext =
    (mimeType ? MIME_EXT[mimeType.toLowerCase().split(";")[0]!.trim()] : undefined) ??
    (kind === "image" ? "png" : "mp4");

  const bytes = bytesFromDataUri(src);
  if (bytes) {
    return saveBytesViaDialog({ defaultName, bytes, extension: ext });
  }

  // Remote URL (e.g. a provider CDN link for videos). Blob URLs resolve
  // inside the webview itself.
  const res = await fetch(src);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return saveBytesViaDialog({ defaultName, bytes: buf, extension: ext });
}
