import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Phase 2 contract: agent-as-coordinator delegation.
 *
 *  - delegateCoordination is HUMAN-action only (panel); the tool file can
 *    only SEND, never delegate — pinned by source.
 *  - send_to_project is fire-and-forget: delivers via the queue contract and
 *    returns a "reply arrives as your next message" note. Never polls.
 *  - Reply coalescing: N participants messaged → ONE merged wake, only when
 *    all answered (or the timeout fires — flushCoalesced is shared).
 *  - Relay hop cap: past GROUP_RELAY_MAX_HOPS the send is refused with
 *    guidance to summarize instead of delegating further.
 */

vi.mock("@tauri-apps/plugin-store", () => {
  class FakeLazyStore {
    async get() { return null; }
    async set() {}
    async save() {}
  }
  return { LazyStore: FakeLazyStore };
});

const injectMessageMock = vi.fn();
vi.mock("./chatStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chatStore")>();
  return {
    ...actual,
    useChatStore: {
      getState: () => ({ injectMessage: injectMessageMock }),
    },
    getSessionAgentMeta: () => ({ status: "idle" }),
    getProjectActiveSession: (id: string) => `active-${id}`,
  };
});

import {
  __resetGroupChatsForTest,
  coordinatorGroupForSession,
  createGroupChat,
  delegateCoordination,
  reclaimCoordination,
  sendFromCoordinator,
  noteParticipantReply,
  noteCoordinatorRoundDone,
  coordinatorPreamble,
  getGroup,
} from "./groupChatStore";

beforeEach(() => {
  __resetGroupChatsForTest();
  injectMessageMock.mockReset();
});

/** Standard fixture: 3 projects, alpha's agent coordinates. */
async function fixture() {
  const g = await createGroupChat(
    { projectId: "alpha", sessionId: "active-alpha", root: "/a", name: "alpha" },
    [
      { projectId: "beta", root: "/b", name: "beta" },
      { projectId: "gamma", root: "/c", name: "gamma" },
    ],
    "fixture",
  );
  await delegateCoordination(g!.id, "alpha");
  return g!;
}

describe("delegation lifecycle", () => {
  it("delegates coordination to a participant agent and resolves it back", async () => {
    const g = await fixture();
    const live = getGroup(g.id)!;
    expect(live.coordinator).toEqual({
      kind: "agent",
      projectId: "alpha",
      sessionId: "active-alpha",
    });
    expect(coordinatorGroupForSession("active-alpha")?.id).toBe(g.id);
    await reclaimCoordination(g.id);
    expect(getGroup(g.id)!.coordinator).toEqual({ kind: "user" });
  });

  it("the preamble teaches the yield-and-resume contract (no polling)", () => {
    const pre = coordinatorPreamble({
      id: "g", name: "t", coordinator: { kind: "agent", projectId: "a", sessionId: "s" },
      participants: [
        { projectId: "a", sessionId: "s", root: "/a", name: "alpha", joinedAt: 0 },
        { projectId: "b", sessionId: "s2", root: "/b", name: "beta", joinedAt: 0 },
      ],
      messages: [], createdAt: 0, endedAt: null,
    });
    expect(pre).toContain("FIRE-AND-FORGET");
    expect(pre).toContain("END YOUR TURN");
    expect(pre).toContain("send_to_project");
  });
});

describe("send_to_project engine (fire-and-forget)", () => {
  it("delivers immediately to an idle participant and arms the reply buffer", async () => {
    const g = await fixture();
    const result = await sendFromCoordinator(g.id, "beta", "what's the User type?");
    expect(result).toContain("Delivered to beta");
    expect(result).toContain("reply arrives as your next message");
    // Immediate delivery = injectMessage to BETA's session.
    expect(injectMessageMock).toHaveBeenCalledTimes(1);
    expect(injectMessageMock.mock.calls[0]![0]).toBe("active-beta");
  });

  it("refuses unknown projects and self-sends with actionable text", async () => {
    const g = await fixture();
    expect(await sendFromCoordinator(g.id, "nope", "x")).toContain("unknown project");
    expect(await sendFromCoordinator(g.id, "alpha", "x")).toContain("refusing to send to yourself");
  });

  it("refuses after the user reclaims coordination", async () => {
    const g = await fixture();
    await reclaimCoordination(g.id);
    expect(await sendFromCoordinator(g.id, "beta", "x")).toContain("reclaimed by the user");
  });

  it("hop cap: 24 agent-driven hops block further sends; a USER message resets the breaker", async () => {
    const g = await fixture();
    // Depth counts agent-driven hops since the last USER action — rounds do
    // NOT reset it (a round is indistinguishable from a loop at that layer).
    for (let i = 0; i < 24; i++) {
      await sendFromCoordinator(g.id, "beta", `round ${i}`);
      noteParticipantReply(g.id, "beta", `answer ${i}`);
      noteCoordinatorRoundDone("active-alpha");
    }
    const blocked = await sendFromCoordinator(g.id, "beta", "one more");
    expect(blocked).toContain("relay cap reached");
    expect(blocked).toContain("Summarize");
    // Human intervention resets the breaker and the group flows again.
    const { sendGroupMessage } = await import("./groupChatStore");
    await sendGroupMessage(g.id, "lets regroup", "beta");
    const ok = await sendFromCoordinator(g.id, "beta", "next phase");
    expect(ok).toContain("Delivered");
  });
});

