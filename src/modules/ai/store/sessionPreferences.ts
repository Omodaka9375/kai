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
  /** MEMORY-BLIND session (the /clean slash command, 2026-11-16): when
   *  true, this session's requests DO NOT load the project's MEMORY.md
   *  into the system prompt — a tabula-rasa view of the project. The FILE
   *  is untouched: every other session (and other agents) keep their
   *  memory. Per-session, persisted so the flag survives restarts.
   *  save_memory still works from this session (it writes the shared
   *  file — deliberate: knowledge discovered here should persist). */
  memoryClean?: boolean;
};

const store = new LazyStore("kai-session-preferences.json", { defaults: {}, autoSave: 200 });
const KEY = "sessions";
const PREF_KEY_PREFIX = "pref:";
const preferences = new Map<string, SessionPreferences>();
const EMPTY_PREFERENCES: SessionPreferences = {};
const listeners = new Set<() => void>();
let hydration: Promise<void> | null = null;
const dirtyIds = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 250;

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * PERF (2026-11-24): write only the CHANGED session's own key (`pref:<id>`)
 * on a 250ms debounce instead of serializing the entire cross-project map via
 * `Object.fromEntries(preferences)` on every draft keystroke. Legacy blobs
 * stored under the old `"sessions"` map still hydrate on boot; individual
 * `pref:<id>` keys take precedence over legacy entries on load.
 */
function schedulePersist(sessionId: string): void {
  dirtyIds.add(sessionId);
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDirtyPreferences();
  }, PERSIST_DEBOUNCE_MS);
}

function flushDirtyPreferences(): void {
  if (dirtyIds.size === 0) return;
  const batch = Array.from(dirtyIds);
  dirtyIds.clear();
  for (const id of batch) {
    const val = preferences.get(id);
    const key = `${PREF_KEY_PREFIX}${id}`;
    // Write `{}` tombstone on deletion instead of deleting the key: if an
    // older copy of `id` still sits in the legacy `"sessions"` map, an empty
    // object overlay supersedes it on the next hydrate so deletions stick.
    if (val) void store.set(key, val);
    else void store.set(key, {});
  }
}

export function hydrateSessionPreferences(): Promise<void> {
  hydration ??= (async () => {
    try {
      const saved = await store.get<Record<string, SessionPreferences>>(KEY);
      for (const [id, value] of Object.entries(saved ?? {})) {
        if (value && typeof value === "object" && Object.keys(value).length > 0) {
          preferences.set(id, value);
        }
      }
      // Overlay per-session keys written by the incremental persistence path.
      // Empty object = tombstone clearing any legacy entry for that session.
      const entries = typeof store.entries === "function" ? await store.entries() : [];
      for (const [k, value] of entries) {
        if (!k.startsWith(PREF_KEY_PREFIX)) continue;
        const id = k.slice(PREF_KEY_PREFIX.length);
        if (value && typeof value === "object") {
          if (Object.keys(value as Record<string, unknown>).length === 0) {
            preferences.delete(id);
          } else {
            preferences.set(id, value as SessionPreferences);
          }
        }
      }
      notify();
    } catch {
      // ignore hydration errors
    }
  })();
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
  schedulePersist(sessionId);
  notify();
}

export function removeSessionPreferences(sessionId: string): void {
  if (!preferences.delete(sessionId)) return;
  schedulePersist(sessionId);
  notify();
}

/** All session-id → preferences pairs (for sweeping stale references, e.g.
 *  clearing personaId pins that point at a deleted agent). */
export function allSessionPreferences(): Iterable<[string, SessionPreferences]> {
  return preferences.entries();
}

export function subscribeSessionPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
