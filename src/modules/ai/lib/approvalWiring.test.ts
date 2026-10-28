import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Source-contract tests for the approval pipeline (same style as
 * fenceCoverage.test.ts): the denial latch only protects the agent if EVERY
 * path that resolves an approval routes through it. A refactor that calls
 * addToolApprovalResponse directly re-opens the race this guards against —
 * so pin the wiring.
 */

const src = (rel: string): string =>
  readFileSync(resolve(__dirname, rel), "utf8");

describe("approval responses flow through the denial latch", () => {
  const bridge = src("../components/AgentRunBridge.tsx");

  it("AgentRunBridge imports the latch", () => {
    expect(bridge).toMatch(/from "\.\.\/lib\/approvalLatch"/);
  });

  it("every addToolApprovalResponse call lives inside the latch-guarded respond()", () => {
    // There must be exactly ONE addToolApprovalResponse call site (inside
    // `respond`); the deferred auto-approve and allowlist paths call
    // respond(id, true) instead of the SDK API directly.
    const sdkCalls = bridge.match(/addToolApprovalResponse\(/g) ?? [];
    expect(sdkCalls.length).toBe(1);
    expect(bridge).toMatch(/respond\(id, true\);/);
  });

  it("respond() checks the latch at CALL time (both directions)", () => {
    expect(bridge).toMatch(/if \(!approved\) noteApprovalDenied\(id\);/);
    expect(bridge).toMatch(/else if \(isApprovalDenied\(id\)\) return;/);
  });

  it("the stale-approval reaper latches reaped ids as denials", () => {
    const store = src("../store/chatStore.ts");
    const reaper = store.slice(
      store.indexOf("function releaseStaleApprovalsOnly"),
      store.indexOf("function stripIncompleteToolMessages"),
    );
    expect(reaper).toContain("noteApprovalDenied");
  });

  it("the store responders are latch-guarded too (diff-tab path)", () => {
    const store = src("../store/chatStore.ts");
    // Anchor on the implementation arrow (unique — the interface uses a
    // bare `=> void;` signature without the destructured body).
    const anchor = "respondToApproval: (approvalId, approved) => {";
    const start = store.indexOf(anchor);
    expect(start).toBeGreaterThan(-1);
    const respond = store.slice(start, start + 600);
    expect(respond).toContain("noteApprovalDenied");
    expect(respond).toContain("isApprovalDenied");
  });

  it("allowlist auto-approve keeps its inline deny-list re-check", () => {
    // Defense-in-depth: the latch does NOT replace the security floor for
    // pinned commands — both must be present.
    expect(bridge).toMatch(/checkShellCommand\(cmd\)\.ok/);
  });
});
