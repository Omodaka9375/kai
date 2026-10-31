import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Group composer @-mention targeting (2026-10-31).
 *
 * User ask: "Instead of All dropdown on left of the input let me tag
 * agents in group chat with @" — the composer's Popover target picker is
 * replaced by @-mentions in the textarea:
 *   - typing "@" opens a picker over participants (+ "All" to clear)
 *   - picking inserts "@Name " into the text; "All" clears the token
 *   - arrows + Enter/Tab pick; Escape closes
 *   - on send, the LAST @-mention targets that participant (the mention
 *     stays in the text so the agent sees itself addressed); no mention =
 *     everyone (same single-target semantics the dropdown had).
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const panel = read("../components/GroupChatPanelView.tsx");

import { resolveGroupMentionTarget } from "../components/GroupChatPanelView";

const PARTS = [
  { projectId: "p-alpha", name: "alpha", sessionId: "s-a", root: "/a", joinedAt: 0 },
  { projectId: "p-beta", name: "beta", sessionId: "s-b", root: "/b", joinedAt: 0 },
  { projectId: "p-sec", name: "Security Reviewer", sessionId: "s-c", root: "/c", joinedAt: 0 },
] as const;

describe("resolveGroupMentionTarget — default all, anywhere-in-message matching", () => {
  it("no mention = everyone (undefined)", () => {
    expect(resolveGroupMentionTarget("hello team", [...PARTS])).toBeUndefined();
  });

  it("a mention at the BEGINNING targets that agent", () => {
    expect(resolveGroupMentionTarget("@alpha did the tests pass?", [...PARTS])).toBe("p-alpha");
  });

  it("a mention MID-SENTENCE targets that agent", () => {
    expect(resolveGroupMentionTarget("hey, can @alpha check the build today?", [...PARTS])).toBe("p-alpha");
  });

  it("stray non-matching @tokens never strip a real mention (default all)", () => {
    expect(resolveGroupMentionTarget("@alpha look at test@2 and user@host", [...PARTS])).toBe("p-alpha");
  });

  it("prefix + case-insensitive matching; last MATCHING mention wins", () => {
    expect(resolveGroupMentionTarget("@SEC check the report", [...PARTS])).toBe("p-sec");
    expect(resolveGroupMentionTarget("@alpha and then @beta please reply", [...PARTS])).toBe("p-beta");
  });

  it("only stray tokens = everyone, not a wrong target", () => {
    expect(resolveGroupMentionTarget("check test@2 and user@host", [...PARTS])).toBeUndefined();
  });
});

describe("composer @-mention targeting (replaces the All dropdown)", () => {
  it("the dropdown trigger is gone; @-mention drives targeting", () => {
    // The old Popover trigger button (title="Send to…") is gone.
    expect(panel).not.toContain('title="Send to…"');
    // No setTarget dropdown state remains.
    expect(panel).not.toMatch(/setTarget\(/);
    // Mention state + picker + insertion drive the composer.
    expect(panel).toContain("setMention(");
    expect(panel).toContain("pickMention(");
    expect(panel).toContain("onTextChange(");
  });

  it("the last MATCHING mention in the text is the send target (resolver)", () => {
    // The resolver is exported + used by the composer's send path.
    expect(panel).toContain("export function resolveGroupMentionTarget(");
    expect(panel).toContain("resolveGroupMentionTarget(text, group.participants)");
    expect(panel).toContain(
      "await sendGroupMessage(group.id, composed, mentionedTarget);",
    );
  });

  it("keyboard: arrows navigate, Enter/Tab pick, Escape closes", () => {
    expect(panel).toMatch(/"ArrowDown"[\s\S]{0,420}"ArrowUp"/);
    expect(panel).toContain('e.key === "Enter" || e.key === "Tab"');
    expect(panel).toMatch(/"Escape"[\s\S]{0,120}setMention/);
  });

  it("the picker offers All (clear targeting) plus participants", () => {
    expect(panel).toContain("All — send to everyone");
    expect(panel).toMatch(/ParticipantDot participant=\{/);
  });

  it("the textarea pads vertically so the caret/placeholder sit centered (not glued to the top)", () => {
    // min-h-8 (32px) around a ~20px line with no vertical padding left the
    // caret + placeholder flush with the top edge (textarea content always
    // renders at the top of its box). py-1.5 centers the single line.
    expect(panel).toMatch(
      /bg-transparent px-1 py-1\.5 text-\[12\.5px\]/,
    );
  });
});