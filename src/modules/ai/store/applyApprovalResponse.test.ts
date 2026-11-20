import { describe, expect, it, vi } from "vitest";
import { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { applyApprovalResponseToChat, clearSessionStopped, markSessionStopped, settleInterruptedToolMessages, wasSessionStopped, USER_INTERRUPTED_ERROR_TEXT, DEFAULT_DENY_REASON } from "./approvalResponses";

/**
 * The stranded-approval contract (2026-11-09 report: reminder wake parked on
 * an approval card, a ride-along message landed after it, and the Allow
 * click did nothing).
 *
 * The AI SDK's Chat.addToolApprovalResponse only rewrites the approval part
 * on the LAST message and only auto-continues when the last message is the
 * assistant — so any user message appended after the run parked on the card
 * (reminder/watch ride-along, steering, typed text) strands the part and
 * turns every later response into a silent no-op. applyApprovalResponseToChat
 * must: delegate to the SDK when the part is on the last message, and when it
 * is stranded, flip the part state in place and fire the continuation
 * itself (the request builder converts an assistant tool part carrying
 * approval.approved into a tool-approval-response at ANY position).
 */

const APPROVAL_ID = "ap-123";

function approvalPart(approved?: boolean) {
  return {
    type: "tool-bash_run",
    toolCallId: "tc-1",
    state: approved === undefined ? "approval-requested" : "approval-responded",
    input: { command: "echo hi" },
    approval: { id: APPROVAL_ID, ...(approved !== undefined ? { approved } : {}) },
  } as unknown as Record<string, unknown>;
}

function fakeChat(
  messages: UIMessage[],
  overrides: Partial<Pick<Chat<UIMessage>, "status" | "sendMessage" | "addToolApprovalResponse">> = {},
): Chat<UIMessage> {
  return {
    messages,
    status: "ready",
    addToolApprovalResponse: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    ...overrides,
  } as unknown as Chat<UIMessage>;
}

const assistantWithCard = {
  id: "a1",
  role: "assistant",
  parts: [approvalPart()],
} as UIMessage;
const rideAlongUser = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "watch fired" }],
} as UIMessage;

