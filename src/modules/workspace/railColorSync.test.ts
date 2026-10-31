import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Rail color-sync contract (2026-10-31).
 *
 * "Can we sync colors between a command running in a project and the
 * project indicator on the folder icon?"
 *
 * The app's work-in-progress color is ONE family: emerald (rail agent dot,
 * group-chat streaming dots, approval-approved dot, the running-tool
 * spinner). The rail's "terminal command running" dot was the only
 * outlier — a sky pulse for the same semantic ("something is happening in
 * this project"). Now both rail dots are emerald:
 *
 *   steady emerald   = agent run in progress
 *   pulsing emerald  = terminal command producing output
 *   pulsing violet   = needs your input (attention — unchanged)
 *   pulsing amber    = unseen background news (unchanged)
 *   destructive      = agent error (unchanged)
 *   muted hollow     = idle (unchanged)
 *
 * The pulse-vs-steady distinction keeps agent work and terminal output
 * tellable apart at a glance while reading as one "active" family.
 */

const rail = readFileSync(
  new URL("./ProjectRail.tsx", import.meta.url),
  "utf8",
) as string;

describe("project rail: one work-in-progress color family", () => {
  it("terminal-command dot pulses EMERALD, same family as the agent dot", () => {
    expect(rail).toMatch(
      /status === "idle" &&\s*\n\s*runningTerminals > 0 &&\s*\n\s*"animate-pulse bg-emerald-500"/,
    );
    // The agent dot stays steady emerald.
    expect(rail).toMatch(/!hasNews && status === "running" && "bg-emerald-500"/);
  });

  it("the terminal dot must NOT return to the sky outlier", () => {
    expect(rail).not.toContain("bg-sky-500");
  });

  it("tooltip running-count text matches the dot (emerald)", () => {
    expect(rail).toContain("text-emerald-400");
    expect(rail).not.toContain("text-sky-400");
  });

  it("attention states keep their distinct colors (violet input, amber news)", () => {
    expect(rail).toContain('status === "awaiting" && "animate-pulse bg-violet-500"');
    expect(rail).toMatch(/animate-pulse bg-amber-500/);
    expect(rail).toContain('status === "error" && "bg-destructive"');
  });
});
