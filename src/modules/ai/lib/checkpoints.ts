/**
 * Automatic Edit Checkpoints — snapshots file content before AI mutations so
 * the user can undo any batch of agent edits with a single action.
 *
 * Strategy:
 *  - Before any write_file / edit / multi_edit, snapshot the current file
 *    content into `.kai/checkpoints/<timestamp>-<session>.json`.
 *  - The checkpoint file lives inside the workspace (not user data dir) so it's
 *    discoverable and deletable by the user.
 *  - A `checkpoint_undo` tool lets the agent (or user via chat) restore the
 *    last checkpoint batch.
 *  - Auto-clean checkpoints older than 1 hour on session close.
 */

import { native } from "./native";
import { checkWritableCanonical } from "./security";
import { IS_WINDOWS } from "@/lib/platform";

const CHECKPOINTS_DIR = ".kai/checkpoints";
const MAX_CHECKPOINT_AGE_MS = 60 * 60 * 1000; // 1 hour

/** Collapse `\\` to `/` and strip trailing slashes. Matches the canonical
 *  forward-slash path form used across the frontend (see KAI.md). */
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isAbsolute(p: string): boolean {
  return /^[a-zA-Z]:\//.test(p) || p.startsWith("//") || p.startsWith("/");
}

/** Split into meaningful segments, rejecting `.`/empty. Returns null on any
 *  `..` — callers must hand us an already-normalized path. */
function segmentsOf(p: string): string[] | null {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    out.push(seg);
  }
  return out;
}

/**
 * Confine a path to the workspace.
 *
 * Checkpoint records are plain JSON on disk inside the workspace, so their
 * `files` keys are attacker-controllable input — a hand-planted
 * `.kai/checkpoints/1-x.json` naming `~/.ssh/authorized_keys` would otherwise
 * be written verbatim. This returns the normalized path when it is an
 * absolute descendant of `workspaceRoot`, and null otherwise.
 */
export function confineToWorkspace(
  workspaceRoot: string,
  candidate: string,
): string | null {
  if (typeof candidate !== "string" || !candidate || candidate.includes("\0")) {
    return null;
  }
  const p = norm(candidate);
  if (!isAbsolute(p) || /[<>]/.test(p)) return null;

  const pathSegs = segmentsOf(p);
  const rootSegs = segmentsOf(norm(workspaceRoot));
  if (!pathSegs || !rootSegs || pathSegs.length <= rootSegs.length) return null;

  // Case-insensitive on Windows (case-preserving but case-insensitive FS).
  const eq = IS_WINDOWS
    ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    : (a: string, b: string) => a === b;

  for (let i = 0; i < rootSegs.length; i++) {
    if (!eq(rootSegs[i]!, pathSegs[i]!)) return null;
  }

  // Never restore into the checkpoint directory itself — that is the exact
  // injection vector this function exists to close. Scoped to
  // `.kai/checkpoints` rather than all of `.kai/`, so restoring other project
  // files beneath it (`.kai/memory/…`, `.kai/rules`) still works.
  const inCheckpointDir =
    eq(pathSegs[rootSegs.length] ?? "", ".kai") &&
    eq(pathSegs[rootSegs.length + 1] ?? "", "checkpoints");
  if (inCheckpointDir) return null;

  // Safe to return the normalized original — `segmentsOf` already proved there
  // are no `.`/`..` segments to resolve, and this preserves drive-letter and
  // UNC (`//host/share`) prefixes exactly as written.
  return p;
}

export type CheckpointRecord = {
  timestamp: number;
  sessionId: string;
  files: Record<string, string | null>;
  /** null value means the file was created by the edit (didn't exist before). */
};

/**
 * Compute workspace-relative path for a checkpoint file.
 */
/** Guarantees unique filenames when two batches commit in the same millisecond. */
let lastCheckpointTs = 0;

