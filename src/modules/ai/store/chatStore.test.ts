/**
 * Regression tests for three historical bug classes in the session/Chat
 * lifecycle (see KAI memory / git history):
 *
 *  1. stop-during-approval  — `Chat.stop()` is a no-op while status is
 *     `ready` (paused on a tool approval). `stopSession` must also strip
 *     the orphaned `approval-requested` part or the session stays busy
 *     forever (Stop button dead, sends blocked).
 *  2. fork-from-live-array   — `forkSession` must slice the LIVE in-memory
 *     conversation, not the persisted snapshot (which is 512KB-trimmed and
 *     can lag the debounced persist — the old path threw "invalid message
 *     index" and silently did nothing).
 *  3. hydrate-active-session — `hydrateSessions` must seed the restored
 *     active session's history BEFORE flipping `activeSessionId`, and strip
 *     orphaned approval parts at the PART level on load. The old bug built
 *     an EMPTY Chat first, and the session opened blank forever.
 *
 * The persistence layer (lib/sessions), the agent transport, and the Tauri
 * IPC boundary are mocked; the real zustand store and real
 * `@ai-sdk/react` Chat instances are exercised.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import type { SessionMeta } from "../lib/sessions";
import { loadAll, loadMessages } from "../lib/sessions";
import { getOrCreateChat, stopSession, useChatStore } from "./chatStore";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, invoke: vi.fn(async () => undefined) };
});

// Settings/preferences syncs across windows via Tauri events — stub the
// event API so importing the store chain outside the webview stays inert.
vi.mock("@tauri-apps/api/event", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    emit: vi.fn(async () => undefined),
    listen: vi.fn(async () => () => undefined),
  };
});

vi.mock("../lib/transport", () => ({
  createContextAwareTransport: vi.fn(() => ({ sendMessages: vi.fn() })),
  clearFenceState: vi.fn(),
}));

vi.mock("../tools/shell", () => ({
  cancelAllShellSessions: vi.fn(),
}));

vi.mock("../tools/watch", () => ({
  reapSessionWatches: vi.fn(),
  closeWatchSessionShell: vi.fn(),
}));

vi.mock("../lib/sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sessions")>();
  return {
    ...actual,
    // Pure helpers (newSessionId, deriveTitle, partitionSessionsByWorkspace)
    // stay real via the spread above. Everything that touches the plugin-store
    // is stubbed; tests override the resolved values as needed.
    ensureMigratedOnce: vi.fn(async () => {}),
    setSessionsScope: vi.fn(async () => {}),
    loadAll: vi.fn(async () => ({ sessions: [], activeId: null })),
    loadMessages: vi.fn(async () => null),
    saveMessages: vi.fn(async () => {}),
    saveSessionsList: vi.fn(async () => {}),
    saveActiveId: vi.fn(async () => {}),
    deleteSessionData: vi.fn(async () => {}),
    // The persisted-snapshot fork path must never run — the live-array path
    // is the contract under test. Fail loudly if it does.
    forkSession: vi.fn(async () => {
      throw new Error("unexpected fallback to persisted fork");
    }),
  };
});

function userMsg(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage;
}

/** Assistant message whose last tool call never got a response — the
 *  orphaned `approval-requested` part that pins a session busy. */
function assistantWithOrphanTool(id: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      { type: "text", text: "I need to write a file." },
      {
        type: "tool-write_file",
        toolCallId: `${id}-tc`,
        state: "approval-requested",
        input: { path: "x.txt", content: "hi" },
        approval: { id: `${id}-ap`, message: "Allow write?" },
      },
    ],
  } as unknown as UIMessage;
}

function meta(
  id: string,
  title = "New chat",
  workspaceRoot: string | null = null,
): SessionMeta {
  return { id, title, createdAt: 1, updatedAt: 1, workspaceRoot };
}

function parts(m: UIMessage): { type: string; state?: string }[] {
  return m.parts as unknown as { type: string; state?: string }[];
}