describe("applyApprovalResponseToChat", () => {
  it("delegates to the SDK when the part is on the last message", () => {
    const chat = fakeChat([assistantWithCard]);
    const ok = applyApprovalResponseToChat(chat, APPROVAL_ID, true);
    expect(ok).toBe(true);
    expect(chat.addToolApprovalResponse).toHaveBeenCalledWith({
      id: APPROVAL_ID,
      approved: true,
    });
    // Normal path: no manual rewrite, no manual continuation.
    expect(chat.messages[0].parts[0]).toMatchObject({
      state: "approval-requested",
    });
  });

  it("rewrites a STRANDED part in place and continues the run", () => {
    // Ride-along landed after the run parked on the card: the part sits on
    // an EARLIER message while the last message is a user message.
    const chat = fakeChat([assistantWithCard, rideAlongUser]);
    const ok = applyApprovalResponseToChat(chat, APPROVAL_ID, true);
    expect(ok).toBe(true);
    expect(chat.messages[0].parts[0]).toMatchObject({
      state: "approval-responded",
      approval: { id: APPROVAL_ID, approved: true },
    });
    // The ride-along user message is untouched.
    expect(chat.messages[1]).toBe(rideAlongUser);
    // Continuation fired, the SDK applier (which would no-op) was not used.
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();
  });

  it("defers a stranded-part continuation while a request is in flight", () => {
    // 2026-11-20 card-stall fix: the in-flight request holds a message
    // SNAPSHOT, so skipping the send used to strand the approval forever.
    // The continuation is now DEFERRED until the chat settles - never
    // dropped. Synchronously nothing fires.
    const chat = fakeChat([assistantWithCard, rideAlongUser], {
      status: "streaming",
    });
    const ok = applyApprovalResponseToChat(chat, APPROVAL_ID, false);
    expect(ok).toBe(true);
    expect(chat.messages[0].parts[0]).toMatchObject({
      state: "approval-responded",
      approval: { id: APPROVAL_ID, approved: false },
    });
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it("the deferred continuation fires once the chat settles", async () => {
    vi.useFakeTimers();
    try {
      const chat = fakeChat([assistantWithCard, rideAlongUser], {
        status: "streaming",
      });
      applyApprovalResponseToChat(chat, APPROVAL_ID, true);
      // Status flips to ready (the in-flight request ended) - the poll must
      // continue the run instead of silently dropping it.
      (chat as { status: string }).status = "ready";
      await vi.advanceTimersByTimeAsync(300);
      expect(chat.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns false for an unknown/stale approval id", () => {
    const chat = fakeChat([assistantWithCard, rideAlongUser]);
    const ok = applyApprovalResponseToChat(chat, "ap-gone", true);
    expect(ok).toBe(false);
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it("a denial carries a reason the model sees (default when none given)", () => {
    // 2026-11-17: the SDK's execution-denied tool result includes `reason`.
    // Without one the model got a bare denial and improvised (user report:
    // "agent got confused after denying"). Approvals carry NO reason.
    const chat = fakeChat([assistantWithCard]);
    applyApprovalResponseToChat(chat, APPROVAL_ID, false);
    const call = (chat.addToolApprovalResponse as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      approved: boolean;
      reason?: string;
    };
    expect(call.approved).toBe(false);
    expect(call.reason).toBe(DEFAULT_DENY_REASON);

    const approved2 = fakeChat([assistantWithCard]);
    applyApprovalResponseToChat(approved2, APPROVAL_ID, true);
    const call2 = (approved2.addToolApprovalResponse as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      approved: boolean;
      reason?: string;
    };
    expect(call2.approved).toBe(true);
    expect(call2.reason).toBeUndefined();
  });

  it("a custom deny reason overrides the default, including stranded parts", () => {
    const chat = fakeChat([assistantWithCard, rideAlongUser]);
    applyApprovalResponseToChat(chat, APPROVAL_ID, false, "custom reason");
    expect(chat.messages[0].parts[0]).toMatchObject({
      state: "approval-responded",
      approval: { id: APPROVAL_ID, approved: false, reason: "custom reason" },
    });
    const direct = fakeChat([assistantWithCard]);
    applyApprovalResponseToChat(direct, APPROVAL_ID, false, "custom reason");
    expect(direct.addToolApprovalResponse).toHaveBeenCalledWith(
      expect.objectContaining({ approved: false, reason: "custom reason" }),
    );
  });
});

describe("session stop marker", () => {
  it("marks and clears only the interrupted session", () => {
    markSessionStopped("interrupted");
    expect(wasSessionStopped("interrupted")).toBe(true);
    expect(wasSessionStopped("next")).toBe(false);
    clearSessionStopped("interrupted");
    expect(wasSessionStopped("interrupted")).toBe(false);
  });

  it("records a real SDK stop before the final interrupted-run callback", async () => {
    const onFinish = vi.fn();
    const chat = new Chat({
      id: "interrupted-turn",
      transport: {
        async sendMessages({ abortSignal }: { abortSignal: AbortSignal }) {
          await new Promise<void>((resolve) => {
            if (abortSignal.aborted) { resolve(); return; }
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
          return new ReadableStream({ start: (controller) => controller.close() });
        },
        async reconnectToStream() { return null; },
      } as never,
      onFinish,
    });
    void chat.sendMessage({ text: "run one" });
    await vi.waitFor(() => expect(chat.status).toBe("submitted"));
    await chat.stop();
    await vi.waitFor(() => expect(onFinish).toHaveBeenCalledOnce());
    expect(onFinish.mock.calls[0]![0]).toMatchObject({ isAbort: true });
    expect(chat.status).toBe("ready");
  });
});

describe("settleInterruptedToolMessages", () => {
  it("settles executing tool calls without deleting assistant text", () => {
    const text = { type: "text", text: "Before interruption" };
    const running = { type: "tool-bash_run", state: "input-available" };
    const preparing = { type: "tool-bash_run", state: "input-streaming" };
    const done = { type: "tool-bash_run", state: "output-available" };
    const messages = [{ id: "a1", role: "assistant", parts: [text, running, preparing, done] }] as UIMessage[];
    const settled = settleInterruptedToolMessages(messages);
    expect(settled[0]!.parts[0]).toBe(text);
    expect(settled[0]!.parts[1]).toMatchObject({
      state: "output-error",
      errorText: USER_INTERRUPTED_ERROR_TEXT,
    });
    expect(settled[0]!.parts[2]).toMatchObject({ state: "output-error" });
    expect(settled[0]!.parts[3]).toBe(done);
  });

  it("interrupted calls carry the exported sentinel (canceled pill contract)", () => {
    // The Tool card renders "canceled" (muted) instead of the red "failed"
    // pill when errorText === USER_INTERRUPTED_ERROR_TEXT. The sentinel is
    // compared by identity via the export, so pin that settle writes EXACTLY
    // that constant (a drift here silently flips every interrupted card back
    // to "failed").
    const running = { type: "tool-bash_run", state: "input-available" };
    const messages = [{ id: "a1", role: "assistant", parts: [running] }] as UIMessage[];
    const settled = settleInterruptedToolMessages(messages);
    expect((settled[0]!.parts[0] as { errorText?: string }).errorText).toBe(
      USER_INTERRUPTED_ERROR_TEXT,
    );
    expect(USER_INTERRUPTED_ERROR_TEXT).toBe("Command stopped by the user.");
  });

  it("revokes the approval response so an aborted command cannot self-resume", () => {
    const messages = [{
      id: "a1", role: "assistant",
      parts: [approvalPart(true)],
    }] as UIMessage[];
    const settled = settleInterruptedToolMessages(messages);
    expect(settled[0]!.parts[0]).toMatchObject({
      state: "output-error", toolCallId: "tc-1",
    });
    expect(lastAssistantMessageIsCompleteWithApprovalResponses({ messages: settled })).toBe(false);
  });

  it("scopes cleanup to the interrupted command, not a newly dispatched one", () => {
    const messages = [{
      id: "a1", role: "assistant", parts: [
        { ...approvalPart(true), toolCallId: "old" },
        { ...approvalPart(), toolCallId: "next", state: "input-available" },
      ],
    }] as UIMessage[];
    const settled = settleInterruptedToolMessages(messages, new Set(["old"]));
    expect(settled[0]!.parts[0]).toMatchObject({ state: "output-error" });
    expect(settled[0]!.parts[1]).toMatchObject({ state: "input-available" });
  });

  it("leaves pending approval cards for the approval release path", () => {
    const messages = [assistantWithCard, rideAlongUser];
    expect(settleInterruptedToolMessages(messages)).toBe(messages);
  });

  it("returns the same array when nothing is executing", () => {
    const messages = [rideAlongUser];
    expect(settleInterruptedToolMessages(messages)).toBe(messages);
  });
});
