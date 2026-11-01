import { describe, expect, it, vi } from "vitest";
import { pickSpeakSegments, splitForSpeech, toSpeechText } from "./voiceTts";

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

describe("splitForSpeech", () => {
  it("returns a single chunk for short text", () => {
    expect(splitForSpeech("One sentence only.")).toEqual(["One sentence only."]);
  });

  it("returns no chunks for empty or whitespace-only text", () => {
    expect(splitForSpeech("")).toEqual([]);
    expect(splitForSpeech("   \n  ")).toEqual([]);
  });

  it("packs multiple sentences under the chunk cap", () => {
    const sentence = "This is a moderately long sentence about build tooling. ";
    const text = sentence.repeat(80); // ~4560 chars → 2 chunks
    const chunks = splitForSpeech(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(3800);
    }
    // No text lost: reassembly (ignoring boundary whitespace) covers input.
    expect(chunks.join(" ").split(/\s+/).length).toBe(
      text.trim().split(/\s+/).length,
    );
  });

  it("hard-splits a single sentence longer than the cap", () => {
    const long = "word ".repeat(1200); // 6000 chars, no sentence marks
    const chunks = splitForSpeech(long.trim());
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(3800);
    }
  });

  it("breaks at sentence boundaries, not mid-sentence", () => {
    const a = "First sentence ends here. ".repeat(100);
    const b = "Second distinct paragraph sentence. ".repeat(100);
    const chunks = splitForSpeech((a + b).trim());
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk except possibly the last ends with sentence punctuation.
    for (const c of chunks.slice(0, -1)) {
      expect(/[.!?]$/.test(c)).toBe(true);
    }
  });
});

// Minimal message shape pickSpeakSegments consumes (structural, like the
// real UIMessage parts it reads).
function msg(id: string, role: "assistant" | "user", ...texts: string[]) {
  return {
    id,
    role,
    parts: texts.map((t) => ({ type: "text", text: t })),
  };
}

describe("pickSpeakSegments — first + last, middle skipped (2026-11-01)", () => {
  // "Voice TTS is only saying one random sentence after my reply; if the
  //  agent is going fast it never says anything after that. Say the first
  //  part and the last part — skip the middle, but need the final."
  it("speaks the FIRST part joined with the LAST; the middle is skipped", () => {
    const msgs = [
      msg("u1", "user", "fix it"),
      msg(
        "a1",
        "assistant",
        "Let me check the tests first.",
        "Running the suite now…",
        "All tests pass — the fix is verified.",
      ),
    ];
    const seg = pickSpeakSegments(msgs, 1, null);
    expect(seg).not.toBeNull();
    expect(seg!.text).toBe(
      "Let me check the tests first.\n\nAll tests pass — the fix is verified.",
    );
    expect(seg!.lastMessageId).toBe("a1");
  });

  it("a lone text part speaks once (first === last, no duplication)", () => {
    const msgs = [msg("u1", "user", "hi"), msg("a1", "assistant", "Done.")];
    const seg = pickSpeakSegments(msgs, 1, null);
    expect(seg!.text).toBe("Done.");
    expect(seg!.lastMessageId).toBe("a1");
  });

  it("never reaches back past the pre-run boundary", () => {
    const msgs = [
      msg("a0", "assistant", "previous turn reply"),
      msg("u1", "user", "again"),
    ];
    expect(pickSpeakSegments(msgs, 2, msgs[0]!)).toBeNull();
  });

  it("an in-place tail replacement (new object in the boundary slot) is this run's reply", () => {
    const old = msg("a0", "assistant", "stalled partial");
    const regenerated = msg("a0", "assistant", "the recovered final answer");
    const msgs = [msg("u1", "user", "continue"), regenerated];
    const seg = pickSpeakSegments(msgs, 2, old);
    expect(seg!.text).toBe("the recovered final answer");
    expect(seg!.lastMessageId).toBe("a0");
  });

  it("a tool-only run says nothing (null, no walk-back)", () => {
    const msgs = [
      msg("u1", "user", "run it"),
      { id: "a1", role: "assistant", parts: [{ type: "tool-call" }] },
    ];
    expect(pickSpeakSegments(msgs, 1, null)).toBeNull();
  });
});
