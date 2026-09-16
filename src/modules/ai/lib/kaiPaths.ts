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
 *   → "C:/Users/me/.kai/checkpoints/1a2b3c4d"
 */
export async function getKaiStateDir(
  workspaceRoot: string,
  sub: string,
): Promise<string> {
  const home = await homeDir();
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const hash = djb2(root).toString(16);
  return `${home.replace(/\\/g, "/").replace(/\/+$/, "")}/.kai/${sub}/${hash}`;
}
