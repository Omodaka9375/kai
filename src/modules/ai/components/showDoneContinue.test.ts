/**
 * Source-contract tests for the "Ended after tool call" / Continue banner
 * suppression during the approval-continuation window.
 *
 * Symptom (user report): "Sometimes it says AI stopped after a tool call and
 * shows a Continue button, but then the agent continues on its own seconds
 * later."
 *
 * Root cause: responding to an approval (manually or via auto-approve) moves
 * the tool part `approval-requested` → `approval-responded`, and the SDK
 * fires a NEW continuation request. Transport prep (project rules, memory,
 * summarization, MCP gathering) + network latency leaves the chat status at
 * `ready` for several seconds; the old `awaitingApproval` check matched only
 * `approval-requested`, so the "showDone" branch rendered "Ended after tool
 * call" + Continue — then the continuation kicked in and the agent resumed
 * "on its own".
 *
 * These tests pin the shipped logic via source contracts (the AiChatView
 * render path can't be mounted without a full Chat + provider mock) plus the
 * exported predicate directly.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { approvalContinuationPending } from "../store/chatStore";

const SRC = readFileSync(new URL("./AiChat.tsx", import.meta.url), "utf8");

describe("approvalContinuationPending (chatStore)", () => {
  it("treats approval-requested as pending continuation", () => {
    expect(
      approvalContinuationPending([
        { type: "text" },
        { type: "tool-bash_run", state: "approval-requested" },
      ]),
    ).toBe(true);
  });

  it("treats approval-responded as pending continuation (the flash bug)", () => {
    // The exact part shape during the continuation window.
    expect(
      approvalContinuationPending([
        { type: "text" },
        {
          type: "tool-write_file",
          state: "approval-responded",
          approval: { id: "a1" },
        },
      ]),
    ).toBe(true);
  });

  it("denied approvals count too — the model sees the denial and continues", () => {
    expect(
      approvalContinuationPending([
        { type: "tool-bash_run", state: "approval-responded" },
      ]),
    ).toBe(true);
  });

  it("does NOT fire on a plain finished tool output", () => {
    expect(
      approvalContinuationPending([
        { type: "tool-bash_run", state: "output-available" },
        { type: "tool-edit", state: "output-error" },
      ]),
    ).toBe(false);
  });

  it("does NOT fire on text-only parts", () => {
    expect(approvalContinuationPending([{ type: "text" }])).toBe(false);
  });

  it("does NOT fire on an empty part list", () => {
    expect(approvalContinuationPending([])).toBe(false);
  });
});

describe("AiChat showDone source contracts", () => {
  it("suppresses showDone via approvalContinuationPending, not just approval-requested", () => {
    // The old inline check matched only approval-requested — the banner
    // flashed during the responded→continuation gap. The call site must use
    // the exported predicate (which covers approval-responded as well).
    expect(SRC).toContain("approvalContinuationPending(parts)");
    expect(SRC).not.toMatch(
      /const\s+awaitingApproval[\s\S]{0,200}"approval-requested"/,
    );
  });

  it("imports approvalContinuationPending from the store", () => {
    expect(SRC).toMatch(
      /import\s*\{[^}]*approvalContinuationPending[^}]*\}\s*from\s*"\.\.\/store\/chatStore"/,
    );
  });
});