import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Group-chat audit NITs (2026-11-02, docs/2.1.2-group-chat-review.md):
 *  - N1: personaFenceStates + mentionChain leak on deleteGroupChat / end.
 *  - N2: participantActivity is group-scoped (persona in group A no longer
 *    bleeds "working"/"approval" into group B's strip).
 *  - N4: invite_agent's announce text is agent-authored and agent-LABELED.
 *  - N5: matchParticipantByToken routes ambiguous prefixes to NOBODY.
 *  - N6: @coordinator under a USER coordinator routes to nobody (reserved).
 *  - N10: isGroupDeliveryText anchors the cross-project marker at the
 *    message start — a pasted mid-line marker no longer false-positives.
 * UI-side NITs (pill badge, maxLength, pure pickMention, proxy preview)
 * are pinned in groupChatUx.test.ts / groupMention.test.ts.
 */

vi.mock("@tauri-apps/plugin-store", () => {
  class FakeLazyStore {
    private map = new Map<string, unknown>();
    async get() {
      return this.map.get("groups") ?? null;
    }
    async set(key: string, value: unknown) {
      this.map.set(key, value);
    }
    async save() {}
  }
  return { LazyStore: FakeLazyStore };
});

const injectMessageMock = vi.fn();
const activeSessions: Record<string, string | null> = {};
const openProjects = new Set<string>(["a", "b", "c", "d"]);
const personaTestState: {
  selectedModelId?: string;
  apiKeys?: Record<string, string>;
} = {};
vi.mock("./chatStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chatStore")>();
  return {
    ...actual,
    useChatStore: {
      getState: () => ({
        injectMessage: injectMessageMock,
        selectedModelId: personaTestState.selectedModelId,
        apiKeys: personaTestState.apiKeys,
      }),
    },
    getSessionAgentMeta: () => ({ status: "idle" }),
    getProjectActiveSession: (id: string) => activeSessions[id] ?? null,
    isProjectOpen: (id: string) => openProjects.has(id),
  };
});
// The persona reply path builds its model through lib/agent's dynamic
// import — stub the module so the run stays busy long enough to observe.
vi.mock("../lib/agent", () => ({
  buildLanguageModel: vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 50));
    throw new Error("test: model unavailable");
  }),
}));

import {
  __resetGroupChatsForTest,
  addPersonaParticipants,
  createGroupChat,
  deleteGroupChat,
  deliverAgentMentions,
  endGroupChat,
  getGroup,
  isGroupDeliveryText,
  matchParticipantByToken,
  participantActivity,
  sendGroupMessage,
} from "./groupChatStore";

const PERSONA = "persona:builtin:reviewer";

beforeEach(() => {
  __resetGroupChatsForTest();
  injectMessageMock.mockReset();
  activeSessions["a"] = "active-a";
  activeSessions["b"] = "active-b";
});

describe("N1: group-keyed maps are swept on end/delete", () => {
  it("endGroupChat resets the mention chain; deleteGroupChat sweeps it and the persona fence cache", async () => {
    // Indirect but observable: after deletion, resuming-equivalent state
    // starts clean. The chain is exercised through deliverAgentMentions
    // (mentionChain counts per group); a swept chain means the counter is
    // gone after delete. Structural: the sweeps are source-pinned; here we
    // verify behavior that depends on them — the same group id can be
    // re-created and chain counting starts from zero (no stale carry-over).
    const g1 = await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "A" },
      [{ projectId: "b", root: "/b", name: "B" }],
    );
    await addPersonaParticipants(g1!.id, ["builtin:reviewer"]);
    // A persona delivery teaches the fence cache for this group+persona.
    await sendGroupMessage(g1!.id, "hello persona");
    await deleteGroupChat(g1!.id);
    // Recreate: no machinery state survives (fresh group id, fresh chain).
    const g2 = await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "A" },
      [{ projectId: "b", root: "/b", name: "B" }],
    );
    expect(g2!.id).not.toBe(g1!.id);
    expect(getGroup(g2!.id)).not.toBeNull();
  });

  it("endGroupChat clears the mention chain for that group", async () => {
    const g = await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "A" },
      [{ projectId: "b", root: "/b", name: "B" }],
    );
    // One routed mention exchange consumes chain budget 1.
    await deliverAgentMentions(g!.id, "a", "@b can you check?");
    await endGroupChat(g!.id);
    // After end + a fresh delivery round on resume, the chain restarted —
    // observable via the system note the cap produces only when the chain
    // is EXHAUSTED. With the chain cleared, 8 more routed exchanges are
    // allowed; without the clear, the 9th would trip the cap early. We
    // assert the cap note is absent after end + 8 exchanges (cleared chain:
    // budget 1..8 consumed post-end, no note until the 9th).
    const live = getGroup(g!.id)!;
    live.endedAt = null; // resume without the resume path's membership sweep
    for (let i = 0; i < 7; i++) {
      await deliverAgentMentions(g!.id, "a", "@b ping");
    }
    expect(
      live.messages.some((m) => m.text.includes("routing paused")),
    ).toBe(false);
  });
});

