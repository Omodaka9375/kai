import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * AGENT-DRIVEN GROUP INVITES (2026-11-01).
 *
 * User ask: "add a tool call so the user can ask the agent to invite
 * another agent into the group chat. It needs to be visible in UI when the
 * agent opens the group chat so the user can see the group like they opened
 * it."
 *
 * Contract:
 *  - invite_agent (tools/group.ts): the ONLY tool path to membership.
 *    Approval-gated (the user clicks Allow before anyone joins), routed
 *    through the SAME store functions the human panel uses.
 *  - After a successful invite it dispatches Kai:open-group-chat with the
 *    group id — the same event the rail/status bar uses — so the group
 *    panel opens on the user's screen exactly as if they opened it.
 *  - REMOVE stays human-only (the pin in phase3).
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

// Mock ONLY what the STORE paths need (injectMessage, session meta,
// session resolution). The open-project roster is NOT mocked here — the
// tool reads it from the ToolContext provider (see `ctx` below), so the
// roster is a plain double, no module-registry games.
vi.mock("./chatStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/chatStore")>();
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
  delegateCoordination,
  endGroupChat,
  getGroup,
} from "../store/groupChatStore";
import { buildGroupTools } from "../tools/group";

type InviteTool = {
  needsApproval?: boolean;
  description: string;
  execute: (i: { agent: string; announce?: string }) => Promise<{ ok: boolean; note: string }>;
};

/** Captures window listeners for the stubbed window (panel-open events). */
const listeners = new Map<string, (e: unknown) => void>();

