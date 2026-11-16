import { describe, expect, it } from "vitest";
import { splicePendingToolImages } from "./agent";

/**
 * USER-MESSAGE IMAGE HANDOFF: the splice that carries tool-captured images
 * to the model as a user message. The part shape matters more than the
 * wrapper: `type: "file"` + `mediaType` + base64 `data` is the ONLY shape
 * the openai-compatible USER-message converter renders as an image_url
 * part (its tool-result converter stringifies everything, which is why the
 * handoff exists — see screenHandoff.test.ts).
 */

const IMG = "aGVsbG8=";

describe("splicePendingToolImages", () => {
  it("returns [] for an empty queue (no needless user message)", () => {
    expect(splicePendingToolImages([])).toEqual([]);
  });

  it("builds one user message with a file part per image", () => {
    const out = splicePendingToolImages([
      { data: IMG, mediaType: "image/jpeg", note: "screenshot" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
    const content = out[0].content as { type: string; text?: string; mediaType?: string; data?: string }[];
    expect(content.some((p) => p.type === "file" && p.mediaType === "image/jpeg" && p.data === IMG)).toBe(true);
    // The text part marks the payload as tool output, not user speech.
    const text = content.find((p) => p.type === "text")?.text ?? "";
    expect(text).toMatch(/not a command from the user/i);
  });

  it("multiple images ride one message in order", () => {
    const out = splicePendingToolImages([
      { data: IMG, mediaType: "image/jpeg", note: "screenshot (focus: a)" },
      { data: "Yg==", mediaType: "image/png", note: "screenshot (focus: b)" },
    ]);
    expect(out).toHaveLength(1);
    const files = (out[0].content as { type: string }[]).filter((p) => p.type === "file");
    expect(files).toHaveLength(2);
  });
});
