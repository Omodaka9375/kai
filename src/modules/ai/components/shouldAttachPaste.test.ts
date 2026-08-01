import { describe, expect, it } from "vitest";
import { shouldAttachPaste } from "./AiInputBar";

describe("shouldAttachPaste", () => {
  it("keeps short single-line pastes inline", () => {
    expect(shouldAttachPaste("fix the typo in main.ts")).toBe(false);
    expect(shouldAttachPaste("const x = 42;")).toBe(false);
  });

  it("attaches long pastes", () => {
    expect(shouldAttachPaste("a".repeat(800))).toBe(true);
  });

  it("attaches many-line pastes", () => {
    expect(shouldAttachPaste("l1\nl2\nl3\nl4\nl5\nl6")).toBe(true);
    expect(shouldAttachPaste("l1\nl2\nl3")).toBe(false);
  });

  it("attaches pastes with very long unbroken lines", () => {
    expect(shouldAttachPaste(`short\n${"x".repeat(400)}`)).toBe(true);
  });

  it("attaches markdown structure", () => {
    expect(shouldAttachPaste("| col | col2 |\n|-----|------|")).toBe(true);
    expect(shouldAttachPaste("```ts\nconst x = 1;\n```")).toBe(true);
    expect(shouldAttachPaste("# Title\nsome text")).toBe(true);
    expect(shouldAttachPaste("- [ ] todo item")).toBe(true);
  });

  it("handles empty input", () => {
    expect(shouldAttachPaste("")).toBe(false);
  });
});
