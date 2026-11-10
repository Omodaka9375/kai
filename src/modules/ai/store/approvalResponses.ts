import type { Chat, UIMessage } from "@ai-sdk/react";

/**
 * Approval response toolkit — the PURE part of the approval plumbing,
 * extracted from chatStore.ts (2026-11-10 god-file cleanup; the store kept
 * only the responder ROUTING).
 *
 * Everything here is pure over its arguments: no zustand reads, no module
 * maps, no side effects beyond the passed Chat's own SDK methods. That is
 * what made the 2026-11-08 stranded-approval fix testable in isolation
 * (applyApprovalResponse.test.ts) and it is the invariant to keep: the
 * store routes, this file applies.
 *
 * The AI SDK's `Chat.addToolApprovalResponse` only rewrites the approval part
 * on the LAST message and only auto-continues when that last message is the
 * assistant holding the responded approval. Both properties break the moment
 * a ride-along message lands after the run parked on the card (a reminder or
 * watch fire appended by injectMessage's passive ride-along, a steering
 * message, or user text): the part gets STRANDED on an earlier assistant
 * message and every later response — human click or auto-approve — becomes a
 * silent no-op (the click "does nothing", the card pins forever, verified
 * against ai@6.0.168 dist).
 */

export type ApprovalResponder = (
  approvalId: string,
  approved: boolean,
) => void;

/** Tool-part states that count as fully resolved (safe to keep). */
export const COMPLETE_PART_STATES = new Set([
  "output-available",
  "output-error",
  "approval-responded",
]);

/**
 * True when a message's parts hold an approval that is pending OR just
 * responded - i.e. the SDK is about to (or may) fire a continuation request
 * for this turn. Used by the chat UI to suppress the "Ended after tool
 * call" + Continue banner: responding to an approval moves the part from
 * `approval-requested` to `approval-responded`, and the follow-up request
 * then goes through transport prep (project rules, memory, summarization,
 * MCP gathering) + network latency - a multi-second window in which the
 * status is `ready` and the run LOOKS finished. The banner flashes, then
 * "the agent continues on its own". A denied approval also continues (the
 * model sees the denial), so ANY responded approval counts as pending
 * continuation, not just approved ones.
 */
export function approvalContinuationPending(
  parts: ReadonlyArray<unknown>,
): boolean {
  return parts.some((p) => {
    const st = (p as { state?: string }).state ?? "";
    return st === "approval-requested" || st === "approval-responded";
  });
}

/**
 * True when a chat holds any assistant part still awaiting an approval
 * decision. Exported (2026-11-04 group-chat review): the group delivery path
 * (deliverToParticipant) needs the SAME pending-approval awareness - a
 * session parked on an approval card is busy, not idle, or its delivery
 * gets armed + injected and then silently parked by injectMessage's own
 * (stricter) gate. One definition, two call sites.
 */
export function hasPendingApprovals(chat: Chat<UIMessage>): boolean {
  for (const m of chat.messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts as unknown[]) {
      if (approvalContinuationPending([p])) return true;
    }
  }
  return false;
}

/**
 * Apply an approval decision to the chat that owns it.
 *
 * When the part sits on the last message, delegate to the SDK (normal
 * flow, jobExecutor-ordered). When it is stranded on an earlier message,
 * flip the part state directly — the request builder converts ANY assistant
 * tool part carrying `approval.approved` into a `tool-approval-response`
 * regardless of position — and fire the continuation ourselves, carrying
 * whatever rode along. Returns false when no matching pending part exists
 * (stale id — callers already treat that as a no-op).
 */
export function applyApprovalResponseToChat(
  chat: Chat<UIMessage>,
  approvalId: string,
  approved: boolean,
): boolean {
  const messages = chat.messages;
  let holderIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = (messages[i].parts ?? []) as Array<{
      state?: string;
      approval?: { id?: string };
    }>;
    if (
      parts.some(
        (p) => p.state === "approval-requested" && p.approval?.id === approvalId,
      )
    ) {
      holderIdx = i;
      break;
    }
  }
  if (holderIdx === -1) return false;

  if (holderIdx === messages.length - 1) {
    void chat.addToolApprovalResponse({ id: approvalId, approved });
    return true;
  }

  // Stranded part: rewrite it in place (same shape the SDK's applier writes:
  // state approval-responded + approval {id, approved}) and continue the run.
  chat.messages = messages.map((m, i) => {
    if (i !== holderIdx) return m;
    return {
      ...m,
      parts: (m.parts ?? []).map((p) => {
        const part = p as { state?: string; approval?: { id?: string } };
        if (
          part.state === "approval-requested" &&
          part.approval?.id === approvalId
        ) {
          return {
            ...p,
            state: "approval-responded",
            approval: { id: approvalId, approved },
          } as typeof p;
        }
        return p;
      }),
    } as UIMessage;
  });
  // Continue the run over the (rewritten) history. If another request is
  // already in flight, skip: the next request builder pass picks the
  // approval-response up from any position.
  if (chat.status !== "streaming" && chat.status !== "submitted") {
    void chat.sendMessage().catch((e) => {
      console.warn("[kai] approval continuation failed:", e);
    });
  }
  return true;
}
