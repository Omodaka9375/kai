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

  it("expand toggle sits leftmost, minimize at the far right (2026-11-14 ask)", () => {
    expect(mini).toContain('aria-label="Minimize to pill"');
    // Order FLIPPED (2026-11-14): expand toggle now lives at the header's
    // LEFT edge (leading cluster), minimize stays in the trailing cluster
    // at the far right - same arrangement as the group panel's header.
    const expIdx = mini.indexOf('aria-label={expandLabel}');
    const agentIdx = mini.indexOf('<AgentSwitcher isMiniWindow />');
    const minIdx = mini.indexOf('aria-label="Minimize to pill"');
    expect(expIdx).toBeGreaterThan(-1);
    expect(agentIdx).toBeGreaterThan(-1);
    // Expand is before everything else in the leading cluster...
    expect(expIdx).toBeLessThan(agentIdx);
    // ...and minimize is the trailing cluster's LAST control.
    expect(minIdx).toBeGreaterThan(expIdx);
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

  it("the pill stays visible under an expanded group panel (no self-hide)", () => {
    // 2026-11-14: the old `if (groupPanelExpanded) return null` self-hide
    // made the collapsed AI chat UNREACHABLE while the group was full-view,
    // while the AI-expanded state kept the group pill visible. The expanded
    // geometry ends at the +42px strip, so the pill stacks INTO the strip
    // below the panel - hooks before render stay intact (no early return).
    expect(pill).not.toContain("if (groupPanelExpanded) return null;");
    // Minimized AI + live group: the AI pill lifts to +84 so the group pill
    // keeps +42 (the two used to paint the same rect, AI pill on top).
    expect(pill).toContain(
      'bottom-[calc(var(--kai-input-bar-h,0px)+84px)]',
    );
    expect(pill).toContain("subscribeSessionAgentMeta");
  });
});
