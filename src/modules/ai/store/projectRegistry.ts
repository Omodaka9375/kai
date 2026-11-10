import type { ModelId } from "../config";
import { DEFAULT_MODEL_ID } from "../config";
import type { ChatRuntimeDeps } from "../lib/chatRuntime";

/**
 * Project registry — the per-project registries + active-project signals,
 * extracted from chatStore.ts (2026-11-10 god-file cleanup).
 *
 * INVARIANT: no zustand reads, no imports of chatStore here. These maps are
 * written by App/workspaceActivation (project lifecycle) and read by
 * chatStore's live resolution (makeChatSync) and the multi-project surfaces.
 * chatStore imports THIS module, never the reverse — keeping that direction
 * is what avoids the module cycle (the chatPinner inversion exists precisely
 * because groupChatStore could not import chatStore).
 *
 * Reactive contract: activeProjectRuntime is module state — a project switch
 * bumps no zustand field. Cross-project surfaces that read activeProjectId()
 * imperatively (AiMiniWindow's group-pill strip reservation) subscribe via
 * subscribeActiveProject + getActiveProjectVersion (useSyncExternalStore),
 * so a switch re-renders them instead of freezing their last memo
 * (2026-11-01: the frozen lift = the empty-strip gap).
 */

/** Active-window runtime for legacy/global callers. Each project installs
 *  its own runtime while its chats are being created/hydrated. */
let activeProjectRuntime: import("@/modules/workspace").ProjectRuntime | undefined;
const projectRuntimes = new Map<string, import("@/modules/workspace").ProjectRuntime>();
const projectLive = new Map<string, ChatRuntimeDeps["live"]>();
const projectModels = new Map<string, ModelId>();
const projectPersonas = new Map<string, string>();

// Reactive signal for the ACTIVE PROJECT (see header comment).
const activeProjectListeners = new Set<() => void>();
let activeProjectVersion = 0;

/** The per-project "which session is open" map (the project-local activeId
 *  for multi-project: the foreground activeSessionId belongs to the visible
 *  project; background projects keep their own). */
const projectActiveSessions = new Map<string, string | null>();
const projectActiveSessionListeners = new Set<() => void>();

export function setActiveProjectRuntime(
  runtime: import("@/modules/workspace").ProjectRuntime,
): void {
  const changed = activeProjectRuntime?.id !== runtime.id;
  activeProjectRuntime = runtime;
  projectRuntimes.set(runtime.id, runtime);
  if (changed) {
    activeProjectVersion++;
    for (const listener of activeProjectListeners) listener();
  }
}
export function getActiveProjectRuntime():
  | import("@/modules/workspace").ProjectRuntime
  | undefined {
  return activeProjectRuntime;
}
export function registerProjectRuntime(
  runtime: import("@/modules/workspace").ProjectRuntime,
): void {
  projectRuntimes.set(runtime.id, runtime);
}
/** All registered project runtimes (open workspaces). Used by the group
 *  invite tool to describe which PROJECTS can be invited into a group. */
export function getAllProjectRuntimes(): Array<
  import("@/modules/workspace").ProjectRuntime
> {
  return [...projectRuntimes.values()];
}
/** True when the project workspace is currently OPEN (runtime registered).
 *  Group deliveries use this to distinguish "open but no active session
 *  YET" (safe to deliver into the persisted session id - the project's
 *  bridge is mounting) from "project CLOSED since the record was written"
 *  (the persisted id is stale - delivering into it fabricates a chat no
 *  bridge watches: the run fires, the reply never mirrors, and the panel
 *  still reports "delivered"). 2026-11-02 group-chat audit SHOULD. */
export function isProjectOpen(projectId: string): boolean {
  return projectRuntimes.has(projectId);
}

/** Direct runtime lookup (a registered-but-not-active project). */
export function getProjectRuntime(
  projectId: string,
): import("@/modules/workspace").ProjectRuntime | undefined {
  return projectRuntimes.get(projectId);
}

/** Bind live UI handles to their owning project, not the foreground window. */
export function setProjectLive(
  projectId: string,
  live: ChatRuntimeDeps["live"],
): void {
  projectLive.set(projectId, live);
}
export function getProjectLive(
  projectId: string,
): ChatRuntimeDeps["live"] | undefined {
  return projectLive.get(projectId);
}
export function setProjectModel(
  projectId: string,
  model: ModelId,
  personaId: string,
): void {
  projectModels.set(projectId, model);
  projectPersonas.set(projectId, personaId);
}
export function getProjectModel(
  projectId: string,
  fallback: ModelId = DEFAULT_MODEL_ID,
): ModelId {
  return projectModels.get(projectId) ?? fallback;
}
export function getProjectPersona(projectId: string): string | undefined {
  return projectPersonas.get(projectId);
}

/** The currently ACTIVE project id (null when no project is open).
 *  Used by cross-project surfaces (watch firings) to decide whether an
 *  event lands in the project the user is looking at. */
export function activeProjectId(): string | null {
  return activeProjectRuntime?.id ?? null;
}

export function subscribeActiveProject(listener: () => void): () => void {
  activeProjectListeners.add(listener);
  return () => activeProjectListeners.delete(listener);
}
export function getActiveProjectVersion(): number {
  return activeProjectVersion;
}

export function subscribeProjectActiveSessions(
  listener: () => void,
): () => void {
  projectActiveSessionListeners.add(listener);
  return () => projectActiveSessionListeners.delete(listener);
}
export function getProjectActiveSession(projectId: string): string | null {
  return projectActiveSessions.get(projectId) ?? null;
}
export function setProjectActiveSession(
  projectId: string,
  sessionId: string | null,
): void {
  if (projectActiveSessions.get(projectId) === sessionId) return;
  projectActiveSessions.set(projectId, sessionId);
  for (const listener of projectActiveSessionListeners) listener();
}
