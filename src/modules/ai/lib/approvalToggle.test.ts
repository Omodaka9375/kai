import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * SOURCE PINS (2026-11-06 report): "if I toggle from Allow to Ask in the
 * middle of some command it doesn't work anymore - no matter if I later
 * change to allow/ask it just auto allows all. Toggle loses all power."
 *
 * Two defects, both traced from source:
 *
 * 1. DEFERRED-AUTO-APPROVE FIRE-TIME GAP: under Allow, each pending card is
 *    approved via setTimeout(0). A multi-tool step (batch_edit's many
 *    calls, chained commands) schedules SEVERAL; switching to Ask mid-step
 *    cancelled none of them - the timers only latched DENIALS at fire time,
 *    never re-read the mode, so everything still auto-approved and the
 *    toggle read as broken.
 * 2. FROZEN APPROVAL CARD: AiToolApproval's memo comparator ignored the
 *    auto-approve mode, so a card that rendered as the flat
 *    "auto-approved" row under Allow stayed memo-frozen after switching to
 *    Ask - no buttons ever appeared, and the pending call could not be
 *    answered manually either. The toggle looked dead even for FUTURE
 *    calls because the first frozen card pins the whole sequential
 *    approval queue (every later card renders as a "queued" chip behind
 *    it).
 */
describe("allow/ask mid-run toggle (source pins)", () => {
  const bridge = readFileSync(
    new URL("../components/AgentRunBridge.tsx", import.meta.url),
    "utf8",
  );
  const card = readFileSync(
    new URL("../components/AiToolApproval.tsx", import.meta.url),
    "utf8",
  );

  it("the deferred auto-approve re-checks the CURRENT mode at fire time", () => {
    // The fire-time gate: a timer scheduled under Allow dies if the user
    // has since switched the session to Ask. Must read the session-scoped
    // map (getSessionAutoApprove), not the presentation-only store field.
    expect(bridge).toContain(
      'if (getSessionAutoApprove(sessionId) !== "all") return;',
    );
    // And the gate sits INSIDE the setTimeout callback (fire time), not
    // before it (schedule time).
    const timerIdx = bridge.indexOf("setTimeout(() => {");
    const gateIdx = bridge.indexOf(
      'if (getSessionAutoApprove(sessionId) !== "all") return;',
    );
    expect(timerIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(timerIdx);
  });

  it("the approval card's memo comparator treats the mode as an input", () => {
    // The card must re-render when the auto-approve version bumps, or a
    // flat auto-approved row stays frozen after Allow -> Ask.
    expect(card).toContain("modeVersionA === modeVersionB");
    expect(card).toContain("getSessionAutoApproveVersion()");
  });
});
