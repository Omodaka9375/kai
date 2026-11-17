import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * AGENT-DRIVEN GROUP CREATION (2026-11-18).
 *
 * User report: asked an agent to "create a group chat with another agent"
 * and got "Can't open it from here — group chat is a UI thing." True at
 * the time: creation was human-only (panel InvitePicker) and the
 * coordinator tools (invite_agent / send_to_project) attach ONLY to a
 * delegated coordinator of an EXISTING group — so a plain session had no
 * group capability at all.
 *
 * Contract (tools/group.ts buildCreateGroupTool):
 *  - create_group is available to EVERY session (not coordinator-gated —
 *    that is the bootstrap gap it closes).
 *  - Approval-gated ALWAYS (needsApproval: true; never auto-approved, not
 *    standing-authority). The approval card IS the human membership grant.
 *  - Inviter = this session's project; members resolve from the same
 *    roster seam (getAllProjectRuntimes) + registered personas.
 *  - On success: group created (createGroupChat), personas joined
 *    (addPersonaParticipants), and the group panel opens via the
 *    Kai:open-group-chat event — as visible as a user-created group.
 *  - COORDINATOR DEFAULTS (2026-11-18 product decision): an agent-created
 *    group defaults the CREATING AGENT to coordinator (the approval card
 *    grants membership + coordination in one click). delegate_to_self:
 *    false leaves the user as coordinator. A panel-created group keeps
 *    the user as coordinator — unchanged.
 *  - Honest errors: no project, no session, own project already in a live
 *    group (single membership), unknown members.
 */

vi.mock("@tauri-apps/plugin-store", () => {
  class FakeLazyStore {
    async get() {
      return null;
    }
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
  coordinatorGroupForSession,
  endGroupChat,
  getGroup,
  liveGroupForProject,
} from "../store/groupChatStore";
import { buildCreateGroupTool } from "../tools/group";

type CreateGroupTool = {
  needsApproval?: boolean;
  description: string;
  execute: (i: {
    members: string[];
    group_name?: string;
    delegate_to_self?: boolean;
  }) => Promise<{
    ok: boolean;
    note: string;
    group_id?: string;
  }>;
};

const listeners = new Map<string, (e: unknown) => void>();

beforeEach(() => {
  __resetGroupChatsForTest();
  shared.injectMessage.mockReset();
  shared.activeSessions.clear();
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

/** ToolContext double: session s-own belongs to project p-own; two OTHER
 *  open projects exist (p-alpha, p-beta) + every registered persona. */
function makeCtx(overrides?: Partial<{ projectId: string; sessionId: string | null }>) {
  return {
    getSessionId: () => overrides?.sessionId ?? "s-own",
    projectId: overrides?.projectId ?? "p-own",
    getAllProjectRuntimes: () => [
      { id: "p-own", root: "/repos/own", env: { kind: "local" as const } },
      { id: "p-alpha", root: "/repos/alpha", env: { kind: "local" as const } },
      { id: "p-beta", root: "/repos/beta", env: { kind: "local" as const } },
    ],
  } as Parameters<typeof buildCreateGroupTool>[0];
}

const tool = (ctx = makeCtx()) =>
  buildCreateGroupTool(ctx) as unknown as { create_group: CreateGroupTool };

describe("create_group — tool surface", () => {
  it("is available to NON-coordinator sessions (the bootstrap gap this closes)", () => {
    // No group exists; session is nobody's coordinator. The tool still builds.
    const t = tool().create_group;
    expect(t).toBeDefined();
    expect(t.description).toContain("group chat");
  });

  it("is approval-gated (membership grant is the user's click)", () => {
    expect(tool().create_group.needsApproval).toBe(true);
  });
});

describe("create_group — behavior", () => {
  it("creates a group; the CREATING AGENT becomes coordinator by default; the panel opens", async () => {
    const dispatched: Array<{ type: string; detail: unknown }> = [];
    listeners.set("Kai:open-group-chat", (e) => {
      dispatched.push(e as { type: string; detail: unknown });
    });
    const res = await tool().create_group.execute({
      members: ["p-alpha"],
      group_name: "Alpha Sync",
    });
    expect(res.ok).toBe(true);
    const g = getGroup(res.group_id!);
    expect(g).not.toBeNull();
    expect(g!.name).toBe("Alpha Sync");
    // Both projects are members; the inviter is p-own.
    const ids = g!.participants.map((p) => p.projectId).sort();
    expect(ids).toEqual(["p-alpha", "p-own"]);
    // AGENT-CREATED DEFAULT: this session's project is the coordinator.
    expect(g!.coordinator.kind).toBe("agent");
    expect(coordinatorGroupForSession("s-own")?.id).toBe(res.group_id);
    // The panel opened for the user.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.detail).toBe(res.group_id);
  });

  it("delegate_to_self=false leaves the USER as coordinator", async () => {
    const res = await tool().create_group.execute({
      members: ["p-beta"],
      delegate_to_self: false,
    });
    expect(res.ok).toBe(true);
    const g = getGroup(res.group_id!)!;
    expect(g.coordinator.kind).toBe("user");
  });

  it("joins persona members (synthetic persona: ids)", async () => {
    const res = await tool().create_group.execute({
      members: ["p-alpha", "builtin:reviewer"],
    });
    expect(res.ok).toBe(true);
    const g = getGroup(res.group_id!)!;
    expect(
      g.participants.some((p) => p.projectId === "persona:builtin:reviewer"),
    ).toBe(true);
  });

  it("refuses when the own project is already in a live group (single membership)", async () => {
    await tool().create_group.execute({ members: ["p-alpha"] });
    const second = await tool().create_group.execute({ members: ["p-beta"] });
    expect(second.ok).toBe(false);
    expect(second.note).toContain("already in the live group");
  });

  it("refuses when the tool context has no project (headless/assistant)", async () => {
    const res = await tool(makeCtx({ projectId: "" })).create_group.execute({
      members: ["p-alpha"],
    });
    expect(res.ok).toBe(false);
    expect(res.note).toContain("no project");
  });

  it("reports unknown members honestly instead of silently skipping all", async () => {
    const res = await tool().create_group.execute({
      members: ["no-such-project"],
    });
    expect(res.ok).toBe(false);
    expect(res.note).toContain("no invitable members matched");
  });

  it("after the creating session's group ends, a new group can be created again", async () => {
    const first = await tool().create_group.execute({ members: ["p-alpha"] });
    expect(first.ok).toBe(true);
    await endGroupChat(first.group_id!);
    expect(liveGroupForProject("p-own")).toBeNull();
    const second = await tool().create_group.execute({ members: ["p-beta"] });
    expect(second.ok).toBe(true);
  });
});
