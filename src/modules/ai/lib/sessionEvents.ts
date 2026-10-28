/**
 * Session event journal client — append-only record of the model-visible
 * context assembly for a chat session. The durable evidence behind the
 * dsh-derived invariant "model-visible ⟺ logged": the persisted transcript is
 * the PRE-request UI array, so the request-time projection (which model, the
 * system prompt identity, the <env> block, the vision decision, compaction
 * elisions, the admitted tool set) was never reconstructable. This journal
 * records it without becoming load-bearing for the live transcript (the full
 * event-log-persistence refactor — replacing the message store — is the
 * eventual step; this is the safe first one).
 *
 * Rust side: `session_journal.rs` (mirrors audit.rs — JSONL, per-session file
 * under ~/.kai/sessions/, server-stamped ts, credential-scrubbed values).
 * Fire-and-forget by design: a failed append must never break the run it
 * observes, so nothing here is awaited on a tool's critical path.
 */

import { invoke } from "@tauri-apps/api/core";
import { djb2 } from "./hash";

export type SessionEvent =
  | {
      kind: "turn";
      modelId: string;
      provider: string;
      canSee: boolean;
      planMode: boolean;
      autoApprove: string;
      thinkingMode: string;
      systemHash: number;
      systemLength: number;
      envHash?: number | null;
      toolNames: string[];
      mcpServerCount: number;
      messageCount: number;
    }
  | {
      kind: "compact";
      droppedCount: number;
      contextLimit: number;
    }
  | {
      kind: "summarize";
      fromCount: number;
      toCount: number;
      trigger: "auto" | "manual";
    }
  | {
      kind: "vision-ocr";
      swappedParts: number;
    }
  | {
      kind: "retry";
      reason: string;
      attempt: number;
    }
  | {
      kind: "loop-nudge";
      toolName: string;
      repeatCount: number;
    };

/** Hash a string to a stable 32-bit id for change-detection (NOT security). */
function hashText(s: string): number {
  return djb2(s);
}

/**
 * Build the per-turn event from the values the transport/agent already have
 * in hand. Pure + synchronous so it is unit-testable and cannot throw on the
 * run path. Large payloads (the full system prompt, tool schemas) are reduced
 * to hash + length + the tool NAME list — enough to reconstruct "which
 * context", and bounded.
 */
export function buildTurnEvent(input: {
  modelId: string;
  provider: string;
  canSee: boolean;
  planMode: boolean;
  autoApprove: string;
  thinkingMode: string;
  systemPrompt: string;
  toolNames: string[];
  mcpServerCount: number;
  messageCount: number;
}): SessionEvent {
  return {
    kind: "turn",
    modelId: input.modelId,
    provider: input.provider,
    canSee: input.canSee,
    planMode: input.planMode,
    autoApprove: input.autoApprove,
    thinkingMode: input.thinkingMode,
    systemHash: hashText(input.systemPrompt),
    systemLength: input.systemPrompt.length,
    toolNames: input.toolNames,
    mcpServerCount: input.mcpServerCount,
    messageCount: input.messageCount,
  };
}

/** Best-effort append. NEVER throws, NEVER awaited by callers that matter to
 *  the run — every failure is swallowed to a console debug. */
export function appendSessionEvent(
  sessionId: string,
  event: SessionEvent,
): void {
  appendSessionEvents(sessionId, [event]);
}

export function appendSessionEvents(
  sessionId: string,
  events: SessionEvent[],
): void {
  if (!sessionId || sessionId === "unknown" || events.length === 0) return;
  void invoke("session_events_append", {
    sessionId,
    eventsJson: JSON.stringify(events),
  }).catch((e) => {
    console.debug("[kai] session journal append failed:", e);
  });
}

/** Read a session's recent journal events, newest first (diagnostics). */
export function sessionEventsRecent(
  sessionId: string,
  limit?: number,
): Promise<SessionEvent[]> {
  return invoke<SessionEvent[]>("session_events_recent", {
    sessionId,
    limit: limit ?? 200,
  });
}

/** Drop a session's journal (call on session delete). */
export function sessionEventsClear(sessionId: string): void {
  if (!sessionId) return;
  void invoke("session_events_clear", { sessionId }).catch(() => {});
}
