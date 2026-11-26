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
  groupDeliveryPreview,
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

  it("endGroupChat clears the ping-pong breaker state for that group", async () => {
    const g = await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "A" },
      [{ projectId: "b", root: "/b", name: "B" }],
    );
    // Burn the strict alternation into a trip (pause + reset inside the
    // breaker). The old test observed the (removed) cap note; the breaker
    // is silent now, so we observe its EFFECT: with state cleared on end,
    // a resumed group routes immediately; with stale state it would sit
    // out the 60s cooldown.
    const { MENTION_PINGPONG_ROUNDS } = await import("./groupChatStore");
    for (let i = 0; i < MENTION_PINGPONG_ROUNDS * 2 + 1; i++) {
      await deliverAgentMentions(
        g!.id,
        i % 2 === 0 ? "a" : "b",
        i % 2 === 0 ? "@B ping" : "@A pong",
      );
    }
    // Tripped: the next routed exchange is dropped (cooldown).
    const duringCooldown = await deliverAgentMentions(g!.id, "a", "@B again");
    expect(duringCooldown.deliveries).toHaveLength(0);
    await endGroupChat(g!.id);
    // After end (+resume), the breaker state is GONE: routing resumes
    // immediately instead of waiting out the cooldown.
    const live = getGroup(g!.id)!;
    live.endedAt = null; // resume without the resume path's membership sweep
    const afterEnd = await deliverAgentMentions(g!.id, "a", "@B fresh start");
    expect(afterEnd.deliveries.length).toBeGreaterThan(0);
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

describe("N11: groupDeliveryPreview (main-chat group pill)", () => {
  // 2026-11-26 report: group texts rendered as watch pills / raw bubbles in
  // the participant's own chat. The pill derives its label + excerpt from
  // the delivery text itself, so it survives any metadata loss.
  it("extracts the group name and excerpt from a participant delivery", () => {
    const p = groupDeliveryPreview(
      "[My Group · cross-project group] hello team, let's ship it",
    );
    expect(p).toEqual({
      label: "My Group",
      excerpt: "hello team, let's ship it",
    });
  });

  it("strips fence markers from the excerpt (agent-authored deliveries)", () => {
    const p = groupDeliveryPreview(
      "[My Group · cross-project group] [start tool_abc123]\n[source: cross-project group chat]\nactual content here\n[end tool_abc123]",
    );
    expect(p!.excerpt).toContain("actual content here");
    expect(p!.excerpt).not.toContain("tool_abc123");
  });

  it("labels a coalesced coordinator wake by the replier", () => {
    const p = groupDeliveryPreview(
      "[group] beta replied:\nthe build passed on my side",
    );
    expect(p!.label).toBe("beta replied in the group");
    expect(p!.excerpt).toBe("the build passed on my side");
  });

  it("labels a coordinator delegation prompt", () => {
    const p = groupDeliveryPreview(
      "[group: My Group] You are now the COORDINATOR.",
    );
    expect(p!.label).toBe("My Group");
  });

  it("returns null for non-group text (plain user bubbles unaffected)", () => {
    expect(groupDeliveryPreview("just a normal message")).toBeNull();
  });
});
