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

  it("the last @-mention in the text is the send target", () => {
    expect(panel).toMatch(/mentionedTarget[\s\S]{0,300}?matchAll\(/);
    expect(panel).toContain(
      "await sendGroupMessage(group.id, composed, mentionedTarget);",
    );
    // No mention = undefined target = everyone.
    expect(panel).toContain("tokens.length === 0) return undefined;");
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
});