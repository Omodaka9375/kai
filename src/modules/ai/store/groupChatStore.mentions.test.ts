import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * AGENT @-MENTION ROUTING (2026-11-01).
 *
 * User ask: "Agents in group chat should know how to tag or mention each
 * other." Design: agents learn the convention where they already learn the
 * group exists — the delivery payload (roster + @Name example), the persona
 * system prompt, and the coordinator preamble. Their replies route through
 * deliverAgentMentions (same matcher as the composer's resolver), so an
 * agent's "@Name ..." in its reply lands as a delivery to that member.
 *
 * Guard: a MENTION_CHAIN_MAX cap on agent-to-agent exchanges (two agents
 * ping-ponging must surface, not loop); a human message resets the chain.
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
  createGroupChat,
  deliverAgentMentions,
  getGroup,
  matchParticipantByToken,
  sendGroupMessage,
  MENTION_CHAIN_MAX,
} from "./groupChatStore";

const injectMessageMock = shared.injectMessage;

async function makeGroup() {
  const g = await createGroupChat(
    { projectId: "proj-a", sessionId: "sess-a", root: "/a", name: "alpha" },
    [{ projectId: "proj-b", root: "/b", name: "beta" }],
  );
  expect(g).not.toBeNull();
  return g!;
}

beforeEach(() => {
  __resetGroupChatsForTest();
  injectMessageMock.mockReset();
  shared.metaStatus = "idle";
  shared.activeSessions.clear();
});

describe("matchParticipantByToken (shared matcher)", () => {
  const parts = [
    { projectId: "p-alpha", name: "alpha", sessionId: "s-a", root: "/a", joinedAt: 0 },
    { projectId: "p-sec", name: "Security Reviewer", sessionId: "s-c", root: "/c", joinedAt: 0 },
  ] as never[];

  it("matches equality, space-stripped prefix, substring — case-insensitive", () => {
    expect(matchParticipantByToken(parts as never, "alpha")!.projectId).toBe("p-alpha");
    expect(matchParticipantByToken(parts as never, "Alpha")!.projectId).toBe("p-alpha");
    expect(matchParticipantByToken(parts as never, "Sec")!.projectId).toBe("p-sec");
    expect(matchParticipantByToken(parts as never, "securityreviewer")!.projectId).toBe("p-sec");
  });

  it("no match on stray tokens (paths, emails) — undefined, never a wrong target", () => {
    expect(matchParticipantByToken(parts as never, "2")).toBeUndefined();
    expect(matchParticipantByToken(parts as never, "")).toBeUndefined();
  });
});

describe("deliverAgentMentions — routing engine", () => {
  it("routes an @-mention in a reply to the named member (delivery + provision armed)", async () => {
    const g = await makeGroup();
    shared.activeSessions.set("proj-b", "sess-b");
    const out = await deliverAgentMentions(g.id, "proj-a", "@beta please check the build");
    expect(out.deliveries).toHaveLength(1);
    expect(out.deliveries[0]!.target.projectId).toBe("proj-b");
    expect(out.deliveries[0]!.queued).toBe(false);
    // Delivery went to beta's CURRENT session, prefix names the sender.
    expect(injectMessageMock).toHaveBeenCalledWith(
      "sess-b",
      expect.stringContaining("@beta please check the build"),
    );
    expect(injectMessageMock).toHaveBeenCalledWith(
      "sess-b",
      expect.stringContaining("alpha @-mentioned you"),
    );
    // The mirror provision is armed for beta's answer (it will mirror back).
    const { peekReplyProvision } = await import("./groupChatStore");
    expect(peekReplyProvision("sess-b")).toBe(g.id);
  });

  it("deduplicates repeated @tokens (one delivery per target)", async () => {
    const g = await makeGroup();
    shared.activeSessions.set("proj-b", "sess-b");
    injectMessageMock.mockClear();
    await deliverAgentMentions(g.id, "proj-a", "@beta x @beta y");
    expect(injectMessageMock).toHaveBeenCalledTimes(1);
  });

  it("no @-mentions = no deliveries, no chain burn on nothing", async () => {
    const g = await makeGroup();
    const out = await deliverAgentMentions(g.id, "proj-a", "plain reply, no mentions");
    expect(out.deliveries).toHaveLength(0);
    // The chain counter only counts when a delivery happens? No — the cap
    // counts ROUTED exchanges; a mention-less reply must not route anything
    // but the router still ran. Cap sanity below.
  });

  it("the chain cap surfaces a ping-pong as a system note, and a human message resets it", async () => {
    const g = await makeGroup();
    shared.activeSessions.set("proj-b", "sess-b");
    const live = () => getGroup(g.id)!;
    const systemNote = () =>
      live().messages.some((m) => m.from === "system" && m.text.includes("@-mention routing paused"));
    // Burn the chain: agent-to-agent exchanges up to the cap.
    for (let i = 0; i < MENTION_CHAIN_MAX; i++) {
      await deliverAgentMentions(g.id, i % 2 === 0 ? "proj-a" : "proj-b", "@alpha/@beta ping");
    }
    expect(systemNote()).toBe(false);
    // One past the cap: routing refuses + notes.
    const blocked = await deliverAgentMentions(g.id, "proj-a", "@beta ping again");
    expect(blocked.deliveries).toHaveLength(0);
    expect(systemNote()).toBe(true);
    // Human message resets the chain — routing works again.
    await sendGroupMessage(g.id, "ok team, continue");
    injectMessageMock.mockClear();
    const resumed = await deliverAgentMentions(g.id, "proj-a", "@beta what is the status?");
    expect(resumed.deliveries).toHaveLength(1);
  });
});

describe("agents LEARN the convention (prompt surfaces)", () => {
  const store = readFileSync(new URL("./groupChatStore.ts", import.meta.url), "utf8");
  const bridge = readFileSync(
    new URL("../components/AgentRunBridge.tsx", import.meta.url),
    "utf8",
  );

  it("every delivery payload carries the roster + @Name example (deliverToParticipant)", () => {
    expect(store).toMatch(/\[group members: \$\{roster}\]/);
    expect(store).toMatch(/@-mention another member by name/);
    // The payload (not the bare prefixed) is what is injected and queued.
    expect(store).toMatch(/injectMessage\(p\.sessionId, payload\)/);
    expect(store).toMatch(/text: payload, at: Date\.now\(\)/);
  });

  it("the persona system prompt teaches the roster + convention", () => {
    expect(store).toMatch(/Group members: .*\$\{g\.participants/);
  });

  it("the coordinator preamble teaches the @-mention convention", () => {
    expect(store).toMatch(/You may @-mention another member by name/);
  });

  it("the bridge mirror arm routes @-mentions of a participant reply", () => {
    expect(bridge).toMatch(/deliverAgentMentions\(\s*mirror\.group\.id/);
  });

  it("the persona reply path routes @-mentions (personas never settle in the bridge)", () => {
    expect(store).toMatch(/deliverAgentMentions\(live\.id, p\.projectId, reply\)/);
  });
});