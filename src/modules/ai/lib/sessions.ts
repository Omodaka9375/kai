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

const MAX_MESSAGES_JSON_BYTES = 512 * 1024;

export async function loadAll(): Promise<LoadedSessions> {
  // Two targeted get()s instead of entries() — entries() deserializes the
  // entire store including every messages:<id> blob, which grows to
  // multiple MB across projects and freezes the webview.
  const [sessions, activeId] = await Promise.all([
    store.get<SessionMeta[]>(KEY_SESSIONS),
    store.get<string | null>(KEY_ACTIVE),
  ]);
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
  const stripped = stripInlineImages(messages);
  // Guard against unbounded growth — if the serialized JSON exceeds
  // MAX_MESSAGES_JSON_BYTES, trim to the most recent messages. Without
  // this, a single session can balloon the store file to multiple MB
  // and cause the same freeze on the next launch.
  let toStore: UIMessage[] = stripped;
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
  await store.set(messagesKey(id), toStore);
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
