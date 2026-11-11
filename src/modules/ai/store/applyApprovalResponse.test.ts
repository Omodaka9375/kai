import { describe, expect, it, vi } from "vitest";
import type { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { applyApprovalResponseToChat, clearSessionStopped, markSessionStopped, settleInterruptedToolMessages, wasSessionStopped } from "./approvalResponses";

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

  it("denies a stranded part without continuing into an in-flight run", () => {
    const chat = fakeChat([assistantWithCard, rideAlongUser], {
      status: "streaming",
    });
    const ok = applyApprovalResponseToChat(chat, APPROVAL_ID, false);
    expect(ok).toBe(true);
    expect(chat.messages[0].parts[0]).toMatchObject({
      state: "approval-responded",
      approval: { id: APPROVAL_ID, approved: false },
    });
    // A request is already in flight: the next request-builder pass picks
    // the response up from history — do not stack a second one.
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it("returns false for an unknown/stale approval id", () => {
    const chat = fakeChat([assistantWithCard, rideAlongUser]);
    const ok = applyApprovalResponseToChat(chat, "ap-gone", true);
    expect(ok).toBe(false);
    expect(chat.sendMessage).not.toHaveBeenCalled();
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
      errorText: "Command stopped by the user.",
    });
    expect(settled[0]!.parts[2]).toMatchObject({ state: "output-error" });
    expect(settled[0]!.parts[3]).toBe(done);
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
