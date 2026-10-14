import { describe, expect, it, vi } from "vitest";
import { toSpeechText } from "./voiceTts";

// native + preferences are not touched by toSpeechText (pure), but the
// module imports them at top level — mock before import.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./native", () => ({
  native: {
    voiceTranscribe: vi.fn(),
    voiceTts: vi.fn(),
  },
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: { getState: () => ({ voiceTtsMode: "off" }) },
}));
vi.mock("@/modules/settings/store", () => ({}));

const BQ = "`";

describe("toSpeechText", () => {
  it("strips fenced code blocks, keeps surrounding prose", () => {
    const out = toSpeechText(
      `Here is the fix:\n${BQ}${BQ}${BQ}ts\nconst a = 1; // done\n${BQ}${BQ}${BQ}\nAll set.`,
    );
    expect(out).toBe("Here is the fix: All set.");
  });

  it("strips an unterminated code fence (tail of a part)", () => {
    expect(toSpeechText(`Intro\n${BQ}${BQ}${BQ}js\nnever closed`)).toBe("Intro");
  });

  it("strips paired thinking tags", () => {
    expect(toSpeechText("<thinking>internal notes</thinking>The answer is 42.")).toBe(
      "The answer is 42.",
    );
  });

  it("strips an unterminated thinking tail (everything after is thought)", () => {
    expect(toSpeechText("<thinking>secret\nmore secret\nThe answer is 42.")).toBe("");
  });

  it("strips trust-boundary fence blocks (tool output echo)", () => {
    expect(toSpeechText("[start tool_abc]junk output[end tool_abc] visible text")).toBe(
      "visible text",
    );
  });

  it("keeps inline code content but drops backticks, links keep label", () => {
    const out = toSpeechText(`Run ${BQ}pnpm test${BQ} and see [docs](https://x.com).`);
    expect(out).toBe("Run pnpm test and see docs.");
  });

  it("strips headings, bullets, checkboxes, quotes, and tables", () => {
    const out = toSpeechText(
      "## Result\n| a | b |\n|---|---|\n| 1 | 2 |\n- item one\n- [x] shipped\n> quoted",
    );
    expect(out).toBe("Result item one done shipped quoted");
  });

  it("drops emphasis markers", () => {
    expect(toSpeechText("**bold** and *it* and _u_ and ~~s~~ done.")).toBe(
      "bold and it and u and s done.",
    );
  });

  it("leaves ordinary prose untouched", () => {
    const s = "Simple sentence. Another one, with 3.5 and C:/Users/x paths.";
    expect(toSpeechText(s)).toBe(s);
  });

  it("collapses newlines into sentence breaks", () => {
    expect(toSpeechText("Line one.\nLine two.")).toBe("Line one. Line two.");
  });
});
