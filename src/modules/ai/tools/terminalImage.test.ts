import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildOsc1337, parseOsc1337 } from "./terminalImage";

/**
 * OSC 1337 round-trip + the 2026-11-06 chat-card source pins: display_image
 * had the same terminal-only flaw as display_video ("no active terminal tab
 * to display into") — with no terminal open the tool failed even though the
 * base64 was already in hand and the chat can render an image card from it.
 */
describe("OSC 1337 build/parse", () => {
  it("round-trips name and data", () => {
    const seq = buildOsc1337("QUJD", "pic.png", 3);
    // parseOsc1337 takes the FULL OSC params (starting at "File=").
    const m = seq.match(/^\x1b\]1337;(.+)\x07$/);
    expect(m).not.toBeNull();
    const parsed = parseOsc1337(m![1]!);
    expect(parsed?.name).toBe("pic.png");
    expect(parsed?.base64Data).toBe("QUJD");
  });
});

describe("display_image chat-card wiring (source pins)", () => {
  const src = readFileSync(new URL("./terminalImage.ts", import.meta.url), "utf8");
  const chat = readFileSync(
    new URL("../components/AiChat.tsx", import.meta.url),
    "utf8",
  );
  const media = readFileSync(
    new URL("../components/MediaMessage.tsx", import.meta.url),
    "utf8",
  );

  it("success output carries the MediaMessage image shape", () => {
    expect(src).toContain('type: "image" as const');
    expect(src).toContain("sniffImageMime(base64_data)");
  });

  it("no active terminal no longer errors — the chat card is unconditional", () => {
    // The old hard error is gone from the return path.
    expect(src).not.toContain('return { error: "no active terminal tab to display into" };');
    // The terminal write is best-effort: ok or not, the card still returns.
    expect(src).toContain("best-effort second surface");
  });

  it("AiChat routes display_image through MediaMessage", () => {
    expect(chat).toContain('toolName === "display_image"');
  });

  it("the card hides unknown (0x0) dimensions instead of printing them", () => {
    expect(media).toContain("output.width > 0 && output.height > 0");
  });
});
