import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Unified approval surface - Phase 1 of the cross-context approval design.
 *
 * The contract: ONE decision surface (the group panel renders the SAME
 * rich AiToolApproval card the regular chat proves) for every group
 * participant source:
 *   - group-persona: headless generateText runs (registry + decide fn)
 *   - group-session: background project sessions (live chat parts,
 *     decided via respondToApprovalStandalone - audited + latched)
 *
 * Guards pinned:
 *   - Foreground-session approvals are SUPPRESSED (the inline chat card owns
 *     them; a proxy twin would double-answer).
 *   - Proxy cards can never offer edit (edited-shell approve injects into
 *     the FOREGROUND terminal - wrong project for a proxy decision).
 *   - Persona decisions route through respondPersonaApproval (audited);
 *     session decisions through respondToApprovalStandalone (latched).
 *   - MCP tools stay desktop-card-only (proxy MCP cards are skipped).
 */

const respondMock = vi.hoisted(() => vi.fn());

vi.mock("@/modules/ai/store/chatStore", () => ({
  getChat: (sessionId: string) =>
    sessionId === "sess-alpha"
      ? {
          messages: [
            {
              role: "assistant",
              parts: [
                {
                  type: "tool-bash_run",
                  state: "approval-requested",
                  toolCallId: "tc-1",
                  approval: { id: "ap-1" },
                  input: { command: "pnpm test" },
                },
                { type: "text", text: "working..." },
              ],
              metadata: { createdAt: 100 },
            },
          ],
        }
      : sessionId === "sess-foreground"
        ? {
            messages: [
              {
                role: "assistant",
                parts: [
                  {
                    type: "tool-edit",
                    state: "approval-requested",
                    toolCallId: "tc-fg",
                    approval: { id: "ap-fg" },
                    input: { path: "x.ts" },
                  },
                ],
                metadata: { createdAt: 50 },
              },
            ],
          }
        : undefined,
  respondToApprovalStandalone: respondMock,
  // groupChatStore's top-level pinner seam reads this (guarded typeof) -
  // stub it so importing the real store doesn't demand the full chatStore.
  setChatPinner: () => {},
}));

import {
  unifiedGroupApprovals,
  respondUnifiedApproval,
  type UnifiedApproval,
} from "./groupApprovals";
import type { PersonaApproval } from "../store/groupChatStore";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const personas: PersonaApproval[] = [
  {
    approvalId: "tc-persona",
    groupId: "g1",
    sessionKey: "g1::persona:builtin:reviewer",
    personaName: "Code Reviewer",
    toolName: "write_file",
    summary: "notes/draft.md",
    input: { path: "notes/draft.md", content: "x" },
    at: 200,
  },
];

beforeEach(() => {
  respondMock.mockReset();
});

describe("unifiedGroupApprovals enumeration", () => {
  it("merges persona registry + background project sessions, oldest first", () => {
    const out = unifiedGroupApprovals({
      personaApprovals: personas,
      participants: [{ name: "Alpha", sessionId: "sess-alpha" }],
      foregroundSessionId: null,
    });
    expect(out).toHaveLength(2);
    // Session approval (createdAt 100) before persona (at 200).
    expect(out[0]!.id).toBe("ap-1");
    expect(out[0]!.source).toBe("group-session");
    expect(out[0]!.requester).toBe("Alpha");
    expect(out[0]!.label).toBeTruthy(); // presentation label resolved
    expect(out[1]!.id).toBe("tc-persona");
    expect(out[1]!.source).toBe("group-persona");
    expect(out[1]!.requester).toBe("Code Reviewer");
  });

  it("suppresses the foreground session's approvals (inline card owns them)", () => {
    const out = unifiedGroupApprovals({
      personaApprovals: [],
      participants: [
        { name: "Foreground", sessionId: "sess-foreground" },
        { name: "Alpha", sessionId: "sess-alpha" },
      ],
      foregroundSessionId: "sess-foreground",
    });
    expect(out.some((a) => a.id === "ap-fg")).toBe(false);
    expect(out.some((a) => a.id === "ap-1")).toBe(true);
  });

  it("carries the raw input for the rich card (command/path)", () => {
    const out = unifiedGroupApprovals({
      personaApprovals: personas,
      participants: [],
      foregroundSessionId: null,
    });
    expect(out[0]!.input).toEqual({
      path: "notes/draft.md",
      content: "x",
    });
  });

  it("skips sessions with no live chat and dynamic (MCP) tools", () => {
    const out = unifiedGroupApprovals({
      personaApprovals: [],
      participants: [{ name: "Ghost", sessionId: "sess-none" }],
      foregroundSessionId: null,
    });
    expect(out).toHaveLength(0);
  });
});

describe("respondUnifiedApproval routing", () => {
  it("session approvals route through respondToApprovalStandalone", () => {
    const a: UnifiedApproval = {
      id: "ap-1",
      source: "group-session",
      groupId: null,
      requester: "Alpha",
      toolName: "bash_run",
      input: { command: "x" },
      label: "Run command",
      at: 1,
    };
    respondUnifiedApproval(a, true);
    expect(respondMock).toHaveBeenCalledWith("ap-1", true);
  });

  it("persona approvals route through respondPersonaApproval", async () => {
    const mod = await import("../store/groupChatStore");
    const spy = vi.spyOn(mod, "respondPersonaApproval");
    const a: UnifiedApproval = {
      id: "tc-persona",
      source: "group-persona",
      groupId: "g1",
      requester: "Code Reviewer",
      toolName: "write_file",
      input: {},
      label: "Edit file",
      at: 2,
    };
    respondUnifiedApproval(a, false);
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalledWith("tc-persona", false);
    spy.mockRestore();
  });
});

describe("source pins - unified surface wiring", () => {
  it("the group panel renders the rich AiToolApproval card for both sources", () => {
    const panel = read("../components/GroupChatPanelView.tsx");
    expect(panel).toContain("<GroupApprovals group={active} />");
    expect(panel).toContain("<AiToolApproval");
    expect(panel).toContain("unifiedGroupApprovals({");
    expect(panel).toContain('context: a.source === "group-persona"');
    // The old persona-only simple card is gone.
    expect(panel).not.toContain("wants to run");
  });

  it("proxy cards never offer edit (foreground injection safety)", () => {
    const card = read("../components/AiToolApproval.tsx");
    expect(card).toContain("const isEditable = !proxy && (isShell || isMemory);");
    expect(card).toContain("requested by <span");
  });

  it("queue chips mirror the regular chat for multi-approval steps", () => {
    const panel = read("../components/GroupChatPanelView.tsx");
    expect(panel).toContain(
      "queue={pending.length > 1 ? { queued: false, position: i + 1, total: pending.length } : null}",
    );
  });

  it("the GroupPill carries a pending-approvals badge (attention surface)", () => {
    const pill = read("../components/GroupPill.tsx");
    expect(pill).toContain("getPersonaApprovals().length");
    expect(pill).toContain("pendingApprovals");
  });

  it("PersonaApproval carries the raw input for the rich card", () => {
    const store = read("../store/groupChatStore.ts");
    expect(store).toContain("input?: unknown;");
    expect(store).toContain("input: c.input,");
  });
});
