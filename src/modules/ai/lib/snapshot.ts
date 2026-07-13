/**
 * File snapshot and rollback system
 * Creates snapshots before edits and restores them on gate failure
 */

import { native } from "../lib/native";
import { djb2 } from "../lib/hash";

export type FileSnapshot = {
  path: string;
  content: string;
  hash: number;
  size: number;
  timestamp: number;
};

export type RollbackResult = {
  success: boolean;
  path: string;
  reason: string;
  restored?: boolean;
};

/**
 * Create a snapshot of a file
 */
export async function createSnapshot(filePath: string): Promise<FileSnapshot | null> {
  try {
    const result = await native.readFile(filePath);
    if (result.kind !== "text") {
      return null; // Binary file or too large
    }

    return {
      path: filePath,
      content: result.content,
      hash: djb2(result.content),
      size: result.size,
      timestamp: Date.now(),
    };
  } catch {
    // File doesn't exist yet - return null to indicate new file
    return null;
  }
}

/**
 * Restore a file from snapshot
 */
export async function restoreFromSnapshot(
  snapshot: FileSnapshot,
): Promise<RollbackResult> {
  try {
    await native.writeFile(snapshot.path, snapshot.content);
    return {
      success: true,
      path: snapshot.path,
      reason: "Restored from snapshot",
      restored: true,
    };
  } catch (err: unknown) {
    const error = err as { message: string };
    return {
      success: false,
      path: snapshot.path,
      reason: `Failed to restore: ${error.message}`,
      restored: false,
    };
  }
}

/**
 * Delete a newly created file (for rollback of new files)
 */
export async function deleteNewFile(filePath: string): Promise<RollbackResult> {
  try {
    // Check if file exists first
    try {
      await native.readFile(filePath);
    } catch {
      // File doesn't exist, nothing to delete
      return {
        success: true,
        path: filePath,
        reason: "File did not exist",
        restored: false,
      };
    }

    // Delete the file using native shell command
    // Use PowerShell on Windows, rm on Unix
    const isWindows = process.platform === "win32";
    const command = isWindows
      ? `Remove-Item -Path "${filePath}" -Force`
      : `rm "${filePath}"`;

    await native.runCommand(command, null, 30);

    return {
      success: true,
      path: filePath,
      reason: "Deleted newly created file",
      restored: true,
    };
  } catch (err: unknown) {
    const error = err as { message: string };
    return {
      success: false,
      path: filePath,
      reason: `Failed to delete: ${error.message}`,
      restored: false,
    };
  }
}

/**
 * Snapshot manager - tracks snapshots for batch operations
 */
export class SnapshotManager {
  private snapshots: Map<string, FileSnapshot | null> = new Map();

  /**
   * Create snapshots for multiple files
   */
  async createSnapshots(filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
      const snapshot = await createSnapshot(filePath);
      this.snapshots.set(filePath, snapshot);
    }
  }

  /**
   * Restore all snapshots
   */
  async restoreAll(): Promise<RollbackResult[]> {
    const results: RollbackResult[] = [];

    for (const [filePath, snapshot] of this.snapshots.entries()) {
      if (snapshot) {
        const result = await restoreFromSnapshot(snapshot);
        results.push(result);
      } else {
        // File was new - delete it
        const result = await deleteNewFile(filePath);
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Clear all tracked snapshots
   */
  clear(): void {
    this.snapshots.clear();
  }

  /**
   * Get snapshot for a specific file
   */
  getSnapshot(filePath: string): FileSnapshot | null | undefined {
    return this.snapshots.get(filePath);
  }
}

/**
 * Execute a mutation with automatic rollback on failure
 */
export async function withRollback<T>(
  filePaths: string[],
  mutation: () => Promise<T>,
  gateCheck: () => Promise<{ success: boolean; errors: any[]; output: string }>,
): Promise<{ result: T | null; rolledBack: boolean; rollbackResults: RollbackResult[] }> {
  // Create snapshots
  const manager = new SnapshotManager();
  await manager.createSnapshots(filePaths);

  try {
    // Execute mutation
    const result = await mutation();

    // Run gate check
    const gateResult = await gateCheck();

    if (gateResult.success) {
      // Gate passed - no rollback needed
      manager.clear();
      return { result, rolledBack: false, rollbackResults: [] };
    }

    // Gate failed - rollback
    const rollbackResults = await manager.restoreAll();
    return { result: null, rolledBack: true, rollbackResults };
  } catch (err: unknown) {
    const error = err as { message: string };
    // Mutation threw an error - still try to rollback
    const rollbackResults = await manager.restoreAll();
    return {
      result: null,
      rolledBack: true,
      rollbackResults: [
        ...rollbackResults,
        {
          success: false,
          path: "unknown",
          reason: `Mutation failed: ${error.message}`,
          restored: false,
        },
      ],
    };
  }
}
