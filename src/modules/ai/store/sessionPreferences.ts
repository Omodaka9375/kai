import { LazyStore } from "@tauri-apps/plugin-store";
import type { ModelId } from "../config";

export type SessionPreferences = {
  /** Runtime identity; allows the project control center to group sessions
   *  even before their project has hydrated its persisted session list. */
  projectId?: string;
  modelId?: ModelId;
  personaId?: string;
  archivedAt?: number;
  draft?: string;
};

const store = new LazyStore("kai-session-preferences.json", { defaults: {}, autoSave: 200 });
const KEY = "sessions";
const preferences = new Map<string, SessionPreferences>();
const EMPTY_PREFERENCES: SessionPreferences = {};
const listeners = new Set<() => void>();
let hydration: Promise<void> | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

function persist(): void {
  void store.set(KEY, Object.fromEntries(preferences));
}

export function hydrateSessionPreferences(): Promise<void> {
  hydration ??= store.get<Record<string, SessionPreferences>>(KEY)
    .then((saved) => {
      for (const [id, value] of Object.entries(saved ?? {})) {
        if (value && typeof value === "object") preferences.set(id, value);
      }
      notify();
    })
    .catch(() => undefined);
  return hydration;
}

export function getSessionPreferences(sessionId: string): SessionPreferences {
  return preferences.get(sessionId) ?? EMPTY_PREFERENCES;
}

export function setSessionPreferences(
  sessionId: string,
  patch: Partial<SessionPreferences>,
): void {
  const current = preferences.get(sessionId) ?? {};
  if (Object.entries(patch).every(([key, value]) => current[key as keyof SessionPreferences] === value)) return;
  const next = { ...current, ...patch };
  // Undefined means "clear this optional override", not a persisted null.
  for (const key of Object.keys(next) as Array<keyof SessionPreferences>) {
    if (next[key] === undefined) delete next[key];
  }
  if (Object.keys(next).length === 0) preferences.delete(sessionId);
  else preferences.set(sessionId, next);
  persist();
  notify();
}

export function removeSessionPreferences(sessionId: string): void {
  if (!preferences.delete(sessionId)) return;
  persist();
  notify();
}

export function subscribeSessionPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
