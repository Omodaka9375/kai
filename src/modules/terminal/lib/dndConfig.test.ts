import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Cross-platform config contract for HTML5 drag-and-drop in the webview.
 *
 * tauri's `dragDropEnabled: true` (the default) installs the OS-native
 * drag-drop handler, which SWALLOWS HTML5 drag events on WebView2 and
 * webkitgtk — the explorer→terminal drag would be dead on those
 * platforms. Windows shipped with it disabled; base + Linux configs must
 * do the same (macOS inherits the base config).
 */

const read = (p: string) =>
  readFileSync(new URL(p, import.meta.url), "utf8");

describe("dragDropEnabled is false on every platform config", () => {
  const configs = [
    ["../../../../src-tauri/tauri.conf.json"],
    ["../../../../src-tauri/tauri.linux.conf.json"],
    ["../../../../src-tauri/tauri.windows.conf.json"],
  ];

  for (const [rel] of configs) {
    it(`base/linux/windows config disables native drag-drop (${rel.split("/").pop()}), macOS inherits the base`, () => {
      const json = JSON.parse(read(rel));
      const windows = (json.app?.windows ?? []) as Array<
        Record<string, unknown>
      >;
      expect(windows.length).toBeGreaterThan(0);
      for (const w of windows) {
        expect(w.dragDropEnabled).toBe(false);
      }
    });
  }

  it("TreeRow uses quoteForShell, not space-only double quotes", () => {
    const src = read("../../explorer/TreeRow.tsx");
    expect(src).toContain("quoteForShell(relativePath(rootPath, p)");
    expect(src).not.toMatch(/[\s)]\s*\?\s*`\$\{r\}`/);
  });

  it("TerminalPane sanitizes dropped text before writing to the PTY", () => {
    const src = read("../../terminal/TerminalPane.tsx");
    expect(src).toContain("sanitizeDroppedText(");
    expect(src).toMatch(/e\.preventDefault\(\);\s*\n\s*if \(dragClear/);
  });
});
