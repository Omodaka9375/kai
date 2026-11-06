import { describe, expect, it } from "vitest";
import { UI_THEMES, UI_THEME_MAP } from "./palettes";

/** Theme-palette registry pins. 2026-11-06: +4 genuine themes
 *  (Kanagawa, Gruvbox, Solarized, One Dark) — 12 total, a clean 3x4
 *  settings grid, each with BOTH light and dark variable sets (the
 *  applyUiTheme contract: a palette with only one mode silently no-ops
 *  when the OS is in the other mode). */
describe("UI theme palettes", () => {
  it("registers 12 themes", () => {
    expect(UI_THEMES).toHaveLength(12);
  });

  it.each([
    "kanagawa",
    "gruvbox",
    "solarized",
    "one-dark",
  ])("%s is registered with both light and dark sets", (id) => {
    const t = UI_THEME_MAP.get(id);
    expect(t, `theme ${id} missing from registry`).toBeDefined();
    expect(t!.dark, `${id}.dark`).toBeDefined();
    expect(t!.light, `${id}.light`).toBeDefined();
    expect(Object.keys(t!.dark!).length).toBeGreaterThanOrEqual(18);
    expect(Object.keys(t!.light!).length).toBeGreaterThanOrEqual(18);
  });

  it("every theme id is unique and every palette defines the core vars", () => {
    const ids = new Set<string>();
    for (const t of UI_THEMES) {
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      for (const mode of ["dark", "light"] as const) {
        const vars = t[mode];
        if (!vars) continue; // "default" is a no-op palette by design
        for (const key of [
          "--background",
          "--foreground",
          "--primary",
          "--ring",
          "--destructive",
        ]) {
          expect(vars[key], `${t.id}.${mode} missing ${key}`).toBeDefined();
        }
      }
    }
  });

});
