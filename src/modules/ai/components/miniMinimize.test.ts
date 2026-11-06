import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * SOURCE PINS (2026-11-06 ask: "add minimize button next to expand in ai
 * mini window, and make it collapse like in group chat"): the mini window
 * gets the group panel's minimize ( _ ) pattern - the window hides, the
 * agent KEEPS RUNNING, and a pill in the bottom strip re-opens it.
 */
describe("AI mini window minimize-to-pill (source pins)", () => {
  const mini = readFileSync(
    new URL("./AiMiniWindow.tsx", import.meta.url),
    "utf8",
  );
  const app = readFileSync(
    new URL("../../../app/App.tsx", import.meta.url),
    "utf8",
  );
  const pill = readFileSync(new URL("./GroupPill.tsx", import.meta.url), "utf8");

  it("the header has a minimize button before the expand arrow", () => {
    expect(mini).toContain('aria-label="Minimize to pill"');
    // Order: minimize button rendered BEFORE the expand toggle in the
    // header's trailing cluster, matching the group panel's header.
    const minIdx = mini.indexOf('aria-label="Minimize to pill"');
    const expIdx = mini.indexOf('aria-label={expandLabel}');
    expect(minIdx).toBeGreaterThan(-1);
    expect(minIdx).toBeLessThan(expIdx);
  });

  it("minimize keeps the panel open - it hides the window, not the AI", () => {
    // onMinimize collapses the expanded state and flips mini.open, but
    // never touches panelOpen - closing the panel is the status bar's job.
    expect(mini).toContain("setMiniExpanded(false)");
    expect(mini).toContain("closeMini();");
    expect(mini).not.toContain("closePanel");
  });

  it("ActiveSurfaces renders the AI pill for a minimized window while the panel stays open", () => {
    // The new branch: panel open + window hidden + no group slot = pill.
    expect(app).toContain(
      'hasComposer && panelOpen && stackSurface !== "group"',
    );
  });

  it("the pill is glanceable while the agent runs (busy badge)", () => {
    expect(pill).toContain("AiPillStatusBadge");
    expect(pill).toContain("animate-pulse rounded-full bg-emerald-500");
  });
});
