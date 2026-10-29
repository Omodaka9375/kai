import { useSyncExternalStore } from "react";

/**
 * Per-project "a command is running" indicator for the project rail.
 *
 * Leaf ids are PROCESS-GLOBAL (idAllocator), so a single module-level map
 * keyed by leaf id is correct across all retained project workspaces. The
 * session layer (useTerminalSession) flips a leaf active on OSC 133 B/C and
 * inactive on 133 D/A, shell exit, and dispose — no React plumbing through
 * TerminalStack needed, background projects included (their terminals keep
 * streaming while unmounted from view).
 *
 * Consumers subscribe either per-project (rail dot) or leaf-scoped. Polling
 * is unnecessary: every state change notifies.
 */

type Listener = () => void;

const activeLeaves = new Map<number, string>(); // leafId -> projectId
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of listeners) l();
}

export function markTerminalActive(leafId: number, projectId: string): void {
  if (activeLeaves.get(leafId) === projectId) return;
  activeLeaves.set(leafId, projectId);
  notify();
}

export function markTerminalIdle(leafId: number): void {
  if (!activeLeaves.has(leafId)) return;
  activeLeaves.delete(leafId);
  notify();
}

/** Is any terminal command running in this project right now? */
export function projectHasRunningTerminal(projectId: string): boolean {
  for (const owner of activeLeaves.values()) {
    if (owner === projectId) return true;
  }
  return false;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React binding: re-renders when any project's terminal activity changes. */
export function useTerminalActivityVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => activeLeaves.size + [...activeLeaves.values()].join(",").length,
    () => 0,
  );
}

/** Live count of running command leaves for one project (re-renders on change). */
export function useProjectRunningTerminals(projectId: string): number {
  useSyncExternalStore(subscribe, () => activeLeaves.size, () => 0);
  let n = 0;
  for (const owner of activeLeaves.values()) if (owner === projectId) n++;
  return n;
}

/** Snapshot for non-React consumers (used when assembling rail items). */
export function runningTerminalProjects(): Set<string> {
  const set = new Set<string>();
  for (const owner of activeLeaves.values()) set.add(owner);
  return set;
}
