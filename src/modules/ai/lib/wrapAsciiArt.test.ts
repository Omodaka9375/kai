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

  it("leaves a blockquoted shell fence and its backslash continuations intact", () => {
    const input = [
      "> Decision: review-time enforcement.",
      ">",
      "> ```bash",
      "> set -o pipefail",
      "> docker run --rm --env-file /srv/dreamwork-shadow/config/shadow.env \\",
      ">   dreamwork-shadow:87fd42ea6 \\",
      ">   node /app/apps/api/dist/scripts/shadow-readonly-role-verify.js \\",
      ">   2>&1 | tee /srv/dreamwork-shadow/reports/role-verify.txt",
      "> ```",
      "> Valid evidence requires **all three** checks.",
    ].join("\n");
    // The continuation lines used to be classified as ASCII art because they
    // start with `>` and end in `\`. That injected a ```text fence between
    // the third and fourth command lines, leaking the rest outside the code
    // block and unbalancing the surrounding blockquoted fence.
    expect(wrapAsciiArt(input)).toBe(input);
  });

  it("leaves Markdown blockquotes alone even when prose contains frame chars", () => {
    const input = "> Use <left> and <right> | exactly as shown.\n> Next line";
    expect(wrapAsciiArt(input)).toBe(input);
  });

  it("recognizes fences nested in lists and longer fence delimiters", () => {
    const input = [
      "- command:",
      "  ````bash",
      "  printf '%s' \"```\",",
      "  next --flag \\",
      "  ````",
      "- after",
    ].join("\n");
    expect(wrapAsciiArt(input)).toBe(input);
  });

  it("recognizes tilde fences and does not confuse an info string with a close", () => {
    const input = [
      "~~~text",
      "> this is code, not a blockquote",
      "~~~javascript",
      "still code",
      "~~~",
      "after",
    ].join("\n");
    expect(wrapAsciiArt(input)).toBe(input);
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
