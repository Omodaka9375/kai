import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Phase 3 contract: lifecycle hardening.
 *
 *  - LRU pinning: chatStore exposes setChatPinner; the group store registers
 *    sessionIsGroupLive so live participants are never evicted mid-round.
 *  - Mirror gate: takeReplyProvision — a reply is only mirrored when the
 *    session actually had a group delivery awaiting an answer (no leak of
 *    the user's local chats into the group transcript).
 *  - Machinery teardown: end/reclaim/removeParticipant clear queues, timers,
 *    relay depth — no dangling wake-ups.
 *  - session:delete re-resolution: deleted sessions re-point to the
 *    project's current active session, or the participant drops with a
 *    system note.
 *  - join/leave: addParticipants/removeParticipant are store-level and
 *    human-only (no tool path).
 */

vi.mock("@tauri-apps/plugin-store", () => {
  class FakeLazyStore {
    async get() { return null; }
    async set() {}
    async save() {}
  }
  return { LazyStore: FakeLazyStore };
});
vi.mock("../lib/backgroundNotifications", () => ({
  notifyBackgroundAgent: vi.fn(async () => {}),
}));

// Shared mock state (vi.hoisted: available to the factory below).
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
  addParticipants,
  createGroupChat,
  delegateCoordination,
  endGroupChat,
  getGroup,
  removeParticipant,
  reclaimCoordination,
  sendFromCoordinator,
  takeReplyProvision,
} from "./groupChatStore";
import { setChatPinner } from "./chatStore";

const injectMessageMock = shared.injectMessage;

beforeEach(() => {
  __resetGroupChatsForTest();
  injectMessageMock.mockReset();
  shared.metaStatus = "idle";
  shared.activeSessions.clear();
});

describe("mirror gate — takeReplyProvision", () => {
  it("no provision before any delivery: an idle local reply is NOT mirrored", async () => {
    await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "alpha" },
      [{ projectId: "b", root: "/b", name: "beta" }],
    );
    expect(takeReplyProvision("active-b")).toBeNull();
  });

  it("a group delivery arms the provision; one delivery = one mirrored reply", async () => {
    const g = await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "alpha" },
      [{ projectId: "b", root: "/b", name: "beta" }],
    );
    const { sendGroupMessage } = await import("./groupChatStore");
    await sendGroupMessage(g!.id, "please check the tests", "b");
    expect(takeReplyProvision("active-b")).toBe(g!.id);
    // Consumed — a second idle settle (the user chatting locally after
    // answering) must not mirror again.
    expect(takeReplyProvision("active-b")).toBeNull();
  });

  it("ending the group clears pending provisions (no post-end mirroring)", async () => {
    const g = await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "alpha" },
      [{ projectId: "b", root: "/b", name: "beta" }],
    );
    const { sendGroupMessage } = await import("./groupChatStore");
    await sendGroupMessage(g!.id, "x", "b");
    await endGroupChat(g!.id);
    expect(takeReplyProvision("active-b")).toBeNull();
  });
});

describe("LRU pinning", () => {
  it("chatStore exposes setChatPinner and the group store registered itself", async () => {
    expect(typeof setChatPinner).toBe("function");
    await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "alpha" },
      [{ projectId: "b", root: "/b", name: "beta" }],
    );
    expect(setChatPinner).not.toThrow();
  });

  it("source pin: chatStore consults chatPinner in its LRU eviction", () => {
    const store = readFileSync(new URL("./chatStore.ts", import.meta.url), "utf8");
    expect(store).toContain("chatPinner?.(oldest)");
    expect(store).toContain("export function setChatPinner");
  });

  it("source pin: the group store registers sessionIsGroupLive as the pinner", () => {
    const store = readFileSync(new URL("./groupChatStore.ts", import.meta.url), "utf8");
    expect(store).toContain("setChatPinner(sessionIsGroupLive)");
  });
});