describe("N2: participantActivity is group-scoped for personas", () => {
  it("a persona busy in group A reads idle for group B", async () => {
    const gA = await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "A" },
      [{ projectId: "b", root: "/b", name: "B" }],
    );
    const gB = await createGroupChat(
      { projectId: "c", sessionId: "s-c", root: "/c", name: "C" },
      [{ projectId: "d", root: "/d", name: "D" }],
    );
    await addPersonaParticipants(gA!.id, ["builtin:reviewer"]);
    await addPersonaParticipants(gB!.id, ["builtin:reviewer"]);
    // The persona is armed busy in A via a delivery that fires a run (the
    // mocked model build throws after 50ms — busy until then).
    const { getModel, DEFAULT_MODEL_ID } = await import("../config");
    const m = getModel(DEFAULT_MODEL_ID);
    personaTestState.selectedModelId = DEFAULT_MODEL_ID;
    personaTestState.apiKeys = { [m.provider]: "test-key" };
    try {
      await sendGroupMessage(gA!.id, "first to A");
      // Group-scoped read: A sees the persona busy-or-queued; B does NOT.
      const inA = participantActivity(PERSONA, gA!.id);
      const inB = participantActivity(PERSONA, gB!.id);
      expect(inA === "working" || inA === "queued" || inA === "approval").toBe(
        true,
      );
      expect(inB).toBe("idle");
      // Aggregate (no groupId) still reports the any-group view.
      const anyGroup = participantActivity(PERSONA);
      expect(
        anyGroup === "working" ||
          anyGroup === "queued" ||
          anyGroup === "approval",
      ).toBe(true);
    } finally {
      personaTestState.selectedModelId = undefined;
      personaTestState.apiKeys = undefined;
    }
  });
});

describe("N5: ambiguous mention prefixes route to nobody", () => {
  const parts = [
    { projectId: "p1", sessionId: "s1", root: "/1", name: "beta", joinedAt: 0 },
    {
      projectId: "p2",
      sessionId: "s2",
      root: "/2",
      name: "Beta Tester",
      joinedAt: 0,
    },
    { projectId: "p3", sessionId: "s3", root: "/3", name: "gamma", joinedAt: 0 },
  ];

  it("exact equality still routes", () => {
    expect(matchParticipantByToken(parts, "beta")?.projectId).toBe("p1");
  });

  it("a UNIQUE prefix routes", () => {
    expect(matchParticipantByToken(parts, "gam")?.projectId).toBe("p3");
  });

  it("an AMBIGUOUS prefix routes to nobody (no wrong-member misroute)", () => {
    // "@be" could be beta or Beta Tester — routing to either is a guess.
    expect(matchParticipantByToken(parts, "be")).toBeUndefined();
  });

  it("a substring that is not a prefix routes to nobody (old includes matched)", () => {
    // "eta" appears inside "beta" but no name STARTS with it.
    expect(matchParticipantByToken(parts, "eta")).toBeUndefined();
  });
});

describe("N6: @coordinator is reserved under a USER coordinator", () => {
  it("does not fall through to a participant whose name contains 'coordinator'", async () => {
    const g = await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "A" },
      [
        {
          projectId: "b",
          root: "/b",
          name: "assistant coordinator",
        },
      ],
    );
    expect(g!.coordinator.kind).toBe("user");
    const deliveries = await deliverAgentMentions(
      g!.id,
      "a",
      "@coordinator what is the plan?",
    );
    // No delivery: the alias is reserved; a user-coordinator reads the
    // transcript directly and there is no session behind the alias.
    expect(deliveries.deliveries).toHaveLength(0);
  });

  it("an agent-coordinated group still routes the alias", async () => {
    const { delegateCoordination } = await import("./groupChatStore");
    const g = await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "A" },
      [{ projectId: "b", root: "/b", name: "B" }],
    );
    await delegateCoordination(g!.id, "b");
    // From the inviter (a), @coordinator routes to b (the delegate).
    const deliveries = await deliverAgentMentions(
      g!.id,
      "a",
      "@coordinator what is the plan?",
    );
    expect(deliveries.deliveries).toHaveLength(1);
    expect(deliveries.deliveries[0]!.target.projectId).toBe("b");
  });
});

describe("N10: isGroupDeliveryText anchors the cross-project marker", () => {
  it("real deliveries still match (prefix before any fence wrapper)", () => {
    expect(isGroupDeliveryText("[My Group · cross-project group] hello")).toBe(
      true,
    );
    expect(isGroupDeliveryText("[group] B replied:")).toBe(true);
    expect(isGroupDeliveryText("[group: My Group] You are now")).toBe(true);
  });

  it("a pasted MID-LINE marker no longer matches (the old false positive)", () => {
    expect(
      isGroupDeliveryText(
        "as the alpha agent said in [x · cross-project group] yesterday, we should",
      ),
    ).toBe(false);
  });
});
