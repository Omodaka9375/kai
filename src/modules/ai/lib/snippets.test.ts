import { describe, expect, it } from "vitest";
import {
  BUILTIN_SNIPPETS,
  expandSnippetTokens,
  isValidHandle,
  normalizeHandle,
  type Snippet,
} from "./snippets";

describe("normalizeHandle", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(normalizeHandle("My Handle")).toBe("my-handle");
  });

  it("strips invalid characters", () => {
    expect(normalizeHandle("hello@world!")).toBe("helloworld");
  });

  it("collapses multiple hyphens", () => {
    expect(normalizeHandle("a--b---c")).toBe("a-b-c");
  });

  it("trims leading/trailing hyphens", () => {
    expect(normalizeHandle("-test-")).toBe("test");
  });
});

describe("isValidHandle", () => {
  it("accepts lowercase alphanumeric with hyphens", () => {
    expect(isValidHandle("my-snippet")).toBe(true);
    expect(isValidHandle("test123")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidHandle("")).toBe(false);
  });

  it("rejects leading hyphen", () => {
    expect(isValidHandle("-test")).toBe(false);
  });

  it("rejects uppercase", () => {
    expect(isValidHandle("MySnippet")).toBe(false);
  });
});

describe("expandSnippetTokens", () => {
  const snippets: Snippet[] = [
    {
      id: "1",
      handle: "analyze",
      name: "Analyze",
      description: "test",
      content: "Do analysis.",
    },
    {
      id: "2",
      handle: "creative",
      name: "Creative",
      description: "test",
      content: "Be creative.",
      mcpServerIds: ["server-1"],
    },
  ];

  it("expands a single token", () => {
    const { body, blocks, mcpServerIds } = expandSnippetTokens(
      "Please #analyze this code",
      snippets,
    );
    expect(body).toBe("Please  this code");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("Do analysis.");
    expect(mcpServerIds).toEqual([]);
  });

  it("expands multiple tokens", () => {
    const { blocks } = expandSnippetTokens(
      "#analyze and #creative",
      snippets,
    );
    expect(blocks).toHaveLength(2);
  });

  it("collects MCP server IDs", () => {
    const { mcpServerIds } = expandSnippetTokens("#creative", snippets);
    expect(mcpServerIds).toEqual(["server-1"]);
  });

  it("leaves unknown tokens as-is", () => {
    const { body, blocks } = expandSnippetTokens(
      "#unknown token here",
      snippets,
    );
    expect(body).toBe("#unknown token here");
    expect(blocks).toHaveLength(0);
  });

  it("handles empty input", () => {
    const { body, blocks } = expandSnippetTokens("", snippets);
    expect(body).toBe("");
    expect(blocks).toHaveLength(0);
  });
});

describe("BUILTIN_SNIPPETS", () => {
  it("has built-in snippets", () => {
    expect(BUILTIN_SNIPPETS.length).toBeGreaterThanOrEqual(3);
  });

  it("all have builtin flag set", () => {
    for (const s of BUILTIN_SNIPPETS) {
      expect(s.builtin).toBe(true);
    }
  });

  it("all have valid handles", () => {
    for (const s of BUILTIN_SNIPPETS) {
      expect(isValidHandle(s.handle)).toBe(true);
    }
  });

  it("all have unique IDs", () => {
    const ids = BUILTIN_SNIPPETS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all have non-empty content", () => {
    for (const s of BUILTIN_SNIPPETS) {
      expect(s.content.length).toBeGreaterThan(10);
    }
  });
});
