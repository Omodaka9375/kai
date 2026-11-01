import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SINGLE MEMBERSHIP invariant (audit M3, Option A —
 * docs/2.1.2-m3-design-options.md): one project may be a member of one
 * LIVE group at a time. Session-keyed machinery (reply provision, coalesce
 * buffer, send queue) is single-answer per session; dual membership
 * cross-routes deliveries. Personas are exempt (composite-keyed machinery,
 * multi-group by design). ENDED groups hold no membership; resume
 * re-checks. Store entry points enforce; the picker disables rows
 * pre-emptively (pinned separately).
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
    // Test seam: preload persisted groups for hydrateGroups prune tests.
    seedGroups(value: unknown) {
      this.map.set("groups", value);
    }
  }
  return { LazyStore: FakeLazyStore };
});

const injectMessageMock = vi.fn();
const activeSessions: Record<string, string | null> = {};
vi.mock("./chatStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chatStore")>();
  return {
    ...actual,
    useChatStore: {
      getState: () => ({ injectMessage: injectMessageMock }),
    },
    getSessionAgentMeta: () => ({ status: "idle" }),
    getProjectActiveSession: (id: string) => activeSessions[id] ?? null,
  };
});

import {
  __resetGroupChatsForTest,
  addParticipants,
  addPersonaParticipants,
  coordinatorPendingCount,
  createGroupChat,
  delegateCoordination,
  endGroupChat,
  getGroup,
  hydrateGroups,
  lastGroupRefusal,
  liveGroupForProject,
  resumeGroupChat,
  sendFromCoordinator,
} from "./groupChatStore";

async function mkGroup(
  inviterProject: string,
  invitees: string[],
): Promise<string> {
  const g = await createGroupChat(
    {
      projectId: inviterProject,
      sessionId: `s-${inviterProject}`,
      root: `/${inviterProject}`,
      name: inviterProject.toUpperCase(),
    },
    invitees.map((id) => ({
      projectId: id,
      root: `/${id}`,
      name: id.toUpperCase(),
    })),
  );
  expect(g).not.toBeNull();
  return g!.id;
}

beforeEach(() => {
  __resetGroupChatsForTest();
  injectMessageMock.mockReset();
  activeSessions["a"] = "active-a";
  activeSessions["b"] = "active-b";
  activeSessions["c"] = "active-c";
});