beforeEach(() => {
  __resetGroupChatsForTest();
  shared.injectMessage.mockReset();
  shared.metaStatus = "idle";
  shared.activeSessions.clear();
  // Minimal window double for the panel-open event (the app runs in a
  // webview; node tests have no DOM). Captures dispatched CustomEvents so
  // the behavior tests can assert the panel-open seam.
  listeners.clear();
  vi.stubGlobal("window", {
    addEventListener: (type: string, cb: (e: unknown) => void) => {
      listeners.set(type, cb);
    },
    removeEventListener: () => {},
    dispatchEvent: (e: { type: string }) => {
      listeners.get(e.type)?.(e);
      return true;
    },
  });
  vi.stubGlobal(
    "CustomEvent",
    class {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
  );
});

/** Build a live group with AGENT coordination on session s-a, project p-a.
 *  delegateCoordination takes the PARTICIPANT PROJECT ID ("p-a") — "agent"
 *  matches no participant and silently no-ops. */
async function makeCoordinatedGroup() {
  const g = await createGroupChat(
    { projectId: "p-a", sessionId: "s-a", root: "/a", name: "alpha" },
    // createGroupChat refuses EMPTY groups (null) — one invitee needed.
    [{ projectId: "p-guest", root: "/g", name: "guest" }],
  );
  await delegateCoordination(g!.id, "p-a");
  return g!;
}

/** ToolContext double — session id + the open-project roster provider
 *  (the same seam chatRuntime injects for the real app). Two open
 *  projects; the group's coordinator project (p-a) is NOT one of them. */
const ctx = {
  getSessionId: () => "s-a",
  getAllProjectRuntimes: () => [
    { id: "p-alpha", root: "/repos/alpha", env: { kind: "local" as const } },
    { id: "p-beta", root: "/repos/beta", env: { kind: "local" as const } },
  ],
} as Parameters<typeof buildGroupTools>[0];

const inviteTools = () => buildGroupTools(ctx) as unknown as { invite_agent: InviteTool };

describe("invite_agent — attachment gate", () => {
  it("attaches ONLY for the group's agent coordinator (empty otherwise)", async () => {
    const plain = await createGroupChat(
      { projectId: "p-a", sessionId: "s-a", root: "/a", name: "alpha" },
      [{ projectId: "p-b", root: "/b", name: "beta" }],
    );
    // No coordination → no group tools at all.
    expect(buildGroupTools(ctx)).toEqual({});
    await delegateCoordination(plain!.id, "p-a");
    const tools = buildGroupTools(ctx) as unknown as Record<string, unknown>;
    expect(tools["invite_agent"]).toBeDefined();
    expect(tools["send_to_project"]).toBeDefined();
  });
});

describe("invite_agent — behavior", () => {
  it("invites an open project, notes the join, OPENS the group panel via the UI event", async () => {
    const g = await makeCoordinatedGroup();
    const openSpy = vi.fn();
    window.addEventListener("Kai:open-group-chat", openSpy);
    const tools = inviteTools();
    // Approval-gated: joining an agent into a group is a membership grant.
    expect(tools.invite_agent.needsApproval).toBe(true);
    shared.activeSessions.set("p-alpha", "sess-alpha");
    const res = await tools.invite_agent.execute({
      agent: "p-alpha",
      announce: "joining to help with the tests",
    });
    window.removeEventListener("Kai:open-group-chat", openSpy);
    expect(res.ok).toBe(true);
    // The membership landed (same store path as the human panel invite).
    const live = getGroup(g.id)!;
    expect(live.participants.some((p) => p.projectId === "p-alpha")).toBe(true);
    // The announce note is in the transcript.
    expect(
      live.messages.some((m) => m.from === "system" && m.text.includes("joining to help")),
    ).toBe(true);
    // THE ASK: the panel opened on the user's screen, same event the
    // rail/status bar dispatches, carrying the group id.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect((openSpy.mock.calls[0]?.[0] as CustomEvent<string>).detail).toBe(g.id);
  });

  it("invites an agent PERSONA by persona id", async () => {
    const g = await makeCoordinatedGroup();
    const openSpy = vi.fn();
    window.addEventListener("Kai:open-group-chat", openSpy);
    const tools = inviteTools();
    // BUILTIN_AGENTS always has an agent — use the first one's id.
    const { BUILTIN_AGENTS } = await import("../lib/agents");
    const anyAgent = BUILTIN_AGENTS[0]!;
    const res = await tools.invite_agent.execute({ agent: anyAgent.id });
    window.removeEventListener("Kai:open-group-chat", openSpy);
    expect(res.ok).toBe(true);
    const live = getGroup(g.id)!;
    expect(
      live.participants.some((p) => p.projectId === `persona:${anyAgent.id}`),
    ).toBe(true);
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses unknown ids and the coordinator itself (already a member)", async () => {
    await makeCoordinatedGroup();
    const tools = inviteTools();
    const bad = await tools.invite_agent.execute({ agent: "no-such-agent" });
    expect(bad.ok).toBe(false);
    expect(bad.note).toContain("unknown agent");
    // The group coordinator itself is NOT invitable (already a member).
    const self = await tools.invite_agent.execute({ agent: "p-a" });
    expect(self.ok).toBe(false);
  });

  it("an ended group refuses invites", async () => {
    const g = await makeCoordinatedGroup();
    // Build the tools BEFORE ending: buildGroupTools attaches only while
    // the coordinator group is live.
    const tools = inviteTools();
    await endGroupChat(g.id);
    const res = await tools.invite_agent.execute({ agent: "p-alpha" });
    expect(res.ok).toBe(false);
  });
});

describe("invite_agent — the tool description teaches the roster", () => {
  it("the description lists invitable projects + personas (minus members)", async () => {
    await makeCoordinatedGroup();
    const tools = inviteTools();
    const d = tools.invite_agent.description;
    expect(d).toContain("p-alpha");
    expect(d).toContain("p-beta");
    // Members are NOT in the invitable list: p-a is the coordinator project.
    expect(d).not.toMatch(/p-a \(project id: p-a\)/);
  });
});

describe("source pins — panel opens by the SAME event the rail uses", () => {
  it("the tool dispatches Kai:open-group-chat (the panel's listener seam)", () => {
    const tools = readFileSync(new URL("../tools/group.ts", import.meta.url), "utf8");
    const panel = readFileSync(
      new URL("../components/GroupChatPanelView.tsx", import.meta.url),
      "utf8",
    );
    expect(tools).toContain('"Kai:open-group-chat"');
    // The panel listens for the same event and takes the stack slot.
    expect(panel).toContain('"Kai:open-group-chat"');
  });

  it("addParticipants stays the ONE join path (no parallel mutation in tool code)", () => {
    const tools = readFileSync(new URL("../tools/group.ts", import.meta.url), "utf8");
    expect(tools).toMatch(/addParticipants\(group\.id/);
    // The tool never touches participants directly.
    expect(tools).not.toMatch(/\.\s*participants\s*=\s*\[/);
    expect(tools).not.toContain("groups.set(");
  });
});