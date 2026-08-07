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

const CHECKPOINTS_DIR = ".kai/checkpoints";
const MAX_CHECKPOINT_AGE_MS = 60 * 60 * 1000; // 1 hour

export type CheckpointRecord = {
  timestamp: number;
  sessionId: string;
  files: Record<string, string | null>;
  /** null value means the file was created by the edit (didn't exist before). */
};

/**
 * Compute workspace-relative path for a checkpoint file.
 */
function checkpointPath(
  workspaceRoot: string,
  timestamp: number,
  sessionId: string,
): string {
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "");
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
      const parsed = JSON.parse(r.content) as CheckpointRecord;
      records.push(parsed);
    } catch {
      // Corrupt checkpoint — skip.
    }
  }

  records.sort((a, b) => a.timestamp - b.timestamp);
  return records;
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
  workspaceRoot: string,
  sessionId: string,
): void {
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

/** Flush the pending checkpoint batch to disk and reset. */
export async function commitCheckpoint(): Promise<void> {
  if (
    !pendingCheckpoint ||
    !pendingWorkspaceRoot ||
    !pendingSessionId ||
    pendingCheckpoint.size === 0
  ) {
    pendingCheckpoint = null;
    pendingWorkspaceRoot = null;
    pendingSessionId = null;
    return;
  }

  // Don't snapshot in the checkpoints directory itself.
  const entries: Record<string, string | null> = {};
  for (const [path, content] of pendingCheckpoint) {
    entries[path] = content;
  }

  const record: CheckpointRecord = {
    timestamp: Date.now(),
    sessionId: pendingSessionId,
    files: entries,
  };

  const cwd = pendingWorkspaceRoot;
  const path = checkpointPath(cwd, record.timestamp, pendingSessionId);

  try {
    await ensureCheckpointsDir(cwd);
    await native.writeFile(path, JSON.stringify(record, null, 2));
  } catch (e) {
    console.debug("checkpoint: failed to write", path, e);
  }

  pendingCheckpoint = null;
  pendingWorkspaceRoot = null;
  pendingSessionId = null;
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
 */
export async function restoreCheckpoint(
  record: CheckpointRecord,
): Promise<{ restored: number; deleted: number; errors: string[] }> {
  let restored = 0;
  let deleted = 0;
  const errors: string[] = [];

  for (const [path, content] of Object.entries(record.files)) {
    try {
      if (content === null) {
        await native.deleteFile(path);
        deleted++;
      } else {
        await native.writeFile(path, content);
        restored++;
      }
    } catch (e) {
      errors.push(`${path}: ${String(e)}`);
    }
  }

  return { restored, deleted, errors };
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