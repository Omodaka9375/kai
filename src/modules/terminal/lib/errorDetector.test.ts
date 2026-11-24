import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { feedText, resetDetector } from "./errorDetector";

describe("errorDetector per-leaf isolation and visibility gating", () => {
  const dispatched: Array<{ detail: { context: string; pattern: string; leafId: number } }> = [];
  const origWindow = globalThis.window;

  beforeEach(() => {
    vi.useFakeTimers();
    dispatched.length = 0;
    resetDetector();
    (globalThis as unknown as { window: { dispatchEvent: (e: Event) => boolean } }).window = {
      dispatchEvent: (e: Event) => {
        dispatched.push(e as unknown as { detail: { context: string; pattern: string; leafId: number } });
        return true;
      },
    };
  });

  afterEach(() => {
    resetDetector();
    vi.useRealTimers();
    (globalThis as unknown as { window: typeof origWindow }).window = origWindow;
  });

  it("isolates error buffers per leafId so one terminal's ignore line cannot silence another", () => {
    // Leaf 1 outputs an ignored info line; leaf 2 outputs a real error.
    // With the old single shared buffer, leaf 1's "0 errors" string suppressed
    // leaf 2's real failure.
    feedText("passed with 0 errors\n", 1);
    feedText("TypeError: cannot read property 'foo' of undefined\n", 2);
    vi.advanceTimersByTime(350);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.detail.leafId).toBe(2);
    expect(dispatched[0]!.detail.pattern).toContain("TypeError");
  });

  it("resetDetector(leafId) clears only that leaf's pending buffer", () => {
    feedText("Error: leaf one failure\n", 1);
    feedText("Error: leaf two failure\n", 2);
    resetDetector(1);
    vi.advanceTimersByTime(350);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.detail.leafId).toBe(2);
  });

  it("useTerminalSession only decodes and feeds errorDetector for visible terminals", () => {
    const src = readFileSync(new URL("./useTerminalSession.ts", import.meta.url), "utf8");
    expect(src).toContain("if (!s.disposed && s.visibleNow)");
    expect(src).toContain("feedErrorDetector(s.textDecoder.decode(bytes, { stream: true }), leafId)");
    expect(src).toContain("resetDetector(leafId)");
  });
});
