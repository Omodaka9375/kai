/**
 * Per-project KAI state paths (`~/.kai/<sub>/<workspace-hash>/`).
 *
 * Agent-generated state (memory, edit checkpoints) lives OUTSIDE the user's
 * workspace so it never shows up in the file tree, git status, or an
 * accidental commit. Each workspace is keyed by a hash of its absolute path
 * — same layout for every consumer (`memory`, `checkpoints`).
 *
 * User-authored project config (`.kai/rules`, `.kai/hooks`) intentionally
 * stays IN the workspace — that's versioned config, like `.github/`.
 */

import { homeDir } from "@tauri-apps/api/path";
import { normalizeWorkspacePath } from "./workspacePath";

/** Hash a path string into a safe filename component (DJB2). */
export function djb2(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/**
 * Resolve a per-project state directory under `~/.kai/<sub>/<hash>/`.
 * Example: getKaiStateDir("D:/Code/proj", "checkpoints")
 *   → "C:/Users/me/.kai/checkpoints/<hash>"
 *
 * The hash is computed over the LOWERCASED, forward-slash-normalized root — the
 * same identity rule as `normalizeWorkspacePath` and the Rust `project_key`
 * used by sessions and window state. Historically this did NOT lowercase, so
 * `D:/Code/KAI` and `d:/code/kai` (the same project on a case-insensitive FS)
 * hashed to different dirs, and memory/checkpoints written under one casing
 * were silently "lost" when the launch dir was later resolved with different
 * casing. Lowercasing keeps per-project state keyed identically to sessions.
 */
export async function getKaiStateDir(
  workspaceRoot: string,
  sub: string,
): Promise<string> {
  const home = await homeDir();
  const homeNorm = home.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = normalizeWorkspacePath(workspaceRoot) ?? workspaceRoot;
  const hash = djb2(root).toString(16);
  return `${homeNorm}/.kai/${sub}/${hash}`;
}

/**
 * The legacy (case-preserving) state-dir path, kept only as a read fallback so
 * memory/checkpoints written before the case-insensitive keying fix aren't
 * orphaned. Callers check this path when the canonical one has no data.
 */
export async function getLegacyKaiStateDir(
  workspaceRoot: string,
  sub: string,
): Promise<string> {
  const home = await homeDir();
  const homeNorm = home.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${homeNorm}/.kai/${sub}/${djb2(root).toString(16)}`;
}
