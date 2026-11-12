import { invoke } from "@tauri-apps/api/core";
import { safeMediaFilename } from "./filename";

/**
 * Persist generated media to ~/.kai/media/ so it exists as a FILE.
 *
 * Two reasons (2026-11-12 report: "generate a video from the image" blew the
 * context window):
 *  1. The chat transcript is the only copy otherwise, and its megabytes of
 *     base64 re-ride EVERY later request (the model-bound copy gets a short
 *     summary instead — see extraction.ts).
 *  2. Follow-up tools need a PATH: the image edit / video animate inputs read
 *     from disk. Without a saved file the model cannot act on a generated
 *     image at all.
 *
 * Best-effort: NEVER throws — a save failure returns undefined and the
 * generation still surfaces in the chat (the summary just omits the path).
 */

/** Skip persisting absurd payloads (24MB+ decoded) — IPC cost outweighs value. */
const MAX_BASE64_CHARS = 32 * 1024 * 1024;

/** The native fs surface persist needs (injectable for tests). */
export type PersistFs = Pick<
  typeof import("../native").native,
  "createDir" | "writeFileBytes"
>;

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Home dir from the Rust side (backslashes on Windows) — cached per call. */
let cachedHome: string | null = null;
async function mediaDir(): Promise<string | null> {
  if (cachedHome) return cachedHome;
  try {
    const home = await invoke<string>("kai_home_dir");
    if (!home) return null;
    // Canonical frontend form is forward slashes; Windows accepts them in
    // Rust PathBuf too.
    cachedHome = `${home.replace(/\\/g, "/").replace(/\/+$/, "")}/.kai/media`;
    return cachedHome;
  } catch {
    return null;
  }
}

/**
 * Write one generated media payload to ~/.kai/media/ and return its
 * absolute forward-slash path, or undefined when anything fails.
 * `index` disambiguates multiple results of one request (the filename
 * timestamp is second-precision, so entries of the same call collide).
 */
export async function persistGeneratedMedia(
  fs: PersistFs,
  opts: {
    kind: "image" | "video";
    prompt: string;
    mimeType: string;
    base64: string;
    index?: number;
  },
): Promise<string | undefined> {
  const { kind, prompt, mimeType, base64, index = 0 } = opts;
  if (!base64 || base64.length > MAX_BASE64_CHARS) return undefined;
  const bytes = base64ToBytes(base64);
  if (!bytes || bytes.length === 0) return undefined;

  const dir = await mediaDir();
  if (!dir) return undefined;

  let name = safeMediaFilename(prompt, { mimeType, kind });
  if (index > 0) {
    // unique per entry: stem-stamp-N.ext
    const dot = name.lastIndexOf(".");
    name = dot > 0
      ? `${name.slice(0, dot)}-${index + 1}${name.slice(dot)}`
      : `${name}-${index + 1}`;
  }

  const target = `${dir}/${name}`;
  try {
    // Idempotent per docs; a failure here means the disk is unusable anyway.
    await fs.createDir(dir).catch(() => {});
    await fs.writeFileBytes(target, Array.from(bytes));
    return target;
  } catch (e) {
    console.warn("[kai] generated media persist failed:", e);
    return undefined;
  }
}
