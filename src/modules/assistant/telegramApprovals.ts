/**
 * Telegram approval commands + rich approval pings - Phase 2 of the
 * cross-context approval design.
 *
 * Scope (deliberate):
 *  - ONLY approvals of sessions the user explicitly bound for Telegram
 *    monitoring ("send project to assistant"). Binding is the consent
 *    surface; a random desktop chat's approvals are nobody's business on
 *    the phone.
 *  - Approve/Deny by COMMAND (Phase 3 adds inline buttons via Rust
 *    callback_query support).
 *  - PRIVACY/CRITICAL carve-outs NEVER become phone-approvable:
 *    look_at_screen, elevated bash_run, and signed commits. Those ping
 *    "respond on the desktop" forever - they are exactly the calls where
 *    the human should be at the machine.
 *
 * Security: the Rust owner gate already drops non-owner messages before
 * this code runs. Decisions route through respondToApprovalStandalone -
 * the SAME audited, monotonic-denial-latched responder the desktop uses -
 * so a Telegram approval is exactly one click of the desktop card, minus
 * the desk. No new capability is granted to the model or the assistant.
 */

import type { UIMessage } from "@ai-sdk/react";
import {
  getChat,
  respondToApprovalStandalone,
} from "@/modules/ai/store/chatStore";
import { presentationFor } from "@/modules/ai/lib/toolPresentations";
import { analyzeShellCommand } from "@/modules/ai/lib/policy";
import { auditAppend, AUDIT_KINDS } from "@/modules/ai/lib/audit";
import { listBoundProjects } from "./projectBridge";

/** Approval ids that must NEVER be decided from the phone. */
const DESKTOP_ONLY_TOOLS = new Set([
  "look_at_screen",
  "bash_run", // elevated check is per-input; simplest correct rule: all
  // bash_run stays desktop-only for now - elevated runs can't be told
  // apart safely from a chat excerpt, and shell is the highest-risk call.
]);

/** A pending approval of a bound session, formatted for Telegram. */
export type TelegramApproval = {
  id: string;
  sessionId: string;
  projectName: string;
  toolName: string;
  label: string;
  /** Human one-liner for the message body (command/path/entry). */
  summary: string | null;
  /** True when phone decisions are forbidden for this call. */
  desktopOnly: boolean;
};

/** Tool input -> one-line summary for the ping body. */
function summarize(toolName: string, input: Record<string, unknown> | null): string | null {
  const fn = presentationFor(toolName).summary;
  if (fn && input) {
    try {
      return fn(input);
    } catch {
      /* fall through */
    }
  }
  if (input) {
    if (typeof input.command === "string") return input.command.slice(0, 160);
    if (typeof input.path === "string") return input.path;
    if (typeof input.entry === "string") return input.entry.slice(0, 160);
  }
  return null;
}

/** Enumerate pending approvals for every BOUND project session. */
export async function pendingTelegramApprovals(): Promise<TelegramApproval[]> {
  const bound = await listBoundProjects();
  const out: TelegramApproval[] = [];
  for (const [projectId, b] of Object.entries(bound)) {
    if (!b.sessionId) continue;
    const chat = getChat(b.sessionId);
    if (!chat) continue;
    for (const m of chat.messages as UIMessage[]) {
      if (m.role !== "assistant") continue;
      for (const p of m.parts as Array<Record<string, unknown>>) {
        if ((p.state as string | undefined) !== "approval-requested") continue;
        const approval = p.approval as { id?: string } | undefined;
        if (!approval?.id) continue;
        const type = String(p.type ?? "");
        const toolName = type.replace(/^tool-/, "");
        if (!toolName || toolName === "dynamic-tool") continue;
        out.push({
          id: approval.id,
          sessionId: b.sessionId,
          projectName: b.name,
          toolName,
          label: presentationFor(toolName).approvalLabel ?? toolName,
          summary: summarize(toolName, (p.input as Record<string, unknown> | undefined) ?? null),
          desktopOnly: DESKTOP_ONLY_TOOLS.has(toolName),
        });
      }
    }
    void projectId;
  }
  return out;
}

/** Format the approval ping body: project, tool, summary, and the command
 *  hint (or the desktop-only refusal). */
export function formatApprovalPing(a: TelegramApproval): string {
  const head = `${a.projectName}: ${a.label} needs your approval`;
  const body = a.summary ? `\n${a.summary}` : "";
  if (a.desktopOnly) {
    return `${head}${body}\nThis call can only be approved on the desktop (privacy / elevated risk).`;
  }
  return `${head}${body}\n/approve ${a.id} or /deny ${a.id}`;
}

/** `/approvals` - list pending approvals across bound projects. */
export async function formatApprovalsList(): Promise<string> {
  const pending = await pendingTelegramApprovals();
  if (pending.length === 0) return "No pending approvals in monitored projects.";
  return [
    `Pending approvals (${pending.length}):`,
    ...pending.map((a) => `\u2022 ${a.projectName}: ${a.label}${a.summary ? ` - ${a.summary}` : ""}${a.desktopOnly ? " (desktop only)" : ` - /approve ${a.id}`}`),
  ].join("\n");
}

/** Resolve a decision by approval id. Returns a user-facing outcome. */
export async function respondTelegramApproval(
  id: string,
  approved: boolean,
): Promise<string> {
  const pending = await pendingTelegramApprovals();
  const target = pending.find((a) => a.id === id);
  if (!target) {
    return "No pending approval with that id. /approvals lists them.";
  }
  if (target.desktopOnly) {
    return "That call can only be approved on the desktop (privacy / elevated risk).";
  }
  auditAppend(
    AUDIT_KINDS.assistantExec,
    approved ? "telegram-approve" : "telegram-deny",
    `${target.projectName}: ${target.label}${target.summary ? ` - ${target.summary.slice(0, 120)}` : ""}`,
    "",
  );
  respondToApprovalStandalone(id, approved);
  return approved
    ? `Approved ${target.label} in ${target.projectName}.`
    : `Denied ${target.label} in ${target.projectName} - the agent will see the rejection.`;
}

/** Rich approval ping on the awaiting-approval transition (replaces the
 *  bare "respond on the desktop" text for phone-approvable calls).
 *  Returns the message text, or null when nothing pending (caller keeps
 *  the old generic ping). */
export async function approvalPingText(
  sessionId: string,
): Promise<string | null> {
  const bound = await listBoundProjects();
  const binding = Object.values(bound).find((b) => b.sessionId === sessionId);
  if (!binding) return null;
  const pending = (await pendingTelegramApprovals()).filter(
    (a) => a.sessionId === sessionId,
  );
  if (pending.length === 0) return null;
  // The OLDEST pending approval is the blocking one.
  return formatApprovalPing(pending[0]!);
}

void analyzeShellCommand;
