import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * "The agent just stops after a tool call" — regression contract.
 *
 * Diagnosis (2026-10-21): loop detection fired (false positives — see
 * streamGuard.test.ts for the output-aware fingerprint fix), the stop path
 * patched agentMeta.status:"error" + message, but chat.stop() settles the
 * SDK chat to idle and AgentRunBridge's idle branch patches `error: null` —
 * erasing the reason. The user saw a run die instantly after a tool call
 * with NO explanation.
 *
 * These pins keep the two halves of the fix in place:
 *  - the stop path also routes the reason through `summaryNotice` (survives
 *    the idle wipe, renders as a dismissable banner with a Continue affordance);
 *  - agent.ts gates text-loop checks by length and uses the output-aware
 *    tool fingerprint (healthy polling runs never reach the detector).
 */
describe("loop-stop visibility contract (chatRuntime.ts)", () => {
  const src = readFileSync(new URL("./chatRuntime.ts", import.meta.url), "utf8");

  it("onLoopDetected routes the reason through summaryNotice, not just error", () => {
    const idx = src.indexOf("onLoopDetected:");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, src.indexOf("onFinishMeta:", idx));
    expect(block).toContain("summaryNotice");
    expect(block).toContain("Loop detected");
    // The transient error patch is still there (live card while stopping)…
    expect(block).toContain('status: "error"');
  });
});

describe("loop-detector false-positive gates (agent.ts)", () => {
  const src = readFileSync(new URL("./agent.ts", import.meta.url), "utf8");

  it("text-loop checks are gated by a minimum length", () => {
    expect(src).toContain("GUARD_MIN_STEP_TEXT");
    expect(src).toMatch(/loopCandidate\.length >= GUARD_MIN_STEP_TEXT/);
  });

  it("tool-loop detection uses the OUTPUT-AWARE fingerprint helper", () => {
    expect(src).toContain("toolLoopFingerprint(step)");
    // The old inline input-only fingerprint must not come back — it killed
    // legitimate bash_logs/CI-polling runs (identical args, new output).
    expect(src).not.toMatch(
      /step\.toolCalls[\s\S]{0,160}JSON\.stringify\(tc\.input[^\n]*\n[\s\S]{0,80}\.sort\(\)/,
    );
  });
});
