import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildTerminalImageTools } from "./terminalImage";
import type { ToolContext } from "./context";

/**
 * OSC 1337 round-trip + the 2026-11-06 chat-card source pins: display_image
 * had the same terminal-only flaw as display_video ("no active terminal tab
 * to display into") — with no terminal open the tool failed even though the
 * base64 was already in hand and the chat can render an image card from it.
 */
describe("display_image loads local files without base64 in model context", () => {
  it("reads a Browserr screenshot and projects only a short text result", async () => {
    const { vi } = await import("vitest");
    const realPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const readFileBytes = vi.fn(async () => realPng);
    const ctx = {
      getCwd: () => null,
      native: {
        readFileBytes,
        canonicalize: async (path: string) => path,
      },
      writeToActiveTerminalDisplay: () => false,
    } as unknown as ToolContext;
    const display = buildTerminalImageTools(ctx).display_image;
    if (typeof display.execute !== "function") throw new Error("display_image.execute missing");
    const output = await display.execute(
      { path: "C:/Users/Valsinarb/AppData/Local/browserr/mcp-shots/shot-1794497024.png" },
      { toolCallId: "local-shot", messages: [], abortSignal: new AbortController().signal },
    );
    if (Symbol.asyncIterator in output) throw new Error("expected one shot, not a stream");
    if ("error" in output) throw new Error(output.error);
    expect(output.type).toBe("image");
    expect(String(output.base64).startsWith("iVBORw0KGgo")).toBe(true);
    expect(output.sourcePath).toContain("shot-1794497024.png");
    if (!display.toModelOutput) throw new Error("missing display_image model serializer");
    const projected = await display.toModelOutput({
      toolCallId: "local-shot", input: { path: "shot.png" }, output,
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(output.base64);
    expect(serialized).toContain("shot-1794497024.png");
    expect(serialized.length).toBeLessThan(512);
  });
});

describe("display_image is chat-only (2026-11-19 design)", () => {
  const src = readFileSync(new URL("./terminalImage.ts", import.meta.url), "utf8");

  it("has no terminal-decoration write path at all", () => {
    expect(src).not.toContain("writeToActiveTerminalDisplay");
    expect(src).not.toContain("injectIntoActivePty");
    expect(src).not.toContain("buildOsc1337");
    expect(src).not.toContain("displayed_in: terminalDisplayed");
  });

  it("still emits the chat image card unconditionally", () => {
    expect(src).toContain('type: "image" as const');
    expect(src).toContain('displayed_in: "chat image card"');
  });

  it("tool description tells the model the image never goes to the terminal", () => {
    expect(src).toContain("never written into the user's terminal");
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
    // The card is the ONLY surface now (2026-11-19) — the best-effort
    // terminal write is gone entirely.
    expect(src).not.toContain("best-effort second surface");
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

describe("display_image never writes base64 into shell stdin (2026-11-19 report)", () => {
  const src = readFileSync(new URL("./terminalImage.ts", import.meta.url), "utf8");

  // The report: with a terminal open, display_image pasted a huge base64
  // blob into the terminal. Root cause: writeToActiveTerminalDisplay
  // actually went to the PTY (shell stdin) — the shell echoed the OSC 1337
  // sequence as plain text. Resolution went further than routing the
  // sequence to the xterm parser: the terminal surface was REMOVED
  // entirely (agent output belongs in the chat), so the whole write path
  // is gone from the tool.
  it("terminalImage has no terminal write path of any kind", () => {
    expect(src).not.toContain("writeToActiveTerminalDisplay");
    expect(src).not.toContain("injectIntoActivePty");
    expect(src).not.toContain("buildOsc1337");
  });
});
