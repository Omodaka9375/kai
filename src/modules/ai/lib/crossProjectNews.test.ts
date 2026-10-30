/**
 * Source-pin tests for the cross-project "has news" surfacing
 * (project rail amber dot): the flag must be set ONLY for real
 * agent activity in a background project - never on mount,
 * recompute, or an aborted run. The first cut fired on every
 * effect re-run of every background bridge (mount, message
 * loads, approvalsPending changes) and flagged every background
 * project with a phantom "something new" dot while everything
 * sat idle - the exact false positive this test pins out.
 *
 * Source-pin style (same contract as loopStop.test.ts): the
 * gating logic lives inside the Bridge component and needs the
 * full Tauri/React context, so the SHAPE is the contract.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const bridge = readFileSync(
  new URL("../components/AgentRunBridge.tsx", import.meta.url),
  "utf8",
);

describe("cross-project news flag gating (AgentRunBridge)", () => {
  it("fires ONLY on a busy -> idle transition, never on mount or recomputes", () => {
    // The transition gate: prev status must have been thinking/streaming.
    expect(bridge).toContain("prevRunStatusRef");
    expect(bridge).toMatch(
      /prevRunStatus === "thinking" \|\| prevRunStatus === "streaming"/,
    );
    // A bare `if (runStatus === "idle" && !isActive)` with no transition
    // check is the phantom-dot bug - it must not come back.
    expect(bridge).not.toMatch(
      /if \(\s*runStatus === "idle" && !isActive[,)]\s*\{/,
    );
  });

  it("requires a NEW assistant message after the run's busy-arm boundary", () => {
    // Causality: an aborted/empty run (no new assistant message) must not
    // flag the project - only a run that actually produced a reply.
    expect(bridge).toContain("newsBoundaryIdRef");
    expect(bridge).toMatch(
      /lastAssistant && lastAssistant\.id !== newsBoundary/,
    );
  });

  it("flags only when the owning project differs from the ACTIVE project", () => {
    const m = bridge.match(
      /owner && owner !== activeProjectId\(\)[\s\S]{0,120}setProjectHasNews\(owner, true\)/,
    );
    expect(m).toBeTruthy();
  });

  it("never flags the project the user is currently looking at (rail renders it)", () => {
    const rail = readFileSync(
      new URL("../../workspace/ProjectRail.tsx", import.meta.url),
      "utf8",
    );
    // Rail dot: amber ONLY when hasNews, and AppShell computes hasNews as
    // `project.id !== activeId && getProjectHasNews(project.id)` so the
    // active project can never show a phantom amber pulse.
    expect(rail).toMatch(/animate-pulse bg-amber-500/);
    const shell = readFileSync(new URL("../../../app/AppShell.tsx", import.meta.url), "utf8");
    expect(shell).toContain(
      "hasNews: project.id !== activeId && getProjectHasNews(project.id)",
    );
    // Entering the project consumes the flag.
    expect(shell).toMatch(/useEffect\(\(\) => \{\s*\n\s*if \(activeId\) setProjectHasNews\(activeId, false\)/);
  });
});