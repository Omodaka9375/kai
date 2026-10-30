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

  it("an identical repeat earns a nudge BEFORE the hard stop", () => {
    // dsh's repeat-tool-reminder: nudge at TOOL_LOOP_NUDGE, kill only at
    // TOOL_LOOP_THRESHOLD. Both constants must exist and the nudge must
    // fire strictly below the threshold.
    expect(src).toMatch(/const TOOL_LOOP_THRESHOLD = (\d+);/);
    expect(src).toMatch(/const TOOL_LOOP_NUDGE = (\d+);/);
    const threshold = Number(src.match(/const TOOL_LOOP_THRESHOLD = (\d+);/)![1]);
    const nudge = Number(src.match(/const TOOL_LOOP_NUDGE = (\d+);/)![1]);
    expect(nudge).toBeLessThan(threshold);
    expect(src).toContain("toolRepeatCount === TOOL_LOOP_NUDGE");
    expect(src).toContain("loopNudgeMessage");
  });

  it("the nudge rides the NEXT request via prepareStep and is consumed once", () => {
    // Injected into the model call only (prepareStep messages override),
    // never persisted; cleared on read so it can't repeat every step.
    const prepIdx = src.indexOf("prepareStep:");
    expect(prepIdx).toBeGreaterThan(-1);
    const block = src.slice(prepIdx, prepIdx + 600);
    expect(block).toContain("loopNudgeMessage");
    expect(block).toMatch(/loopNudgeMessage = null;/);
    expect(block).toContain('role: "user"');
    // onStepFinish sets it; prepareStep must be the only consumer.
    // (\s*= so a wrapped `loopNudgeMessage =\n  \`…\`` setter still matches.)
    expect((src.match(/loopNudgeMessage\s*=/g) ?? []).length).toBe(2);
  });

  it("the central guard wrapper is applied on BOTH the fenced and unfenced paths", () => {
    // Phase-A bug pin: the no-fenceState branch once fell back to
    // redactedTools, silently bypassing withCentralToolGuards.
    const ternary = src.slice(
      src.indexOf("const fencedTools = opts.fenceState"),
      src.indexOf("return streamText"),
    );
    expect(ternary).toMatch(/:\s*guardedTools;/);
    expect(ternary).not.toMatch(/:\s*redactedTools;/);
  });

  it("POLLING tools are exempt from the identical-repeat kill (the #1 false-alarm fix)", () => {
    // Identical args + identical output is the EXPECTED steady state for a
    // model tailing a dev server / waiting on CI: "nothing changed yet".
    // The hard stop fired on exactly those runs. The exemption set must
    // exist, cover the classic polling tools, and the arm must reset (not
    // advance) the counter for polling-only steps.
    expect(src).toContain("TOOL_LOOP_POLLING_EXEMPT");
    for (const t of [
      "get_terminal_output",
      "bash_logs",
      "bash_list",
      "watch_list",
      "project_status",
    ]) {
      expect(src).toContain(`"${t}"`);
    }
    expect(src).toMatch(/allPolling[\s\S]{0,400}toolRepeatCount = 0;/);
    // A mutating tool must NOT be in the exemption set - the kill stays
    // armed for real runaway repeats.
    expect(src).not.toMatch(/TOOL_LOOP_POLLING_EXEMPT[\s\S]{0,600}"edit"/);
  });
});
