import { describe, expect, it } from "vitest";
import { stripLeakedTokens, isBlankMarkdown, splitThinkingBlocks } from "./chatText";

describe("stripLeakedTokens", () => {
  it("passes plain paragraphs through unchanged", () => {
    const s = "One.\n\nTwo.\n\nThree with a </div> in prose? No — only in fences.";
    expect(stripLeakedTokens(s)).toBe(s);
  });

  it("regression: closing HTML tags in code do not delete paragraphs", () => {
    // The old "</"-triggered \n{2}...\n{2} branch deleted the second
    // paragraph entirely whenever any "</" appeared. Byte-for-byte pass.
    const s = [
      "Here is the component:",
      "",
      "```tsx",
      "export const A = () => <div></div>;",
      "```",
      "",
      "And this closing sentence must survive.",
    ].join("\n");
    expect(stripLeakedTokens(s)).toBe(s);
  });

  it("regression: fences stay balanced when the text contains </tag>", () => {
    const s = [
      "Intro paragraph.",
      "",
      "```html",
      "<ul><li>x</li></ul>",
      "```",
      "",
      "Trailing paragraph.",
    ].join("\n");
    const out = stripLeakedTokens(s);
    const fenceCount = (out.match(/^\s{0,3}```/gm) ?? []).length;
    // Every fence needs a partner or the rest of the message renders as
    // raw unstyled text outside the bubble.
    expect(fenceCount % 2).toBe(0);
    expect(out).toContain("Trailing paragraph.");
  });

  it("keeps a blockquoted multiline shell command in one balanced fence", () => {
    const s = [
      "> ```bash",
      "> set -o pipefail",
      "> docker run --rm --env-file /srv/config.env \\",
      ">   image:87fd42ea6 \\",
      ">   node /app/verify.js \\",
      ">   2>&1 | tee /srv/report.txt",
      "> ```",
      "> Evidence remains prose.",
    ].join("\n");
    expect(stripLeakedTokens(s)).toBe(s);
  });

  it("strips <thinking> blocks but keeps surrounding prose", () => {
    const s = "Before.<thinking>secret</thinking>After.";
    expect(stripLeakedTokens(s)).toBe("Before.After.");
  });

  it("strips a dangling <thinking> tail", () => {
    const s = "Visible.<thinking>half-eaten";
    expect(stripLeakedTokens(s)).toBe("Visible.");
  });

  it("strips <|channel|> protocol wrappers", () => {
    const s = "<|channel|>junk<|channel|>real text";
    expect(stripLeakedTokens(s)).toContain("real text");
  });
});

describe("splitThinkingBlocks", () => {
  it("preserves Markdown paragraph boundaries around thinking blocks", () => {
    const parts = splitThinkingBlocks("<thinking>x</thinking>One\n\nTwo");
    expect(parts.filter((p) => !p.thinking).map((p) => p.text).join(""))
      .toContain("One\n\nTwo");
    expect(parts.filter((p) => !p.thinking).map((p) => p.text).join(""))
      .not.toBe("OneTwo");
  });
});

describe("isBlankMarkdown", () => {
  it("treats hr-only text as blank", () => {
    expect(isBlankMarkdown("---\n***\n___")).toBe(true);
  });

  it("treats real content as not blank", () => {
    expect(isBlankMarkdown("---\nhello\n")).toBe(false);
  });
});