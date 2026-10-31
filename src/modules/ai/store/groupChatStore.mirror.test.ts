import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * BEHAVIORAL mirror-cycle suite (2026-11-01, 5th "agent replies outside the
 * group" report): the previous four rounds were SOURCE pins — they asserted
 * what the code LOOKED like, not what it DOES. Every round "passed" while the
 * user kept seeing the reply land in the project chat.
 *
 * This suite drives the REAL store through REAL sequences:
 *   delivery -> arm -> run -> reply -> resolveMirrorReply -> mirror -> consume
 *   -> next delivery (multi-turn conversation flow).
 *
 * The mirror gate lives in the STORE (resolveMirrorReply — pure,
 * non-consuming), so the exact causality contract the bridge enforces is
 * testable without React. The bridge's duty (verified by source pins in
 * groupChatStore.test.ts): call resolve on idle with (messages,
 * boundary, lastMirroredId), append + consume ONLY when it returns a mirror.
 */

vi.mock("@tauri-apps/plugin-store", () => {
  class FakeLazyStore {
    async get() { return null; }
    async set() {}
    async save() {}
  }
  return { LazyStore: FakeLazyStore };
});

const shared = vi.hoisted(() => ({
  metaStatus: "idle" as string,
  activeSessions: new Map<string, string>(),
  injectMessage: vi.fn(),
}));

vi.mock("./chatStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chatStore")>();
  return {
    ...actual,
    useChatStore: {
      getState: () => ({ injectMessage: shared.injectMessage }),
    },
    getSessionAgentMeta: () => ({ status: shared.metaStatus }),
    getProjectActiveSession: (id: string) =>
      shared.activeSessions.get(id) ?? `active-${id}`,
  };
});

import {
  __resetGroupChatsForTest,
  appendGroupMessage,
  createGroupChat,
  endGroupChat,
  getGroup,
  armReplyProvision,
  peekReplyProvision,
  resolveMirrorReply,
  sendGroupMessage,
  takeReplyProvision,
  type GroupChat,
} from "./groupChatStore";
import type { UIMessage } from "ai";

const injectMessageMock = shared.injectMessage;

/** Minimal UIMessage shape resolveMirrorReply consumes. */
function msg(id: string, role: "user" | "assistant", text?: string): UIMessage {
  return {
    id,
    createdAt: new Date(),
    role,
    parts: text === undefined ? [] : [{ type: "text", text }],
  } as unknown as UIMessage;
}

async function makeGroup(): Promise<GroupChat> {
  const g = await createGroupChat(
    { projectId: "proj-a", sessionId: "sess-a", root: "/a", name: "A" },
    [{ projectId: "proj-b", root: "/b", name: "B" }],
  );
  expect(g).not.toBeNull();
  return g as GroupChat;
}

beforeEach(() => {
  __resetGroupChatsForTest();
  injectMessageMock.mockReset();
  shared.metaStatus = "idle";
  shared.activeSessions.clear();
});

describe("delivery arms the mirror provision (the agent answers the delivery)", () => {
  it("an idle participant delivery injects the prefixed message and arms the provision", async () => {
    const g = await makeGroup();
    // proj-b resolves to a live session; the agent is idle.
    shared.activeSessions.set("proj-b", "sess-b");
    const out = await sendGroupMessage(g.id, "hello team");
    const b = out.find((r) => r.projectId === "proj-b");
    expect(b).toBeDefined();
    expect(b!.queued).toBe(false);
    // The injected text carries the group prefix (the agent sees the group).
    expect(injectMessageMock).toHaveBeenCalledWith(
      "sess-b",
      expect.stringContaining("hello team"),
    );
    // The provision is armed for the session that received the delivery.
    expect(peekReplyProvision("sess-b")).toBe(g.id);
  });

  it("a busy participant queues WITHOUT arming (no provision stealing)", async () => {
    const g = await makeGroup();
    shared.activeSessions.set("proj-b", "sess-b");
    shared.metaStatus = "streaming";
    const out = await sendGroupMessage(g.id, "hello team");
    expect(out.find((r) => r.projectId === "proj-b")!.queued).toBe(true);
    // Queue-time arming let a LOCAL run's reply claim/consume the provision
    // (2026-10-31 root cause #1). The queue path must stay unarmed.
    expect(peekReplyProvision("sess-b")).toBeNull();
  });
});

