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
  reason?: string,
) => void;

/** Default denial reason the model sees in its `execution-denied` tool
 *  result (the SDK carries `reason` from addToolApprovalResponse through
 *  the tool-approval-response into the model-bound history). Without it the
 *  model gets a bare `execution-denied` with no explanation and improvises
 *  — the 2026-11-17 "agent got confused after denying a card" report. */
export const DEFAULT_DENY_REASON =
  "The user denied this tool call on the approval card. Do not retry it or continue the plan — acknowledge the denial, ask what they would like instead, and wait.";

/** Sentinel errorText settleInterruptedToolMessages writes for calls the
 *  USER interrupted (Stop button / abort). Lets the UI render "canceled"
 *  (muted) instead of the red "failed" pill — an interrupted command is a
 *  user decision, not a failure. Compare by identity, not substring, so an
 *  identical-looking errorText from a real failure cannot mask as canceled. */
export const USER_INTERRUPTED_ERROR_TEXT = "Command stopped by the user.";

const stoppedSessions = new Set<string>();

export function markSessionStopped(sessionId: string): void {
  stoppedSessions.add(sessionId);
}

export function wasSessionStopped(sessionId: string): boolean {
  return stoppedSessions.has(sessionId);
}

export function clearSessionStopped(sessionId: string): void {
  stoppedSessions.delete(sessionId);
}

/** Tool-part states that count as fully resolved (safe to keep). */
export const COMPLETE_PART_STATES = new Set([
  "output-available",
  "output-error",
  "approval-responded",
]);

/** The SDK stops the request but does not synthesize results for executing
 *  tools. Give interrupted calls a terminal UI/persistence state instead of
 *  leaving them "running" forever. Pending approval cards are handled by
 *  releasePendingApprovals below, not mislabeled as command failures.
 *
 *  CRITICAL: approval-responded means the SDK will start a continuation
 *  automatically. Converting only the ERROR state leaves the approval marker
 *  intact, so a stopped approved command self-resumes as soon as its abort
 *  finishes. Delete that marker as well. When interruptedToolCallIds is
 *  supplied, calls not in the set belong to a later turn and must not be
 *  touched by this delayed cleanup. */
export function settleInterruptedToolMessages(
  messages: UIMessage[],
  interruptedToolCallIds?: ReadonlySet<string>,
): UIMessage[] {
  let changed = false;
  const settled = messages.map((m) => {
    if (m.role !== "assistant") return m;
    let messageChanged = false;
    const parts = m.parts.map((p) => {
      const part = p as Record<string, unknown>;
      const type = String(part.type ?? "");
      const state = String(part.state ?? "");
      const callId = (part as { toolCallId?: unknown }).toolCallId;
      if (
        interruptedToolCallIds &&
        (typeof callId !== "string" || !interruptedToolCallIds.has(callId))
      ) return p;
      if ((!type.startsWith("tool-") && type !== "dynamic-tool") ||
          !["input-available", "input-streaming", "approval-responded"].includes(state)) {
        return p;
      }
      changed = true;
      messageChanged = true;
      const { approval: _revokedContinuation, ...rest } = part;
      return {
        ...rest,
        state: "output-error",
        errorText: USER_INTERRUPTED_ERROR_TEXT,
      };
    });
    return messageChanged ? { ...m, parts } as UIMessage : m;
  });
  return changed ? settled : messages;
}

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
  // APPROVAL-REQUESTED anywhere = genuinely pending (a card awaits a
  // decision). APPROVAL-RESPONDED is pending only in the LIVE continuation
  // window - the SDK is about to fire the follow-up request while the last
  // message still holds the responded part. Once the continuation appends
  // new messages, the responded part is HISTORY: counting it forever made
  // any session that ever answered a card read "busy" for the rest of its
  // life (2026-11-26 group-chat report: a settled, idle agent got "queued
  // (busy)" on every later delivery because its OLD approval-responded
  // parts never left the history; the same staleness pinned LRU eviction,
  // /compact, and injectMessage). approvalContinuationPending (the banner
  // suppressor) keeps its broader semantics - it guards a UI flash on the
  // LIVE tail, not a busy decision.
  for (const m of chat.messages) {
    if (m.role !== "assistant") continue;
    const isLast = m === chat.messages[chat.messages.length - 1];
    for (const p of m.parts as unknown[]) {
      const st = (p as { state?: string }).state ?? "";
      if (st === "approval-requested") return true;
      if (isLast && st === "approval-responded") return true;
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
  reason?: string,
): boolean {
  // Every denial carries a reason the model can act on; approvals never do.
  const effectiveReason = !approved ? (reason ?? DEFAULT_DENY_REASON) : undefined;
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
    void chat.addToolApprovalResponse({ id: approvalId, approved, reason: effectiveReason });
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
            approval: { id: approvalId, approved, reason: effectiveReason },
          } as typeof p;
        }
        return p;
      }),
    } as UIMessage;
  });
  // Continue the run over the (rewritten) history. If another request is
  // already in flight, DEFER (2026-11-20 card-stall fix): there is no
  // "next request builder pass" - the in-flight request holds a message
  // SNAPSHOT (transport.sendMessages receives this.state.messages), so a
  // skipped send stranded the approval forever and the run stalled
  // silently. Wait for the chat to settle, then continue.
  continueWhenReady(chat);
  return true;
}

/** Poll until the chat is idle, then fire the continuation request.
 *  Capped (~30s) so a wedged run can't spin forever - after the cap the
 *  next user action (pill toggle, new message) retries via the bridge's
 *  unlatched-id re-scan. */
const CONTINUE_POLL_MS = 250;
const CONTINUE_MAX_ATTEMPTS = 120;
function continueWhenReady(chat: Chat<UIMessage>, attempt = 0): void {
  if (chat.status === "ready") {
    void chat.sendMessage().catch((e) => {
      console.warn("[kai] approval continuation failed:", e);
    });
    return;
  }
  // "error" or a wedged run: give up silently - the stale-approval reaper
  // and the bridge's unlatched re-scan own recovery from here.
  if (attempt >= CONTINUE_MAX_ATTEMPTS) return;
  setTimeout(() => continueWhenReady(chat, attempt + 1), CONTINUE_POLL_MS);
}
