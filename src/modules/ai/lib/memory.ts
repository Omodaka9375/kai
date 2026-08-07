/**
 * Auto-Memory System — persistent project knowledge that survives sessions.
 *
 * Modeled after Claude Code's auto-memory: each project gets
 * `~/.kai/memory/<project-hash>/MEMORY.md` which the agent can read and write.
 * The first 200 lines (or 25KB) are loaded into every session's system prompt.
 *
 * The agent uses `save_memory` to persist learnings and `read_file` to recall.
 */

import { homeDir } from "@tauri-apps/api/path";
import { native } from "./native";

const MEMORY_DIR = ".kai/memory";
const MAX_MEMORY_LOAD_BYTES = 25 * 1024;
const MAX_MEMORY_LOAD_LINES = 200;

/**
 * Hash a path string into a safe filename component.
 * Simple DJB2 — matches what the hash module uses.
 */
function djb2(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/**
 * Resolve the memory directory path for a given workspace root.
 * Returns the absolute path to `~/.kai/memory/<hash>/`.
 */
export async function getProjectMemoryDir(
  workspaceRoot: string,
): Promise<string> {
  const home = await homeDir();
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const hash = djb2(root).toString(16);
  return `${home.replace(/\\/g, "/").replace(/\/$/, "")}/${MEMORY_DIR}/${hash}`;
}

/**
 * Ensure the memory directory exists and return its path.
 */
async function ensureMemoryDir(workspaceRoot: string): Promise<string> {
  const dir = await getProjectMemoryDir(workspaceRoot);
  try {
    await native.createDir(dir);
  } catch {
    // Already exists.
  }
  return dir;
}

/**
 * Load the active memory file content for a workspace.
 * Returns the first MAX_MEMORY_LOAD_LINES lines (capped at MAX_MEMORY_LOAD_BYTES).
 */
export async function loadProjectMemory(
  workspaceRoot: string,
): Promise<string | null> {
  const dir = await getProjectMemoryDir(workspaceRoot);
  const path = `${dir}/MEMORY.md`;
  try {
    const r = await native.readFile(path);
    if (r.kind !== "text") return null;
    const lines = r.content.split("\n");
    const head = lines.slice(0, MAX_MEMORY_LOAD_LINES).join("\n");
    return head.length > MAX_MEMORY_LOAD_BYTES
      ? head.slice(0, MAX_MEMORY_LOAD_BYTES)
      : head;
  } catch {
    return null;
  }
}

/**
 * Append an entry to the memory file. Creates the file if it doesn't exist.
 * Each entry is timestamped with the session ID for traceability.
 */
export async function appendToMemory(
  workspaceRoot: string,
  entry: string,
  sessionId?: string,
): Promise<void> {
  const dir = await ensureMemoryDir(workspaceRoot);
  const path = `${dir}/MEMORY.md`;

  const timestamp = new Date().toISOString();
  const header = sessionId
    ? `## ${timestamp} (session: ${sessionId})`
    : `## ${timestamp}`;

  const block = `\n\n${header}\n${entry.trim()}\n`;

  try {
    // Read existing content or start fresh.
    let existing = "";
    try {
      const r = await native.readFile(path);
      if (r.kind === "text") {
        existing = r.content;
      }
    } catch {
      // File doesn't exist — start with a header.
      existing = `# Kai Memory — auto-generated project knowledge\n\nThis file is written by the AI agent across sessions. Edit freely.\n`;
    }

    const content = existing + block;
    await native.writeFile(path, content);
  } catch (e) {
    console.debug("auto-memory: failed to write", path, e);
  }
}

// ── Cache ─────────────────────────────────────────────────────────────

type MemoryCacheEntry = { content: string | null; mtime: number };
const memoryCache = new Map<string, MemoryCacheEntry>();
const MEMORY_CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Load project memory with caching. Public-facing API used by transport.ts.
 */
export async function loadProjectMemoryCached(
  workspaceRoot: string | null,
): Promise<string | null> {
  if (!workspaceRoot) return null;
  const cached = memoryCache.get(workspaceRoot);
  if (cached && Date.now() - cached.mtime < MEMORY_CACHE_TTL_MS) {
    return cached.content;
  }
  try {
    const content = await loadProjectMemory(workspaceRoot);
    memoryCache.set(workspaceRoot, { content, mtime: Date.now() });
    return content;
  } catch {
    memoryCache.set(workspaceRoot, { content: null, mtime: Date.now() });
    return null;
  }
}

/**
 * Invalidate the memory cache (useful after memory writes).
 */
export function invalidateMemoryCache(): void {
  memoryCache.clear();
}