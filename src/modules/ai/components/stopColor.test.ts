import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * SOURCE PINS:
 *   - Ask mode shield icon = AMBER, Allow mode shield icon = EMERALD.
 *   - The Stop agent indicator in TodoStrip (and Workspaces card input) is a
 *     pulsing red square (size-2, rounded-[2px], bg-red-500), distinct from
 *     the permission toggle color.
 */
describe("permission color language and stop square (source pins)", () => {
  const toggle = readFileSync(
    new URL("./AutoApproveToggle.tsx", import.meta.url),
    "utf8",
  );
  // 2026-11-26: the stop square moved from TodoStrip into the MAIN AI input
  // bar (AiInputBar carries it left of the textarea when busy); TodoStrip
  // keeps only the todos list. Pin the bar + the Workspaces card.
  const bar = readFileSync(new URL("./AiInputBar.tsx", import.meta.url), "utf8");
  const strip = readFileSync(new URL("./TodoStrip.tsx", import.meta.url), "utf8");
  const grid = readFileSync(new URL("./ProjectChatGrid.tsx", import.meta.url), "utf8");

  it("Ask icon is amber, Allow icon stays emerald (compact Shield01Icon toggle)", () => {
    expect(toggle).toContain('off: "text-amber-600 dark:text-amber-400"');
    expect(toggle).toContain('all: "text-emerald-600 dark:text-emerald-400"');
    expect(toggle).toContain("icon={Shield01Icon}");
    // The old gray dot and text label are gone.
    expect(toggle).not.toContain("bg-muted-foreground/50");
  });

  it("the Stop control is a pulsing red square to the left of the mic in both input bars", () => {
    expect(bar).toContain("size-2 rounded-[2px] bg-red-500");
    expect(bar).toContain("animate-pulse");
    expect(grid).toContain("size-2 rounded-[2px] bg-red-500");
    // Position: in AiInputBar the stop button sits AFTER the textarea and
    // immediately BEFORE the mic button (right side, left of mic).
    const textareaIdx = bar.indexOf("<textarea");
    const stopIdx = bar.indexOf('title="Stop agent"');
    const micIdx = bar.indexOf("icon={Mic01Icon}");
    expect(textareaIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeGreaterThan(textareaIdx);
    expect(stopIdx).toBeLessThan(micIdx);
    // TodoStrip no longer paints a stop control (single control per window).
    expect(strip).not.toContain("StopSquare");
    // The busy-only strip is gone: TodoStrip renders ONLY with todos.
    expect(strip).toMatch(/if \(!sessionId \|\| todos\.length === 0\) return null;/);
  });
});