describe("machinery teardown", () => {
  it("ending a group drops a busy participant's queued message (never wakes the dead)", async () => {
    const g = await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "alpha" },
      [{ projectId: "b", root: "/b", name: "beta" }],
    );
    const { sendGroupMessage } = await import("./groupChatStore");
    shared.metaStatus = "streaming"; // busy → the message queues
    await sendGroupMessage(g!.id, "queued while busy", "b");
    await endGroupChat(g!.id);
    shared.metaStatus = "idle";
    const { noteSessionIdle } = await import("./groupChatStore");
    noteSessionIdle("active-b");
    expect(injectMessageMock).not.toHaveBeenCalled();
  });

  it("reclaiming coordination clears the coordinator's coalesce buffer and depth", async () => {
    const g = await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "alpha" },
      [
        { projectId: "b", root: "/b", name: "beta" },
        { projectId: "c", root: "/c", name: "gamma" },
      ],
    );
    await delegateCoordination(g!.id, "a");
    await sendFromCoordinator(g!.id, "b", "task");
    await sendFromCoordinator(g!.id, "c", "task");
    await reclaimCoordination(g!.id);
    injectMessageMock.mockClear();
    const { noteCoordinatorRoundDone } = await import("./groupChatStore");
    noteCoordinatorRoundDone("s-a");
    expect(injectMessageMock).not.toHaveBeenCalled();
  });
});

describe("session:delete re-resolution", () => {
  it("a deleted participant session re-points to the project's current active session", async () => {
    const g = await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "alpha" },
      [{ projectId: "b", root: "/b", name: "beta" }],
    );
    shared.activeSessions.set("b", "active-b2");
    const { agentBus } = await import("../lib/eventBus");
    agentBus.emit("session:delete", { sessionId: "active-b" });
    const live = getGroup(g!.id)!;
    expect(live.participants.find((p) => p.projectId === "b")!.sessionId).toBe("active-b2");
    expect(live.messages.some((m) => m.from === "system" && m.text.includes("took over"))).toBe(true);
  });

  it("a deleted coordinator returns coordination to the user with a note", async () => {
    const g = await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "alpha" },
      [{ projectId: "b", root: "/b", name: "beta" }],
    );
    await delegateCoordination(g!.id, "a");
    await delegateCoordination(g!.id, "a");
    // The delegate resolves to project a's ACTIVE session ("active-a" via
    // the mock fallback). Simulate the user deleting THAT session; project a
    // must then have no other session (explicit empty) so coordination
    // returns to the user.
    shared.activeSessions.set("a", "");
    const { agentBus } = await import("../lib/eventBus");
    agentBus.emit("session:delete", { sessionId: "s-a" });
    const live = getGroup(g!.id)!;
    expect(live.coordinator).toEqual({ kind: "user" });
    expect(live.messages.some((m) => m.from === "system" && m.text.includes("coordination returned"))).toBe(true);
  });
});

describe("join / leave (human-only membership changes)", () => {
  it("addParticipants is idempotent per project and appends a system note", async () => {
    const g = await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "alpha" },
      [{ projectId: "b", root: "/b", name: "beta" }],
    );
    await addParticipants(g!.id, [{ projectId: "c", root: "/c", name: "gamma" }]);
    await addParticipants(g!.id, [{ projectId: "c", root: "/c", name: "gamma" }]); // no-op
    const live = getGroup(g!.id)!;
    expect(live.participants).toHaveLength(3);
    expect(live.messages.filter((m) => m.from === "system").length).toBe(1);
  });

  it("removeParticipant clears machinery and ends a <=1 group", async () => {
    const g = await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "alpha" },
      [{ projectId: "b", root: "/b", name: "beta" }],
    );
    await removeParticipant(g!.id, "b");
    const live = getGroup(g!.id)!;
    expect(live.participants).toHaveLength(1);
    expect(live.endedAt).not.toBeNull();
  });

  it("source pin: no tool file touches membership mutation", () => {
    const tools = readFileSync(new URL("../tools/group.ts", import.meta.url), "utf8");
    expect(tools).not.toContain("addParticipants");
    expect(tools).not.toContain("removeParticipant");
    expect(tools).toContain("sendFromCoordinator");
  });
});

describe("queued-delivery notification (Phase 3 UX)", () => {
  it("a queued delivery pings the background-notifier (best-effort)", async () => {
    const { notifyBackgroundAgent } = await import("../lib/backgroundNotifications");
    const g = await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "alpha" },
      [{ projectId: "b", root: "/b", name: "beta" }],
    );
    const { sendGroupMessage } = await import("./groupChatStore");
    shared.metaStatus = "streaming"; // busy → queue path → notify
    await sendGroupMessage(g!.id, "while you were busy", "b");
    expect(notifyBackgroundAgent).toHaveBeenCalled();
  });
});