function nextCheckpointTs(): number {
  const now = Date.now();
  lastCheckpointTs = now > lastCheckpointTs ? now : lastCheckpointTs + 1;
  return lastCheckpointTs;
}

function checkpointPath(
  workspaceRoot: string,
  timestamp: number,
  sessionId: string,
): string {
  const root = norm(workspaceRoot);
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${root}/${CHECKPOINTS_DIR}/${timestamp}-${safe}.json`;
}

function ensureCheckpointsDir(workspaceRoot: string): Promise<void> {
  const dir = `${workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "")}/${CHECKPOINTS_DIR}`;
  return native.createDir(dir).catch(() => {
    // Directory already exists — fine.
  });
}

/**
 * List all checkpoint files in the workspace, oldest first.
 */
export async function listCheckpoints(
  workspaceRoot: string,
): Promise<CheckpointRecord[]> {
  const dir = `${workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "")}/${CHECKPOINTS_DIR}`;
  let entries: { name: string; kind: string }[];
  try {
    entries = (await native.readDir(dir)).map((e) => ({
      name: e.name,
      kind: e.kind,
    }));
  } catch {
    return [];
  }

  const records: CheckpointRecord[] = [];
  for (const entry of entries) {
    if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
    const filePath = `${dir}/${entry.name}`;
    try {
      const r = await native.readFile(filePath);
      if (r.kind !== "text") continue;
      const raw: unknown = JSON.parse(r.content);
      const rec = validateRecord(raw);
      if (rec) records.push(rec);
    } catch {
      // Corrupt checkpoint — skip.
    }
  }

  records.sort((a, b) => a.timestamp - b.timestamp);
  return records;
}

/** Shape-check a parsed checkpoint. Rejects anything that could carry a
 *  non-string key or a non-string|null value into `restoreCheckpoint`. */
function validateRecord(raw: unknown): CheckpointRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.timestamp !== "number" || !Number.isFinite(o.timestamp)) return null;
  if (typeof o.sessionId !== "string") return null;
  if (typeof o.files !== "object" || o.files === null) return null;

  const files: Record<string, string | null> = {};
  for (const [path, content] of Object.entries(o.files as Record<string, unknown>)) {
    if (content !== null && typeof content !== "string") continue;
    files[path] = content;
  }
  return { timestamp: o.timestamp, sessionId: o.sessionId, files };
}

/**
 * Snapshot a single file before it gets mutated. Does NOT write to disk yet —
 * the caller aggregates files and calls `commitCheckpoint` once before the
 * batch of edits.
 */
let pendingCheckpoint: Map<string, string | null> | null = null;
let pendingWorkspaceRoot: string | null = null;
let pendingSessionId: string | null = null;

export function beginCheckpointBatch(
  workspaceRoot: string | null,
  sessionId: string | null,
): void {
  if (!workspaceRoot || !sessionId) return;
  // Always start a FRESH batch. Each call site calls begin() exactly once, so
  // there is nothing to aggregate across calls — and resetting here means a
  // batch left pending by an early `return` in some tool cannot bleed its
  // files into the next call's checkpoint record.
  pendingCheckpoint = new Map();
  pendingWorkspaceRoot = workspaceRoot;
  pendingSessionId = sessionId;
}

/** Snapshot one file path into the pending checkpoint batch. */
export async function snapshotFile(absPath: string): Promise<void> {
  if (!pendingCheckpoint) return;
  try {
    const r = await native.readFile(absPath);
    if (r.kind === "text") {
      pendingCheckpoint.set(absPath, r.content);
    } else if (r.kind === "binary") {
      pendingCheckpoint.set(absPath, null); // binary — can't snapshot text
    }
  } catch {
    // File doesn't exist yet — this is a create, record as null.
    pendingCheckpoint.set(absPath, null);
  }
}

/**
 * Flush the pending checkpoint batch to disk and reset.
 *
 * The pending state is captured and cleared synchronously BEFORE the first
 * await, so a concurrent tool call that begins its own batch cannot have its
 * files swallowed into (or lost to) this one.
 */
export async function commitCheckpoint(): Promise<void> {
  const files = pendingCheckpoint;
  const cwd = pendingWorkspaceRoot;
  const sessionId = pendingSessionId;

  pendingCheckpoint = null;
  pendingWorkspaceRoot = null;
  pendingSessionId = null;

  if (!files || files.size === 0 || !cwd || !sessionId) return;

  const entries: Record<string, string | null> = {};
  for (const [path, content] of files) {
    entries[path] = content;
  }

  const record: CheckpointRecord = {
    timestamp: nextCheckpointTs(),
    sessionId,
    files: entries,
  };

  const path = checkpointPath(cwd, record.timestamp, sessionId);

  try {
    await ensureCheckpointsDir(cwd);
    await native.writeFile(path, JSON.stringify(record, null, 2));
  } catch (e) {
    console.debug("checkpoint: failed to write", path, e);
  }
}

/** Discard the pending checkpoint batch without writing. */
export function discardCheckpoint(): void {
  pendingCheckpoint = null;
  pendingWorkspaceRoot = null;
  pendingSessionId = null;
}

/**
 * Restore files from a checkpoint record. For each file:
 *  - If content is a string: write it back
 *  - If content is null: delete the file (it was created by the AI)
 *
 * Every path is confined to `workspaceRoot` and re-checked through
 * `checkWritableCanonical` (which also catches symlink traversal) before any
 * mutation. `record.files` is treated as untrusted input — see
 * {@link confineToWorkspace}.
 */
export async function restoreCheckpoint(
  record: CheckpointRecord,
  workspaceRoot: string,
): Promise<{ restored: number; deleted: number; skipped: string[]; errors: string[] }> {
  let restored = 0;
  let deleted = 0;
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const [path, content] of Object.entries(record.files)) {
    const confined = confineToWorkspace(workspaceRoot, path);
    if (confined === null) {
      skipped.push(`${path} — outside workspace root`);
      continue;
    }

    const safety = await checkWritableCanonical(confined, native.canonicalize);
    if (!safety.ok) {
      skipped.push(`${path} — ${safety.reason}`);
      continue;
    }

    // Re-confine the RESOLVED path: `checkWritableCanonical` follows symlinks,
    // so a link inside the workspace can otherwise redirect the write outside.
    const resolved = confineToWorkspace(workspaceRoot, safety.canonical);
    if (resolved === null) {
      skipped.push(`${path} — resolves outside workspace root`);
      continue;
    }

    try {
      if (content === null) {
        await native.deleteFile(resolved);
        deleted++;
      } else {
        await native.writeFile(resolved, content);
        restored++;
      }
    } catch (e) {
      errors.push(`${path}: ${String(e)}`);
    }
  }

  return { restored, deleted, skipped, errors };
}

/**
 * Clean checkpoints older than MAX_CHECKPOINT_AGE_MS.
 */
export async function cleanOldCheckpoints(
  workspaceRoot: string,
): Promise<number> {
  const dir = `${workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "")}/${CHECKPOINTS_DIR}`;
  let entries: { name: string; kind: string }[];
  try {
    entries = (await native.readDir(dir)).map((e) => ({
      name: e.name,
      kind: e.kind,
    }));
  } catch {
    return 0;
  }

  const now = Date.now();
  let cleaned = 0;

  for (const entry of entries) {
    if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
    // Extract timestamp from filename: `<timestamp>-<session>.json`
    const tsStr = entry.name.split("-")[0];
    const ts = parseInt(tsStr, 10);
    if (isNaN(ts)) continue;
    if (now - ts < MAX_CHECKPOINT_AGE_MS) continue;

    try {
      await native.deleteFile(`${dir}/${entry.name}`);
      cleaned++;
    } catch {
      // Can't delete — skip.
    }
  }

  return cleaned;
}