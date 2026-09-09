import type { UIMessage } from "@ai-sdk/react";
import { LazyStore } from "@tauri-apps/plugin-store";

export type SessionMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  parentId?: string;
  forkMessageIndex?: number;
  workspaceRoot?: string | null;
  /** Last observed message count, used to bump `updatedAt` only on real growth. */
  lastMessageCount?: number;
};

const STORE_PATH = "kai-sessions.json";
const KEY_SESSIONS = "sessions";
const KEY_ACTIVE = "activeId";
const MIGRATION_MARKER = "__migrated_to_projects__";
const messagesKey = (id: string) => `messages:${id}`;

// The active store. Swapped by `setSessionsScope` to a per-project file so two
// concurrent KAI instances on different projects never clobber each other's
// chat history — the store writes the whole JSON file on every save(), so a
// shared file makes parallel sessions a last-writer-wins data race.
let store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });
let currentScopePath: string | null = null;

function normalizeRoot(root: string | null | undefined): string | null {
  const n = root?.replace(/\\/g, "/").replace(/\/+$/, "");
  return n && n.length > 0 ? n : null;
}

/** Stable 64-bit FNV-1a (base36) of a workspace path — compact, filename-safe. */
function projectKey(root: string | null | undefined): string | null {
  const n = normalizeRoot(root);
  if (!n) return null;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < n.length; i++) {
    h ^= BigInt(n.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(36);
}

function scopedPath(root: string | null | undefined): string {
  const key = projectKey(root);
  return key ? `kai-sessions-${key}.json` : STORE_PATH;
}

/**
 * Point all subsequent session reads/writes at the store for `root`.
 * No-op if already scoped to that path. Called before hydration on boot and on
 * workspace switch. Flushes any pending autoSave before swapping so a debounced
 * write for the previous project isn't dropped.
 */
export async function setSessionsScope(
  root: string | null | undefined,
): Promise<void> {
  const path = scopedPath(root);
  if (path === currentScopePath) return;
  try {
    await store.save();
  } catch {
    // store may never have been written; ignore.
  }
  currentScopePath = path;
  store = new LazyStore(path, { defaults: {}, autoSave: 200 });
}

/** One-time migration helper — runs once per process, idempotent via marker. */
let migrationPromise: Promise<void> | null = null;

export function ensureMigratedOnce(): Promise<void> {
  if (!migrationPromise) migrationPromise = migrateLegacyToProjects();
  return migrationPromise;
}

/**
 * Split the legacy single-file `kai-sessions.json` (mixed workspaces) into
 * per-project files. Sessions with no workspaceRoot stay in the legacy/global
 * file. Runs once; guarded by a marker inside the legacy store so it never
 * re-runs and never destroys data (the source file is trimmed, not deleted).
 */
async function migrateLegacyToProjects(): Promise<void> {
  const legacy = new LazyStore(STORE_PATH, { defaults: {} });
  const already = await legacy.get<boolean>(MIGRATION_MARKER).catch(() => false);
  if (already) return;

  const sessions =
    (await legacy.get<SessionMeta[]>(KEY_SESSIONS).catch(() => null)) ?? [];
  const activeId =
    (await legacy.get<string | null>(KEY_ACTIVE).catch(() => null)) ?? null;

  if (sessions.length === 0) {
    await legacy.set(MIGRATION_MARKER, true);
    await legacy.save().catch(() => {});
    return;
  }

  // Group non-global sessions by project key.
  const groups = new Map<string, SessionMeta[]>();
  for (const s of sessions) {
    const key = projectKey(s.workspaceRoot);
    if (!key) continue; // null-root sessions stay in the legacy (global) file
    const arr = groups.get(key);
    if (arr) arr.push(s);
    else groups.set(key, [s]);
  }

  for (const [key, members] of groups) {
    const target = new LazyStore(`kai-sessions-${key}.json`, {
      defaults: {},
      autoSave: 200,
    });
    const existing =
      (await target.get<SessionMeta[]>(KEY_SESSIONS).catch(() => null)) ?? [];
    const existingIds = new Set(existing.map((x) => x.id));
    const merged = [
      ...existing,
      ...members.filter((m) => !existingIds.has(m.id)),
    ];
    await target.set(KEY_SESSIONS, merged);
    for (const m of members) {
      const msgs = await legacy.get<unknown>(messagesKey(m.id)).catch(() => null);
      if (msgs != null) await target.set(messagesKey(m.id), msgs);
    }
    // Preserve the last-active session within its migrated project.
    if (activeId && members.some((m) => m.id === activeId)) {
      await target.set(KEY_ACTIVE, activeId);
    }
    await target.save().catch(() => {});
  }

  // Trim the legacy file to global (unscoped) sessions only.
  const remaining = sessions.filter((s) => !projectKey(s.workspaceRoot));
  await legacy.set(KEY_SESSIONS, remaining);
  if (activeId && !remaining.some((s) => s.id === activeId)) {
    await legacy.set(KEY_ACTIVE, null);
  }
  await legacy.set(MIGRATION_MARKER, true);
  await legacy.save().catch(() => {});
}

export type LoadedSessions = {
  sessions: SessionMeta[];
  activeId: string | null;
};

const MAX_MESSAGES_JSON_BYTES = 512 * 1024;

export async function loadAll(): Promise<LoadedSessions> {
  // Two targeted get()s instead of entries() — entries() deserializes the
  // entire store including every messages:<id> blob, which grows to
  // multiple MB across projects and freezes the webview.
  let sessions: SessionMeta[] = [];
  let activeId: string | null = null;
  try {
    const [raw, rawActive] = await Promise.all([
      store.get<SessionMeta[]>(KEY_SESSIONS),
      store.get<string | null>(KEY_ACTIVE),
    ]);
    sessions = raw ?? [];
    activeId = rawActive ?? null;
  } catch (err) {
    console.error(
      "[loadAll] Corrupted store data — resetting sessions:",
      err,
    );
    // Corrupted JSON or mismatched schema. Return empty state so the app
    // can boot cleanly instead of crashing the React tree.
  }
  // Validate that activeId exists in the session list. If the store was
  // partially written, activeId may reference a deleted session.
  if (activeId && !sessions.some((s) => s.id === activeId)) {
    console.warn(
      "[loadAll] activeId references unknown session — clearing:",
      activeId,
    );
    activeId = null;
  }
  return { sessions, activeId };
}

export async function loadMessages(id: string): Promise<UIMessage[] | null> {
  try {
    const raw = await store.get<unknown>(messagesKey(id));
    if (!raw) return null;
    // Basic shape validation: must be an array of objects with a `role` field.
    if (!Array.isArray(raw)) {
      console.warn("[loadMessages] Corrupted — not an array:", id);
      return null;
    }
    if (raw.length > 0 && typeof raw[0] !== "object") {
      console.warn("[loadMessages] Corrupted — items are not objects:", id);
      return null;
    }
    return raw as UIMessage[];
  } catch (err) {
    console.error("[loadMessages] Failed to load — resetting:", id, err);
    return null;
  }
}

export async function saveSessionsList(sessions: SessionMeta[]): Promise<void> {
  await store.set(KEY_SESSIONS, sessions);
}

export async function saveActiveId(id: string | null): Promise<void> {
  await store.set(KEY_ACTIVE, id);
}

/**
 * Strip large inline data (image data-URLs) from file parts before persisting.
 * Operates on plain JSON objects (after JSON round-trip), not UIMessage types.
 */
function stripInlineImagesInPlace(items: unknown[]): void {
  const DATA_URL_RE = /^data:[^;]+;base64,/;
  for (const m of items) {
    if (m == null || typeof m !== "object") continue;
    const msg = m as Record<string, unknown>;
    if (msg.role !== "user") continue;
    if (!Array.isArray(msg.parts)) continue;
    for (const p of msg.parts) {
      if (p == null || typeof p !== "object") continue;
      const part = p as Record<string, unknown>;
      if (part.type === "file" && typeof part.url === "string" && DATA_URL_RE.test(part.url)) {
        part.url = `data:${part.mediaType ?? "image/png"};base64,`;
      }
    }
  }
}

export async function saveMessages(
  id: string,
  messages: UIMessage[],
): Promise<void> {
  // Deep-clone via JSON round-trip to strip any non-serializable values
  // (undefined, BigInt, Symbol, functions, circular refs) that would
  // produce corrupted or unreadable store data.
  let toStore: unknown[];
  try {
    toStore = JSON.parse(JSON.stringify(messages));
  } catch (err) {
    console.error(
      "[saveMessages] Messages contain non-serializable data — skipping persist:",
      err,
    );
    return;
  }

  // Strip image data-URLs to keep the store file compact.
  stripInlineImagesInPlace(toStore);

  // Guard against unbounded growth — if the serialized JSON exceeds
  // MAX_MESSAGES_JSON_BYTES, trim to the most recent messages. Without
  // this, a single session can balloon the store file to multiple MB
  // and cause the same freeze on the next launch.
  let json = JSON.stringify(toStore);
  if (json.length > MAX_MESSAGES_JSON_BYTES) {
    // Keep the most recent messages that fit under the cap.
    let lo = 0;
    let hi = toStore.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const slice = toStore.slice(-mid);
      if (JSON.stringify(slice).length <= MAX_MESSAGES_JSON_BYTES) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    toStore = toStore.slice(-lo || -1);
    json = JSON.stringify(toStore);
  }

  // Verify the JSON round-trips before persisting. If it fails, the data
  // is fundamentally unserializable — don't write it.
  try {
    JSON.parse(json);
  } catch (err) {
    console.error(
      "[saveMessages] Produced invalid JSON — skipping persist:",
      err,
    );
    return;
  }

  await store.set(messagesKey(id), toStore as UIMessage[]);
}

export async function deleteSessionData(id: string): Promise<void> {
  await store.delete(messagesKey(id));
}

export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Fork a session at a specific message index.
 * Creates a new session with messages from the source up to (and including) atMessageIndex.
 */
export async function forkSession(
  sourceId: string,
  atMessageIndex: number,
): Promise<{ newId: string; messages: UIMessage[] }> {
  const source = await loadMessages(sourceId);
  if (!source) throw new Error("source session not found");
  if (atMessageIndex < 0 || atMessageIndex >= source.length) {
    throw new Error(`invalid message index: ${atMessageIndex}`);
  }
  const forkedMessages = source.slice(0, atMessageIndex + 1);
  const newId = newSessionId();
  await saveMessages(newId, forkedMessages);
  return { newId, messages: forkedMessages };
}

export function deriveTitle(messages: UIMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts) {
      if (p.type !== "text") continue;
      const text = (p as { text: string }).text
        .replace(/<terminal-context[\s\S]*?<\/terminal-context>\s*/g, "")
        .replace(/<selection[\s\S]*?<\/selection>\s*/g, "")
        .replace(/<file[\s\S]*?<\/file>\s*/g, "")
        .replace(/<snippet[\s\S]*?<\/snippet>\s*/g, "")
        .replace(/<Kai-command[^>]*\/>\s*/g, "")
        .trim();
      if (!text) continue;
      const first = text.split("\n")[0].trim();
      return first.length > 40 ? `${first.slice(0, 40)}…` : first;
    }
  }
  return "New chat";
}