beforeEach(() => {
  vi.clearAllMocks();
  (loadAll as Mock).mockResolvedValue({ sessions: [], activeId: null });
  (loadMessages as Mock).mockResolvedValue(null);
  useChatStore.setState({
    sessions: [],
    activeSessionId: null,
    sessionsHydrated: false,
    lastHydratedWorkspace: null,
  });
  useChatStore.getState().resetAgentMeta();
});

describe("stop-during-approval regression", () => {
  it("stopSession strips an orphaned approval-requested part and frees the session", async () => {
    const sid = "sess-stop-approval";
    const chat = getOrCreateChat(sid);
    chat.messages = [userMsg("u1", "write a file"), assistantWithOrphanTool("a1")];
    useChatStore.setState({ activeSessionId: sid });

    stopSession(sid);

    // chat.stop() is async and a no-op in `ready` — releasePendingApprovals
    // runs in its .finally, so poll until the part is gone.
    await vi.waitFor(() => {
      expect(
        parts(chat.messages[1]!).some((p) => p.state === "approval-requested"),
      ).toBe(false);
    });
    // Part-level strip: the assistant's visible text survives, and the
    // message is not dropped wholesale.
    expect(parts(chat.messages[1]!).some((p) => p.type === "text")).toBe(true);
    expect(chat.messages).toHaveLength(2);
  });
});

describe("fork-from-live-array regression", () => {
  it("forkSession slices the LIVE conversation, not the persisted snapshot", async () => {
    const sid = "sess-fork-live";
    const chat = getOrCreateChat(sid);
    chat.messages = [
      userMsg("f0", "one"),
      assistantWithOrphanTool("f1"),
      userMsg("f2", "two"),
      userMsg("f3", "three"),
      userMsg("f4", "four"),
    ];
    useChatStore.setState({
      activeSessionId: sid,
      sessions: [meta(sid, "Conversation")],
    });

    const newId = await useChatStore.getState().forkSession(2);

    // The old bug read the persisted snapshot and silently threw → null.
    expect(newId).toBeTypeOf("string");
    expect(useChatStore.getState().activeSessionId).toBe(newId);

    const forkMeta = useChatStore
      .getState()
      .sessions.find((s) => s.id === newId);
    expect(forkMeta?.parentId).toBe(sid);

    // The fork's chat is seeded with exactly the first 3 LIVE messages,
    // with the orphaned approval part stripped at part level.
    const forked = getOrCreateChat(newId!);
    expect(forked.messages).toHaveLength(3);
    expect(
      parts(forked.messages[1]!).some((p) => p.state === "approval-requested"),
    ).toBe(false);
    expect(parts(forked.messages[1]!).some((p) => p.type === "text")).toBe(true);
  });
});

describe("hydrate-active-session regression", () => {
  it("seeds the restored active session's history before activating it, stripped at part level", async () => {
    const sid = "sess-hydrate-active";
    (loadAll as Mock).mockResolvedValue({
      sessions: [meta(sid, "Prior conversation")],
      activeId: sid,
    });
    (loadMessages as Mock).mockResolvedValue([
      userMsg("h0", "hello"),
      assistantWithOrphanTool("h1"),
    ]);

    await useChatStore.getState().hydrateSessions("D:/Code/2026/KAI");

    expect(useChatStore.getState().activeSessionId).toBe(sid);

    // Constructing the chat consumes the seed — it must carry the persisted
    // history. The old bug flipped activeSessionId first, so the chat was
    // created EMPTY and the session opened blank forever.
    const chat = getOrCreateChat(sid);
    expect(chat.messages).toHaveLength(2);
    expect(
      parts(chat.messages[1]!).some((p) => p.state === "approval-requested"),
    ).toBe(false);
    expect(parts(chat.messages[1]!).some((p) => p.type === "text")).toBe(true);
  });
});