describe("resolveMirrorReply — the causality gate (pure, non-consuming)", () => {
  it("resolves the fresh reply for a provisioned session", async () => {
    const g = await makeGroup();
    armReplyProvision("sess-b", g.id);
    const boundary = "asst-old"; // what existed before the delivery
    const messages = [
      msg("user-1", "user", "[group] hello"),
      msg("asst-old", "assistant", "old reply"),
      msg("user-2", "user", "[group] hello team"),
      msg("asst-new", "assistant", "the real answer"),
    ];
    const m = resolveMirrorReply("sess-b", messages, boundary, null);
    expect(m).not.toBeNull();
    expect(m!.text).toBe("the real answer");
    expect(m!.assistantId).toBe("asst-new");
    expect(m!.group.id).toBe(g.id);
    // NON-CONSUMING: the provision survives (the bridge consumes at append).
    expect(peekReplyProvision("sess-b")).toBe(g.id);
  });

  it("returns null on a STALE messages array WITHOUT burning the provision (throttle race)", async () => {
    // THE 3rd REPORT'S ROOT CAUSE: status settles to ready BEFORE the
    // throttled final message lands. The bridge's first idle arm sees the
    // previous turn's reply as the last assistant — it must NOT consume.
    const g = await makeGroup();
    armReplyProvision("sess-b", g.id);
    const messages = [
      msg("user-1", "user", "[group] hello"),
      msg("asst-old", "assistant", "old reply"), // final flush not landed yet
    ];
    // busy-arm snapshot said "asst-old" was the boundary.
    expect(resolveMirrorReply("sess-b", messages, "asst-old", null)).toBeNull();
    // Provision STILL armed — the late flush can claim it on the re-run.
    expect(peekReplyProvision("sess-b")).not.toBeNull();
  });

  it("the late flush resolves and consumes; the cycle is recoverable", async () => {
    const g = await makeGroup();
    armReplyProvision("sess-b", g.id);
    // 1st arm (stale): nothing.
    expect(
      resolveMirrorReply("sess-b", [msg("asst-old", "assistant", "old")], "asst-old", null),
    ).toBeNull();
    // 2nd arm (messages now fresh from the throttle flush).
    const fresh = [
      msg("asst-old", "assistant", "old"),
      msg("asst-new", "assistant", "the real answer"),
    ];
    const m = resolveMirrorReply("sess-b", fresh, "asst-old", null);
    expect(m!.text).toBe("the real answer");
    // Bridge consumes at append:
    expect(takeReplyProvision("sess-b")).toBe(g.id);
    expect(peekReplyProvision("sess-b")).toBeNull();
  });

  it("an already-mirrored reply never mirrors twice", async () => {
    const g = await makeGroup();
    armReplyProvision("sess-b", g.id);
    const messages = [msg("asst-new", "assistant", "answer")];
    expect(
      resolveMirrorReply("sess-b", messages, "asst-old", "asst-new"),
    ).toBeNull();
    // Still armed (the bridge would not consume) — but a SECOND delivery
    // overwrites the provision for the next round.
    armReplyProvision("sess-b", g.id);
    expect(peekReplyProvision("sess-b")).toBe(g.id);
  });

  it("an ended group never mirrors (panel End keeps the group in the store)", async () => {
    const g = await makeGroup();
    armReplyProvision("sess-b", g.id);
    await endGroupChat(g.id);
    const messages = [msg("asst-new", "assistant", "answer")];
    expect(resolveMirrorReply("sess-b", messages, null, null)).toBeNull();
    expect(peekReplyProvision("sess-b")).not.toBeNull(); // resolve is pure
    // The error arm consumes regardless; idle must not resurrect the group.
    expect(takeReplyProvision("sess-b")).toBe(g.id);
  });

  it("a session with NO provision (local chat only) never leaks into the group", async () => {
    await makeGroup();
    const local = [msg("asst-local", "assistant", "local reply")];
    expect(resolveMirrorReply("sess-local", local, null, null)).toBeNull();
  });
});

describe("multi-turn conversation flow (delivery -> reply -> next delivery)", () => {
  it("a full natural back-and-forth: every turn mirrors, provisions re-arm each round", async () => {
    const g = await makeGroup();
    shared.activeSessions.set("proj-b", "sess-b");
    let boundary: string | null = null;
    let lastMirrored: string | null = null;
    let assistantSeq = 0;

    const driveTurn = async (userText: string): Promise<string> => {
      // 1. Coordinator sends -> delivery injects + arms the provision.
      await sendGroupMessage(g.id, userText);
      expect(peekReplyProvision("sess-b")).toBe(g.id);
      // 2. Busy-arm boundary snapshot (the bridge does this when the run
      //    starts): last assistant BEFORE this run.
      // 3. The agent runs and produces a fresh assistant message.
      assistantSeq += 1;
      const replyId = `asst-${assistantSeq}`;
      const history: UIMessage[] = [
        ...(assistantSeq > 1 ? [msg(`asst-${assistantSeq - 1}`, "assistant", "prior")] : []),
        msg("user", "user", userText),
        msg(replyId, "assistant", `answer to: ${userText}`),
      ];
      // 4. Idle arm resolves (stale-first is fine — provision survives),
      //    mirrors, and consumes.
      const m = resolveMirrorReply("sess-b", history, boundary, lastMirrored);
      expect(m, `turn ${assistantSeq} must resolve a mirror`).not.toBeNull();
      const appended = await appendGroupMessage(m!.group.id, {
        from: "agent",
        projectId: m!.projectId,
        sessionId: "sess-b",
        text: m!.text,
      });
      expect(appended!.projectId).toBe("proj-b");
      takeReplyProvision("sess-b"); // bridge consumes at the append
      boundary = replyId; // next busy-arm would snapshot past this reply
      lastMirrored = replyId;
      return m!.text;
    };

    expect(await driveTurn("what changed in the API?")).toBe("answer to: what changed in the API?");
    expect(await driveTurn("and the tests?")).toBe("answer to: and the tests?");
    expect(await driveTurn("ship it?")).toBe("answer to: ship it?");

    // Every turn is in the transcript, in order, attributed to proj-b.
    const live = getGroup(g.id)!;
    const agentMsgs = live.messages.filter((x) => x.from === "agent");
    expect(agentMsgs.map((x) => x.text)).toEqual([
      "answer to: what changed in the API?",
      "answer to: and the tests?",
      "answer to: ship it?",
    ]);
    // And the coordinator's turns interleaved (user messages present).
    expect(live.messages.filter((x) => x.from === "user")).toHaveLength(3);
    // Provision consumed at the end of the last turn.
    expect(peekReplyProvision("sess-b")).toBeNull();
  });
});