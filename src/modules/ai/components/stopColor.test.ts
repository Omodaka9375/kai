import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * SOURCE PINS (2026-11-06 ask): "Make Ask mode indicator dot be yellow and
 * keep Allow green. Then match Stop agent button to be the current color of
 * permission indicator."
 *
 * One color language for the agent-control cluster:
 *   - Ask mode dot = AMBER (attention: the agent will stop and ask)
 *   - Allow mode dot = EMERALD (free to run) - unchanged
 *   - The Stop square follows the CURRENT mode color: emerald while the
 *     agent runs under auto-allow, amber while it runs in Ask mode.
 */
describe("permission color language (source pins)", () => {
  const toggle = readFileSync(
    new URL("./AutoApproveToggle.tsx", import.meta.url),
    "utf8",
  );
  const strip = readFileSync(new URL("./TodoStrip.tsx", import.meta.url), "utf8");

  it("Ask dot is amber, Allow dot stays emerald", () => {
    expect(toggle).toContain('off: "bg-amber-500"');
    expect(toggle).toContain('all: "bg-emerald-500"');
    // The old gray dot is gone.
    expect(toggle).not.toContain("bg-muted-foreground/50");
  });

  it("the Stop square matches the current permission color (emerald=Allow, amber=Ask)", () => {
    // Both colors present, driven by the mode branch.
    expect(strip).toContain("bg-emerald-500 shadow-[0_0_0_2px] shadow-emerald-500/20");
    expect(strip).toContain("bg-amber-500 shadow-[0_0_0_2px] shadow-amber-500/20");
    // The color is reactive to the session's mode: the strip subscribes
    // to the auto-approve version counter (same source the bridge and the
    // approval card use), so a mid-run toggle recolors the square.
    expect(strip).toContain("subscribeSessionAutoApprove");
    expect(strip).toContain("getSessionAutoApproveVersion");
    // And the mode is read session-scoped, not the presentation field.
    expect(strip).toContain("getSessionAutoApprove(sessionId ?? \"\")");
  });
});
