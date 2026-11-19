import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPLY_STYLE,
  formatReplyStyleBlock,
  replyStyleActive,
  sanitizeReplyStyle,
} from "./replyStyle";

describe("replyStyle", () => {
  it("emits no block when everything is default", () => {
    expect(formatReplyStyleBlock(DEFAULT_REPLY_STYLE)).toBe("");
    expect(replyStyleActive(DEFAULT_REPLY_STYLE)).toBe(false);
  });

  it("renders each field deterministically", () => {
    const block = formatReplyStyleBlock({
      leadWithTldr: true,
      maxWords: 149,
      questionStyle: "end_of_task",
      interruptOnlyWhenBlocked: true,
    });
    expect(block).toContain("## USER REPLY STYLE");
    expect(block).toContain("Preferences only");
    expect(block).toContain("TL;DR");
    expect(block).toContain("under 149 words");
    expect(block).toContain("END of the task");
    expect(block).toContain("ONLY when work cannot continue");
    // Stable order: tldr, cap, questions, interrupts.
    const i = [
      block.indexOf("TL;DR"),
      block.indexOf("under 149 words"),
      block.indexOf("END of the task"),
      block.indexOf("ONLY when work cannot continue"),
    ];
    expect(i.every((n) => n >= 0)).toBe(true);
    expect([...i].sort((a, b) => a - b)).toEqual(i);
  });

  it("renders partial field sets", () => {
    const block = formatReplyStyleBlock({ ...DEFAULT_REPLY_STYLE, maxWords: 80 });
    expect(block).toContain("under 80 words");
    expect(block).not.toContain("TL;DR");
    expect(block).not.toContain("END of the task");
  });

  it("sanitize clamps bad persisted data", () => {
    const s = sanitizeReplyStyle({
      maxWords: 99_999,
      questionStyle: "garbage" as never,
      leadWithTldr: 1 as never,
    });
    expect(s.maxWords).toBe(2000);
    expect(s.questionStyle).toBe("as_they_come");
    // Strict booleans: persisted JSON garbage (1, "true") never counts as on.
    expect(s.leadWithTldr).toBe(false);
    expect(sanitizeReplyStyle(null)).toEqual(DEFAULT_REPLY_STYLE);
    expect(sanitizeReplyStyle({ maxWords: -5 }).maxWords).toBe(0);
    expect(sanitizeReplyStyle({ leadWithTldr: true }).leadWithTldr).toBe(true);
  });

  it("zero word cap means no cap line", () => {
    expect(
      formatReplyStyleBlock({ ...DEFAULT_REPLY_STYLE, leadWithTldr: true }),
    ).not.toContain("words");
  });
});
