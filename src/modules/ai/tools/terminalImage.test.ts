import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildOsc1337, buildTerminalImageTools, parseOsc1337 } from "./terminalImage";
import type { ToolContext } from "./context";

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

describe("display_image rejects placeholder/garbage payloads (2026-11-10 broken-image report)", () => {
  const src = readFileSync(new URL("./terminalImage.ts", import.meta.url), "utf8");

  it("rejects placeholder literals (the exact 'PLACEHOLDER' failure)", () => {
    expect(src).toContain("/^(PLACEHOLDER|TODO|image|base64|data)$/i.test(base64_data.trim())");
  });

  it("rejects payloads too small to be a real image", () => {
    expect(src).toContain("base64_data.length < 64");
  });

  it("rejects payloads with no recognized image magic", () => {
    expect(src).toContain('base64_data.startsWith("iVBORw0KGgo")');
    expect(src).toContain('base64_data.startsWith("R0lGOD")');
    expect(src).toContain('base64_data.startsWith("UklGR")');
  });

  // Behavioral: drive the real tool with the exact failing payload and with
  // a valid one, so the guard is proven (not just text-present).
  const ctx = { writeToActiveTerminalDisplay: () => true } as unknown as ToolContext;
  const display = buildTerminalImageTools(ctx).display_image;
  if (!display.execute) throw new Error("display_image.execute missing");

  it("PLACEHOLDER returns a corrective error, not a broken image card", async () => {
    const out = (await display.execute(
      { base64_data: "PLACEHOLDER", name: "bar-crop2.png" },
      { toolCallId: "t1", messages: [] },
    )) as Record<string, unknown>;
    expect(String(out.error)).toMatch(/placeholder/i);
    expect(out.type).toBeUndefined();
  });

  it("a real PNG payload still renders (guard does not over-reject)", async () => {
    // Minimal valid PNG header + padding so the length gate passes.
    const realPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const out = (await display.execute(
      { base64_data: realPng, name: "dot.png" },
      { toolCallId: "t2", messages: [] },
    )) as Record<string, unknown>;
    expect(out.error).toBeUndefined();
    expect(out.type).toBe("image");
    expect(out.mimeType).toBe("image/png");
  });

  it("a truncated/garbage base64 blob is rejected with a magic-header error", async () => {
    const garbage = "QUJD".repeat(20); // valid base64 charset, not an image
    const out = (await display.execute(
      { base64_data: garbage, name: "x.png" },
      { toolCallId: "t3", messages: [] },
    )) as Record<string, unknown>;
    expect(String(out.error)).toMatch(/recognized image header/i);
  });
});