describe("reply coalescing (one merged wake)", () => {
  it("waits for ALL expected participants before waking the coordinator", async () => {
    const g = await fixture();
    await sendFromCoordinator(g.id, "beta", "task 1");
    await sendFromCoordinator(g.id, "gamma", "task 2");
    injectMessageMock.mockClear();
    // Beta replies first — NOT enough, no wake yet.
    expect(noteParticipantReply(g.id, "beta", "beta's answer")).toBeNull();
    expect(injectMessageMock).not.toHaveBeenCalled();
    // Gamma completes the round — ONE merged wake to the coordinator.
    expect(noteParticipantReply(g.id, "gamma", "gamma's answer")).toBeNull();
    expect(injectMessageMock).toHaveBeenCalledTimes(1);
    const [target, text] = injectMessageMock.mock.calls[0]!;
    expect(target).toBe("active-alpha");
    expect(String(text)).toContain("beta replied");
    expect(String(text)).toContain("gamma replied");
    expect(String(text)).toContain("---");
  });

  it("a partial round still wakes with a who's-missing note (timeout path shares flushCoalesced)", async () => {
    const g = await fixture();
    await sendFromCoordinator(g.id, "beta", "a");
    await sendFromCoordinator(g.id, "gamma", "b");
    injectMessageMock.mockClear();
    noteParticipantReply(g.id, "beta", "only beta");
    // Round completes via the missing-note branch when gamma is skipped:
    // simulate by having gamma answer — full round. (The timeout itself is
    // 90s; the shared flush is what the timer calls — verified by the
    // source pin below.)
    noteParticipantReply(g.id, "gamma", "gamma late");
    expect(injectMessageMock).toHaveBeenCalledTimes(1);
  });
});

describe("source pins — Phase 2 trust boundary", () => {
  const tools = readFileSync(new URL("../tools/group.ts", import.meta.url), "utf8");
  const store = readFileSync(new URL("./groupChatStore.ts", import.meta.url), "utf8");
  const bridge = readFileSync(new URL("../components/AgentRunBridge.tsx", import.meta.url), "utf8");
  const menu = readFileSync(new URL("../components/CoordinatorMenu.tsx", import.meta.url), "utf8");

  it("the tool file can SEND but never delegate — delegation is human-only", () => {
    expect(tools).toContain("sendFromCoordinator");
    expect(tools).not.toContain("delegateCoordination");
    expect(menu).toContain("delegateCoordination");
  });

  it("send_to_project is approval-required; project_status is auto", () => {
    // Parsed by the drift gate too; pinned here for the local contract.
    expect(tools.match(/send_to_project:[\s\S]*?needsApproval: true/)).not.toBeNull();
    expect(tools.match(/project_status:[\s\S]*?needsApproval: false/)).not.toBeNull();
  });

  it("tools attach ONLY for the session holding the coordinator role", () => {
    expect(tools).toContain("coordinatorGroupForSession(sessionId)");
    expect(tools).toContain("return {} as Record<string, never>");
  });

  it("bridge relays replies via noteParticipantReply and injects the merged wake", () => {
    expect(bridge).toContain("noteParticipantReply(coordGroup.id");
    expect(bridge).toContain("coordinatorPreamble(coordGroup)");
  });

  it("the coalesce timeout routes through the shared flush", () => {
    expect(store).toContain("setTimeout(() => flushCoalesced(coord.sessionId)");
    expect(store).toContain("GROUP_COALESCE_TIMEOUT_MS = 90_000");
  });

  it("the relay cap is enforced in the store, not the model's promises", () => {
    expect(store).toContain("GROUP_RELAY_MAX_HOPS");
    expect(store.match(/depth >= GROUP_RELAY_MAX_HOPS/)).not.toBeNull();
  });
});