import { describe, expect, it } from "vitest";
import {
  detectSnippetTrigger,
  detectFileTrigger,
} from "./inputTriggers";

/**
 * Picker-trigger detection, extracted from AiInputBar so `/` opens the
 * command picker exactly like `#` does — previously only `#` had
 * discovery, which is why slash commands "didn't seem to work".
 */

describe("detectSnippetTrigger (command/snippet picker)", () => {
  it("opens on # at start of input", () => {
    expect(detectSnippetTrigger("#go", 3)).toEqual({
      char: "#",
      start: 0,
      end: 3,
      query: "go",
    });
  });

  it("opens on / at start of input (the new path)", () => {
    expect(detectSnippetTrigger("/comp", 5)).toEqual({
      char: "/",
      start: 0,
      end: 5,
      query: "comp",
    });
  });

  it("opens after a leading space (mid-text)", () => {
    expect(detectSnippetTrigger("do this #plan", 13)?.query).toBe("plan");
    expect(detectSnippetTrigger("do this /goal", 13)?.query).toBe("goal");
  });

  it("does not open mid-word (e.g. inside a url or path)", () => {
    // https://… — the / is preceded by ':', not whitespace.
    expect(detectSnippetTrigger("https://example.com", 13)).toBeNull();
    // src/lib/foo.ts — / preceded by 'c'.
    expect(detectSnippetTrigger("src/lib/foo.ts", 4)).toBeNull();
  });

  it("bails at whitespace before finding a trigger", () => {
    expect(detectSnippetTrigger("no trigger here", 16)).toBeNull();
  });

  it("rejects queries with non-command characters", () => {
    expect(detectSnippetTrigger("#hello!", 7)).toBeNull();
  });
});

describe("detectFileTrigger (@ file picker)", () => {
  it("opens on @ at start", () => {
    expect(detectFileTrigger("@src", 4)?.query).toBe("src");
  });

  it("opens after whitespace", () => {
    expect(detectFileTrigger("read @pack", 10)?.query).toBe("pack");
  });

  it("does not open for email-like mid-word @", () => {
    expect(detectFileTrigger("a@b.com", 6)).toBeNull();
  });
});
