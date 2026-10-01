import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { currentWorkspaceEnv } from "@/modules/workspace";

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type DocumentState =
  | { status: "loading" }
  | { status: "ready"; content: string; size: number }
  | { status: "binary"; size: number }
  | { status: "toolarge"; size: number; limit: number }
  | { status: "error"; message: string };

/** Outcome of a save attempt. */
export type SaveOutcome =
  | { ok: true }
  | { ok: false; conflict: true }
  | { ok: false; conflict: false; error: string };

type Options = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
};

/** Compare editor path (forward-slash canonical) with an fs-changed payload
 *  path (also normalized by Rust to forward slashes). Case-insensitive on
 *  Windows-style drive letters. */
function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

export function useDocument({ path, onDirtyChange }: Options) {
  const [doc, setDoc] = useState<DocumentState>({ status: "loading" });
  const [dirty, setDirty] = useState(false);
  /** Set when the file changed on disk WHILE the buffer had unsaved edits.
   *  The user must pick: reload (discard their edits) or overwrite. */
  const [conflict, setConflict] = useState(false);
  const [reloadCounter, setReloadCounter] = useState(0);

  // Track the saved buffer so we can detect changes cheaply.
  const savedRef = useRef<string>("");
  const bufferRef = useRef<string>("");
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  const conflictRef = useRef(false);
  useEffect(() => {
    conflictRef.current = conflict;
  }, [conflict]);

  // Notify parent of dirty transitions.
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  // Load on path change or explicit reload.
  useEffect(() => {
    let cancelled = false;
    setDoc({ status: "loading" });
    setDirty(false);
    setConflict(false);

    invoke<ReadResult>("fs_read_file", { path, workspace: currentWorkspaceEnv() })
      .then((res) => {
        if (cancelled) return;
        if (res.kind === "text") {
          savedRef.current = res.content;
          bufferRef.current = res.content;
          setDoc({
            status: "ready",
            content: res.content,
            size: res.size,
          });
        } else if (res.kind === "binary") {
          setDoc({ status: "binary", size: res.size });
        } else if (res.kind === "toolarge") {
          setDoc({
            status: "toolarge",
            size: res.size,
            limit: res.limit,
          });
        }
      })
      .catch((e) => {
        if (!cancelled) setDoc({ status: "error", message: String(e) });
      });

    return () => {
      cancelled = true;
    };
  }, [path, reloadCounter]);

  // ── External change detection ────────────────────────────────────────
  // fs_write_file / fs_write_file_bytes (Rust) emit `fs-changed` after every
  // successful write. When the changed file is THIS file:
  //  - clean buffer → reload immediately (user sees the new content);
  //  - dirty buffer → mark conflict; NEVER clobber the user's unsaved edits.
  // When the user saves, the write itself emits fs-changed for THIS document —
  // ignore our own writes (buffer already matches what we just wrote).
  const selfWriteRef = useRef(false);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<{ path: string }>("fs-changed", (event) => {
      const changed = event.payload?.path;
      if (typeof changed !== "string") return;
      if (!samePath(changed, path)) return;
      if (selfWriteRef.current) return; // our own save
      if (doc.status !== "ready") return; // only text buffers track conflict
      if (dirtyRef.current) {
        // Unsaved edits + external change → conflict, don't touch the buffer.
        setConflict(true);
      } else {
        // Clean buffer → safe to pick up the new content automatically.
        setReloadCounter((n) => n + 1);
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [path, doc.status]);

  /** Re-read the file from disk. No-op (silent) if the buffer is dirty —
   *  callers shouldn't clobber unsaved user edits. Returns whether reload ran. */
  const reload = useCallback((): boolean => {
    if (dirtyRef.current) return false;
    setReloadCounter((n) => n + 1);
    return true;
  }, []);

  /** Discard the user's edits and take the on-disk version (conflict resolution). */
  const takeDiskVersion = useCallback(() => {
    setReloadCounter((n) => n + 1);
  }, []);

  const onChange = useCallback((next: string) => {
    bufferRef.current = next;
    setDirty(next !== savedRef.current);
  }, []);

  const save = useCallback(async (): Promise<SaveOutcome> => {
    if (!dirty && !conflict) return { ok: true };
    const content = bufferRef.current;

    // Conflict guard: if the file changed on disk since we last loaded/saved
    // it, a plain write would silently revert the external change (e.g. the
    // agent's edit). Refuse and surface the conflict banner instead.
    if (conflictRef.current) {
      return { ok: false, conflict: true };
    }
    let disk: string | null = null;
    try {
      const res = await invoke<ReadResult>("fs_read_file", {
        path,
        workspace: currentWorkspaceEnv(),
      });
      if (res.kind === "text") disk = res.content;
    } catch {
      // Read failed (e.g. file deleted externally) — proceed with the write;
      // there's nothing on disk to lose.
    }
    if (disk !== null && disk !== savedRef.current) {
      // Disk content diverged from our snapshot — external change raced in
      // between the fs-changed event and this save. Treat as conflict.
      setConflict(true);
      return { ok: false, conflict: true };
    }

    try {
      selfWriteRef.current = true;
      await invoke("fs_write_file", {
        path,
        content,
        workspace: currentWorkspaceEnv(),
      });
    } catch (e) {
      selfWriteRef.current = false;
      return { ok: false, conflict: false, error: String(e) };
    } finally {
      // Keep the flag up through the async event dispatch so our own
      // fs-changed listener ignores it; clear on the next macrotask.
      setTimeout(() => {
        selfWriteRef.current = false;
      }, 0);
    }
    savedRef.current = content;
    setDirty(false);
    setConflict(false);
    return { ok: true };
  }, [path, dirty, conflict]);

  /** Overwrite the on-disk file with the user's buffer, discarding the
   *  external change (conflict resolution — explicit user choice). */
  const overwriteDisk = useCallback(async (): Promise<SaveOutcome> => {
    const content = bufferRef.current;
    try {
      selfWriteRef.current = true;
      await invoke("fs_write_file", {
        path,
        content,
        workspace: currentWorkspaceEnv(),
      });
    } catch (e) {
      selfWriteRef.current = false;
      return { ok: false, conflict: false, error: String(e) };
    } finally {
      setTimeout(() => {
        selfWriteRef.current = false;
      }, 0);
    }
    savedRef.current = content;
    setDirty(false);
    setConflict(false);
    return { ok: true };
  }, [path]);

  return {
    doc,
    dirty,
    conflict,
    onChange,
    save,
    overwriteDisk,
    reload,
    takeDiskVersion,
  };
}
