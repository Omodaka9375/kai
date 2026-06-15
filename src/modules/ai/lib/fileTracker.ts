/**
 * Tracks files read and modified during an agent session.
 * Used to enhance context compaction summaries with file state info.
 */

export type FileState = "read" | "modified";

export type FileSnapshot = { path: string; state: FileState };

export class FileTracker {
  private files = new Map<string, FileState>();

  /** Mark a file as read (only if not already tracked). */
  markRead(path: string): void {
    if (!this.files.has(path)) {
      this.files.set(path, "read");
    }
  }

  /** Mark a file as modified (always upgrades state). */
  markModified(path: string): void {
    this.files.set(path, "modified");
  }

  /** Get a snapshot of all tracked files. */
  getSnapshot(): FileSnapshot[] {
    return Array.from(this.files.entries()).map(([path, state]) => ({
      path,
      state,
    }));
  }

  /** Clear all tracked files. */
  clear(): void {
    this.files.clear();
  }

  /** Serialize to JSON-compatible object. */
  toJSON(): Record<string, FileState> {
    return Object.fromEntries(this.files);
  }

  /** Restore from JSON. */
  static fromJSON(data: Record<string, FileState>): FileTracker {
    const tracker = new FileTracker();
    for (const [path, state] of Object.entries(data)) {
      tracker.files.set(path, state);
    }
    return tracker;
  }

  /** Check if any files have been tracked. */
  hasFiles(): boolean {
    return this.files.size > 0;
  }

  get size(): number {
    return this.files.size;
  }
}
