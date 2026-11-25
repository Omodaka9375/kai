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
  const strip = readFileSync(new URL("./TodoStrip.tsx", import.meta.url), "utf8");
  const grid = readFileSync(new URL("./ProjectChatGrid.tsx", import.meta.url), "utf8");

  it("Ask icon is amber, Allow icon stays emerald (compact Shield01Icon toggle)", () => {
    expect(toggle).toContain('off: "text-amber-600 dark:text-amber-400"');
    expect(toggle).toContain('all: "text-emerald-600 dark:text-emerald-400"');
    expect(toggle).toContain("icon={Shield01Icon}");
    // The old gray dot and text label are gone.
    expect(toggle).not.toContain("bg-muted-foreground/50");
  });

  it("the Stop control is a pulsing red square in both AI window and Workspaces cards", () => {
    expect(strip).toContain("size-2 shrink-0 cursor-pointer rounded-[2px] bg-red-500");
    expect(strip).toContain("animate-pulse");
    expect(grid).toContain("size-2 rounded-[2px] bg-red-500");
  });
});