describe("single-membership invariant (audit M3 Option A)", () => {
  it("liveGroupForProject finds the live group, ignores ended groups", async () => {
    const id = await mkGroup("a", ["b"]);
    expect(liveGroupForProject("a")?.id).toBe(id);
    expect(liveGroupForProject("b")?.id).toBe(id);
    expect(liveGroupForProject("c")).toBeNull();
    await endGroupChat(id);
    expect(liveGroupForProject("a")).toBeNull();
    expect(liveGroupForProject("b")).toBeNull();
  });

  it("createGroupChat refuses a conflicted INVITER", async () => {
    await mkGroup("a", ["b"]);
    expect(lastGroupRefusal()).toBeNull();
    const g = await createGroupChat(
      { projectId: "a", sessionId: "s-a", root: "/a", name: "A" },
      [{ projectId: "c", root: "/c", name: "C" }],
    );
    expect(g).toBeNull();
    expect(lastGroupRefusal()).toMatch(/already a member of the live group/);
  });

  it("createGroupChat refuses a conflicted INVITEE", async () => {
    await mkGroup("a", ["b"]);
    const g = await createGroupChat(
      { projectId: "c", sessionId: "s-c", root: "/c", name: "C" },
      [{ projectId: "b", root: "/b", name: "B" }],
    );
    expect(g).toBeNull();
    expect(lastGroupRefusal()).toMatch(/already a member of another live group/);
  });

  it("createGroupChat succeeds after the owning group ENDS", async () => {
    const first = await mkGroup("a", ["b"]);
    await endGroupChat(first);
    const second = await createGroupChat(
      { projectId: "c", sessionId: "s-c", root: "/c", name: "C" },
      [{ projectId: "b", root: "/b", name: "B" }],
    );
    expect(second).not.toBeNull();
    expect(lastGroupRefusal()).toBeNull();
  });

  it("personas are exempt: the same persona joins two live groups", async () => {
    const id1 = await mkGroup("a", ["b"]);
    const id2 = await mkGroup("c", ["d"]);
    // addPersonaParticipants must never be blocked by the invariant.
    await addPersonaParticipants(id1, ["builtin:reviewer"]);
    await addPersonaParticipants(id2, ["builtin:reviewer"]);
    const p1 = getGroup(id1)!.participants.find(
      (p) => p.projectId === "persona:builtin:reviewer",
    );
    const p2 = getGroup(id2)!.participants.find(
      (p) => p.projectId === "persona:builtin:reviewer",
    );
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
  });

  it("addParticipants skips a conflicted project with a transcript note", async () => {
    const id = await mkGroup("a", ["b"]);
    // Project c joins its own live group, then is invited into group A:
    // the store-side backstop must skip c with a note (invite_agent and
    // the ParticipantsMenu rely on this path).
    await mkGroup("c", ["d"]);
    await addParticipants(id, [{ projectId: "c", root: "/c", name: "C" }]);
    const g = getGroup(id)!;
    expect(
      g.participants.some((p) => p.projectId === "c"),
    ).toBe(false);
    expect(
      g.messages.some(
        (m) =>
          m.from === "system" &&
          m.text.includes("already a member of another live group"),
      ),
    ).toBe(true);
  });

  it("resumeGroupChat drops conflicted members with a note; resumes when at least one project member stays", async () => {
    const first = await mkGroup("a", ["b"]);
    await endGroupChat(first);
    // While the first group was ended, b joined another live group.
    await mkGroup("c", ["b"]);
    const ok = await resumeGroupChat(first);
    expect(ok).toBe(true);
    const g = getGroup(first)!;
    expect(g.endedAt).toBeNull();
    expect(g.participants.some((p) => p.projectId === "b")).toBe(false);
    expect(g.participants.some((p) => p.projectId === "a")).toBe(true);
    expect(
      g.messages.some(
        (m) => m.from === "system" && /B was removed on resume/.test(m.text),
      ),
    ).toBe(true);
  });

  it("resumeGroupChat REFUSES when every project member is conflicted", async () => {
    const first = await mkGroup("a", ["b"]);
    await endGroupChat(first);
    await mkGroup("x", ["a"]);
    await mkGroup("y", ["b"]);
    const ok = await resumeGroupChat(first);
    expect(ok).toBe(false);
    expect(lastGroupRefusal()).toMatch(/every project member/);
    expect(getGroup(first)!.endedAt).not.toBeNull();
  });

  it("resumeGroupChat is a no-op success for a LIVE group (no refusal)", async () => {
    const id = await mkGroup("a", ["b"]);
    const ok = await resumeGroupChat(id);
    expect(ok).toBe(true);
    expect(lastGroupRefusal()).toBeNull();
  });

  it("the coordinator preamble injects once per delegation TERM, not per boot (SHOULD 4)", async () => {
    const id = await mkGroup("a", ["b"]);
    await delegateCoordination(id, "b");
    const { consumeCoordinatorPreamble, endGroupChat } = await import(
      "./groupChatStore"
    );
    // First call in a fresh term: true (the bridge injects).
    expect(consumeCoordinatorPreamble(id)).toBe(true);
    // Every later call — including after a RESTART (fresh module maps read
    // the persisted flag) — is false until the term changes.
    expect(consumeCoordinatorPreamble(id)).toBe(false);
    // End + resume = a new term: re-armed.
    await endGroupChat(id);
    expect(consumeCoordinatorPreamble(id)).toBe(false); // ended group: no
    const ok = await import("./groupChatStore").then((m) =>
      m.resumeGroupChat(id),
    );
    expect(ok).toBe(true);
    expect(consumeCoordinatorPreamble(id)).toBe(true);
    expect(consumeCoordinatorPreamble(id)).toBe(false);
  });

  it("delegateCoordination tears down the OLD coordinator's armed coalesce state (no spurious wake)", async () => {
    const id = await mkGroup("a", ["b", "c"]);
    // Agent-coordinator for group `id`: delegate to b.
    await delegateCoordination(id, "b");
    // Arm a coalesce round for the CURRENT coordinator (b) targeting c.
    await sendFromCoordinator(id, "c", "hello from b");
    // Re-delegate to c: the OLD coordinator (b) must lose its armed
    // buffer + timer; a later flushCoalesced(b) must find nothing (the
    // audit's spurious-wake repro: the timer fires into a plain member).
    await delegateCoordination(id, "c");
    // The send-to-project call returned a Delivered note (armed).
    // After re-delegation the machinery for b's session is gone:
    const g = getGroup(id)!;
    expect(g.coordinator.kind).toBe("agent");
    if (g.coordinator.kind === "agent") {
      expect(g.coordinator.sessionId).toBe("active-c");
    }
    // Direct repro: firing the old coordinator's flush now injects
    // nothing (no pendingReplies entry, no timer).
    expect(coordinatorPendingCount("s-b")).toBe(0);
  });

  it("hydrateGroups prunes dual membership deterministically (earlier group wins)", async () => {
    // Two LIVE persisted groups sharing project "b" — the earlier group
    // (createdAt first) keeps b; the later group drops b with a note. The
    // invariant now refuses to BUILD this state, so seed the persisted
    // record directly (the pre-invariant shape an older build wrote).
    const { __seedGroupsForHydrate } = await import("./groupChatStore") as {
      __seedGroupsForHydrate: (g: unknown[]) => void;
    };
    __seedGroupsForHydrate([
      {
        id: "g-old-1",
        name: "Old",
        coordinator: { kind: "user" },
        participants: [
          { projectId: "a", sessionId: "s-a", root: "/a", name: "A", joinedAt: 1 },
          { projectId: "b", sessionId: "s-b", root: "/b", name: "B", joinedAt: 2 },
        ],
        messages: [],
        createdAt: 100,
        endedAt: null,
      },
      {
        id: "g-old-2",
        name: "Later",
        coordinator: { kind: "user" },
        participants: [
          { projectId: "c", sessionId: "s-c", root: "/c", name: "C", joinedAt: 3 },
          { projectId: "b", sessionId: "s-b", root: "/b", name: "B", joinedAt: 4 },
        ],
        messages: [],
        createdAt: 200,
        endedAt: null,
      },
    ]);
    await hydrateGroups();
    const older = getGroup("g-old-1");
    const later = getGroup("g-old-2");
    expect(older).not.toBeNull();
    expect(later).not.toBeNull();
    expect(older!.participants.some((p) => p.projectId === "b")).toBe(true);
    expect(later!.participants.some((p) => p.projectId === "b")).toBe(false);
    expect(
      later!.messages.some(
        (m) => m.from === "system" && /B was dropped at startup/.test(m.text),
      ),
    ).toBe(true);
  });
});
