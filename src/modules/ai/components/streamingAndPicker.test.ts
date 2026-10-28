import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Source contracts for two UI regressions whose behavior needs a browser to
 * exercise end-to-end: per-part streaming completion and picker resizing.
 * These deliberately pin the small logic points, not component markup.
 */

describe("progressive assistant rendering", () => {
  const src = readFileSync(new URL("./AiChat.tsx", import.meta.url), "utf8");

  it("uses each text/reasoning part's own streaming state, not run-level streaming", () => {
    expect(src).toContain('(g.part as { state?: string }).state === "streaming"');
    expect(src).not.toContain("lastTextIdx");
    // The outer message/run streaming gate remains, but cannot mark a done
    // text part live merely because later tools are still executing.
    expect(src).toMatch(/streaming=\{[\s\S]*?partType\(g\.part\) === "text"/);
  });
});

describe("resizable model picker", () => {
  const src = readFileSync(new URL("./ModelPicker.tsx", import.meta.url), "utf8");
  const prefs = readFileSync(new URL("../../settings/store.ts", import.meta.url), "utf8");

  it("renders at the persisted width and persists on drag completion", () => {
    expect(src).toContain("style={{ width: pickerWidth }}");
    expect(src).toContain("setModelPickerWidth(width)");
    expect(src).toContain("onPointerUp={stopResize}");
    expect(src).toContain("setPointerCapture");
    expect(prefs).toContain("modelPickerWidth: 544");
  });

  it("hides descriptions only below the width threshold", () => {
    expect(src).toContain("pickerWidth >= MODEL_PICKER_DESCRIPTION_MIN");
    expect(src).toContain("{showDescription ? (");
  });

  it("shows thinking for custom endpoints and uses the compat-specific preference", () => {
    expect(src).toContain('model.id === "openai-compatible-custom"');
    expect(src).toContain('model.id === "lmstudio-local"');
    expect(src).toContain("setOpenaiCompatibleThinkingMode(next)");
  });
});
