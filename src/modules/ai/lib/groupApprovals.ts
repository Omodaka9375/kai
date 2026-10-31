/**
 * Universal approval registry - ONE decision surface for every context.
 *
 * The SDK's pause/resume approval protocol is identical everywhere; only
 * the DECISION SURFACE differed per context. The regular AI chat has the
 * proven rich card (AiToolApproval); personas grew a second, simpler card;
 * background-project participants in a group only showed a text line.
 * This module unifies the ENUMERATION so one surface (the group panel's
 * approval section, the Telegram pings, anything future) can render the
 * same rich card for every source:
 *
 *   - "group-persona": headless generateText runs, registered by
 *     groupChatStore's persona loop (PersonaApproval + decide fn).
 *   - "group-session": approval parts sitting in a PARTICIPIPANT
 *     project-session's live Chat history (registered nowhere until now -
 *     enumerated from the session's message parts on read).
 *
 * Decisions ROUTE by source: persona cards decide through their stored
 * promise resolver; session cards route through
 * respondToApprovalStandalone, which already locates the owning session's
 * responder (built for background-project approvals) and enforces the
 * monotonic denial latch + audit. NO new trust surface: still only the
 * human ever decides.
 */

import type { UIMessage } from "@ai-sdk/react";
import type { PersonaApproval } from "../store/groupChatStore";
import { getChat, respondToApprovalStandalone } from "../store/chatStore";
import { presentationFor } from "./toolPresentations";
import { analyzeShellCommand } from "./policy";

export type UnifiedApproval = {
  /** The approval id (session: part.approval.id; persona: toolCallId). */
  id: string;
  source: "group-persona" | "group-session";
  /** Owning group (personas only - session approvals are group-scoped by the panel filter). */
  groupId: string | null;
  /** Who is asking: persona display name or project participant name. */
  requester: string;
  /** True when the requester is the foreground AI session (suppress proxy rows). */
  isForegroundSession?: boolean;
  toolName: string;
  /** Raw tool input (command / path / entry) for the rich card. */
  input: Record<string, unknown> | null;
  /** Presentation label (e.g. "Run command", "Edit file"). */
  label: string;
  at: number;
};

/** Tool names that render a shell-ish card (mirrors AiToolApproval's check). */
function isShellTool(name: string): boolean {
  return name === "bash_run" || name === "bash_background";
}

/** Enumerate approval-requested parts from one session's live chat. */
function sessionApprovals(
  sessionId: string,
  requester: string,
): UnifiedApproval[] {
  const chat = getChat(sessionId);
  if (!chat) return [];
  const out: UnifiedApproval[] = [];
  for (const m of chat.messages as UIMessage[]) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts as Array<Record<string, unknown>>) {
      if ((p.state as string | undefined) !== "approval-requested") continue;
      const approval = p.approval as { id?: string } | undefined;
      if (!approval?.id) continue;
      const type = String(p.type ?? "");
      const toolName = type.replace(/^tool-/, "");
      if (!toolName || toolName === "dynamic-tool") continue; // MCP: keep desktop card only
      out.push({
        id: approval.id,
        source: "group-session",
        groupId: null,
        requester,
        toolName,
        input: (p.input as Record<string, unknown> | undefined) ?? null,
        label: presentationFor(toolName).approvalLabel ?? toolName,
        at: (m.metadata as { createdAt?: number } | undefined)?.createdAt ?? 0,
      });
    }
  }
  return out;
}

/** Persona approvals straight from the registry (input now rides along). */
function personaEntries(personas: PersonaApproval[]): UnifiedApproval[] {
  return personas.map((a) => ({
    id: a.approvalId,
    source: "group-persona" as const,
    groupId: a.groupId,
    requester: a.personaName,
    toolName: a.toolName,
    input: (a.input as Record<string, unknown> | null | undefined) ?? null,
    label: presentationFor(a.toolName).approvalLabel ?? a.toolName,
    at: a.at,
  }));
}

/**
 * All pending approvals for a group's participants, oldest first:
 * personas (registry) + project sessions (live chat scan). The panel
 * renders these with the SAME rich card as the regular AI chat.
 *
 * `personaApprovals` come from groupChatStore's getter; `participants` is
 * the group's participant list (name + sessionId). Session entries whose
 * sessionId matches `foregroundSessionId` are suppressed - the regular AI
 * chat already shows that card inline (a duplicate proxy row would be
 * double-rendered and double-answered).
 */
export function unifiedGroupApprovals(args: {
  personaApprovals: PersonaApproval[];
  participants: Array<{ name: string; sessionId: string }>;
  foregroundSessionId: string | null;
}): UnifiedApproval[] {
  const out: UnifiedApproval[] = [];
  for (const p of args.participants) {
    if (!p.sessionId) continue;
    if (p.sessionId === args.foregroundSessionId) {
      // Marked, not rendered: the inline card owns foreground decisions.
      for (const a of sessionApprovals(p.sessionId, p.name)) {
        out.push({ ...a, isForegroundSession: true });
      }
      continue;
    }
    out.push(...sessionApprovals(p.sessionId, p.name));
  }
  out.push(...personaEntries(args.personaApprovals));
  return out
    .filter((a) => !a.isForegroundSession)
    .sort((a, b) => a.at - b.at);
}

/** Route a decision by source. Session approvals go through the
 *  audited, latched standalone responder; persona approvals resolve the
 *  headless run's promise via the store's responder. */
export function respondUnifiedApproval(a: UnifiedApproval, approved: boolean): void {
  if (a.source === "group-session") {
    respondToApprovalStandalone(a.id, approved);
    return;
  }
  // Persona: the id IS the toolCallId key of the registry entry.
  // groupChatStore's responder audits + resolves the run's decide fn.
  import("../store/groupChatStore").then(({ respondPersonaApproval }) => {
    respondPersonaApproval(a.id, approved);
  });
}

/** Shell-analysis for the rich card (risk hints), best-effort. */
export function shellRiskHint(input: Record<string, unknown> | null): string | null {
  if (!input || typeof input.command !== "string") return null;
  try {
    const info = analyzeShellCommand(input.command);
    return info.warnings[0] ?? null;
  } catch {
    return null;
  }
}

void isShellTool;
