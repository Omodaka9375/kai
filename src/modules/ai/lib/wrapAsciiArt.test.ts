import { describe, expect, it } from "vitest";
import { wrapAsciiArt } from "./wrapAsciiArt";

// Reproductions of the reported bug: markdown headings / horizontal rules /
// underscore placeholders getting wrapped in ```text fences as if they were
// ASCII art.

describe("wrapAsciiArt — markdown structure must not become art", () => {
  it("leaves a setext-style title + underline alone", () => {
    const input = "## Title\n---\n\nbody text";
    expect(wrapAsciiArt(input)).toBe(input);
  });

  it("leaves ATX headings of any depth alone", () => {
    const input = "### Subtitle\n#### Deeper\n\ncontent";
    expect(wrapAsciiArt(input)).toBe(input);
  });

  it("leaves a title followed by a horizontal rule alone", () => {
    const input = "## Heading\n\n---\n\nnext";
    expect(wrapAsciiArt(input)).toBe(input);
  });

  it("does not fence an underscore placeholder", () => {
    const input = "_ _ _ _ _";
    expect(wrapAsciiArt(input)).toBe(input);
  });

  it("leaves a markdown table alone", () => {
    const input = "| A | B |\n|---|---|\n| 1 | 2 |";
    expect(wrapAsciiArt(input)).toBe(input);
  });

  it("leaves a bold heading starting with **# alone", () => {
    const input = "**#1 — Case-insensitive workspace identity**";
    expect(wrapAsciiArt(input)).toBe(input);
  });

  it("leaves a bold list-item lead starting with **# alone", () => {
    const input = "- **#1 — Fix** rest of line";
    expect(wrapAsciiArt(input)).toBe(input);
  });

  it("leaves a bold-italic underline lead alone", () => {
    const input = "___Title___ and more text";
    expect(wrapAsciiArt(input)).toBe(input);
  });

  it("still fences ASCII art with + and | frame chars", () => {
    const input = "+-----+\n| hi  |\n+-----+";
    expect(wrapAsciiArt(input)).toBe("```text\n" + input + "\n```");
  });

  it("still fences an art block whose border line is a pure char run", () => {
    const input = "-----+\n| hi |\n+----+";
    expect(wrapAsciiArt(input)).toBe("```text\n" + input + "\n```");
  });

  it("still fences real box-drawing diagrams", () => {
    const input = "┌─────┐\n│ hi  │\n└─────┘";
    expect(wrapAsciiArt(input)).toBe("```text\n" + input + "\n```");
  });

  it("still fences ASCII-only diagrams with + and |", () => {
    const input = "+---+\n| x |\n+---+";
    expect(wrapAsciiArt(input)).toBe("```text\n" + input + "\n```");
  });
});
