import type { UIMessage } from "@ai-sdk/react";
import { LazyStore } from "@tauri-apps/plugin-store";

export type SessionMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  parentId?: string;
  forkMessageIndex?: number;
};

const STORE_PATH = "kai-sessions.json";
const KEY_SESSIONS = "sessions";
const KEY_ACTIVE = "activeId";
const messagesKey = (id: string) => `messages:${id}`;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export type LoadedSessions = {
  sessions: SessionMeta[];
  activeId: string | null;
};

export async function loadAll(): Promise<LoadedSessions> {
  // One IPC roundtrip via entries() rather than two parallel get()s. Per-
  // session messages are loaded lazily via `loadMessages` only when a
  // session is opened, so cold boot stays at a single store call.
  const entries = await store.entries();
  let sessions: SessionMeta[] | undefined;
  let activeId: string | null | undefined;
  for (const [k, v] of entries) {
    if (k === KEY_SESSIONS) sessions = v as SessionMeta[];
    else if (k === KEY_ACTIVE) activeId = v as string | null;
  }
  return { sessions: sessions ?? [], activeId: activeId ?? null };
}

export async function loadMessages(id: string): Promise<UIMessage[] | null> {
  return (await store.get<UIMessage[]>(messagesKey(id))) ?? null;
}

export async function saveSessionsList(sessions: SessionMeta[]): Promise<void> {
  await store.set(KEY_SESSIONS, sessions);
}

export async function saveActiveId(id: string | null): Promise<void> {
  await store.set(KEY_ACTIVE, id);
}

/**
 * Strip large inline data (image data-URLs) from file parts before persisting.
 * Replaces the data URL with a placeholder so the store file stays small.
 */
function stripInlineImages(messages: UIMessage[]): UIMessage[] {
  const DATA_URL_RE = /^data:[^;]+;base64,/;
  return messages.map((m) => {
    if (m.role !== "user") return m;
    const hasFile = m.parts.some(
      (p) =>
        (p as { type: string }).type === "file" &&
        typeof (p as { url?: string }).url === "string" &&
        DATA_URL_RE.test((p as { url: string }).url),
    );
    if (!hasFile) return m;
    return {
      ...m,
      parts: m.parts.map((p) => {
        const fp = p as { type: string; url?: string; mediaType?: string };
        if (
          fp.type === "file" &&
          typeof fp.url === "string" &&
          DATA_URL_RE.test(fp.url)
        ) {
          return { ...fp, url: `data:${fp.mediaType ?? "image/png"};base64,` };
        }
        return p;
      }),
    } as UIMessage;
  });
}

export async function saveMessages(
  id: string,
  messages: UIMessage[],
): Promise<void> {
  await store.set(messagesKey(id), stripInlineImages(messages));
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
        .trim();
      if (!text) continue;
      const first = text.split("\n")[0].trim();
      return first.length > 40 ? `${first.slice(0, 40)}…` : first;
    }
  }
  return "New chat";
}
