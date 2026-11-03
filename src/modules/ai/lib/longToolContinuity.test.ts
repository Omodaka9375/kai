import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Long-tool continuity pins (2026-11-03 report: "when a command takes long
 * to execute the model's response is delayed after it and it seems to forget
 * what it was doing"). Two real mechanisms found by tracing the whole
 * post-tool path: the 30s default shell kill (partial output + a
 * re-spawn round-trip = delay) and the auto-verify effect firing during the
 * APPROVAL PAUSE (240s of tsc/cargo + an injected "[verify] Fix these
 * failures" redirect mid-task = the "forgot what it was doing" read).
 */

const bridge = readFileSync(
  new URL("../components/AgentRunBridge.tsx", import.meta.url),
  "utf8",
);
const shellTool = readFileSync(
  new URL("../tools/shell.ts", import.meta.url),
  "utf8",
);
const rustShell = readFileSync(
  new URL("../../../../src-tauri/src/modules/shell/mod.rs", import.meta.url),
  "utf8",
);

describe("auto-verify does not fire during the approval pause", () => {
  it("the verify effect skips while ANY approval card is pending", () => {
    // Every bash_run ends the request on the approval card, so the SDK
    // status settles to "ready" MID-RUN; without this gate the verify ran
    // during the pause and injected a redirect while the run was waiting
    // on the user's click. Raw count (not manual): auto-approvable cards
    // resolve a macrotask later and re-enter streaming.
    expect(bridge).toContain("if (approvalsPending > 0) return;");
    // And approvalsPending is in the effect's deps so the final
    // post-approval idle still fires the verify.
    expect(bridge).toMatch(
      /\}, \[runtime, status, sessionId, injectMessage, approvalsPending\]\);/,
    );
  });
});

describe("long commands are not killed mid-flight", () => {
  it("the Rust shell default timeout is 120s, not 30s", () => {
    expect(rustShell).toContain("const DEFAULT_TIMEOUT_SECS: u64 = 120;");
    expect(rustShell).not.toContain("const DEFAULT_TIMEOUT_SECS: u64 = 30;");
  });

  it("network/git commands get extended budgets in slowCommandTimeout", () => {
    expect(shellTool).toContain("(push|fetch|pull|clone)");
    expect(shellTool).toContain("(curl|wget)");
    expect(shellTool).toContain("pip");
  });
});