import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Fence-coverage contract tests.
 *
 * The main agent's tool results are fenced by `withToolGuard` (see
 * fence.test.ts for the fence primitive itself). Two surfaces built their
 * toolsets DIRECTLY and historically skipped the guard — subagents and the
 * Telegram assistant — meaning injected file content reached those models
 * with NO trust boundary. These tests pin the wiring (source-contract style,
 * same approach as the assistant session tests) so a refactor can't silently
 * drop the guard again.
 */

const read = (p: string) =>
  readFileSync(new URL(p, import.meta.url), "utf8");

describe("subagent fence coverage", () => {
  const src = read("./../agents/runSubagent.ts");

  it("guards subagent tool results with withToolGuard", () => {
    expect(src).toContain("withToolGuard(redactedTools, fenceState, null)");
    // Redaction stays INNERMOST (before the guard).
    const redactIdx = src.indexOf("withToolRedaction(tools)");
    const guardIdx = src.indexOf("withToolGuard(redactedTools");
    expect(redactIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(redactIdx);
  });

  it("gives the sub-model the fence protocol in its system prompt", () => {
    expect(src).toContain("fenceSystemPrompt(fenceState)");
  });

  it("uses its OWN fence state (not shared with the parent session)", () => {
    // createFenceState() called inside runSubagent — a per-spawn nonce set,
    // so a subagent can't forge the parent's markers.
    expect(src).toContain("const fenceState = createFenceState();");
  });

  it("fences the summary returned to the PARENT agent", () => {
    // The subagent read untrusted files; its own output must not carry
    // injection into the parent's context as trusted text.
    expect(src).toMatch(
      /summary:\s*fence\(\s*"tool",\s*fenceState\.nonces\.tool,/,
    );
  });

  it("passes the guarded (not merely redacted) toolset to generateText", () => {
    expect(src).toContain(
      'tools: guardedTools as Parameters<typeof generateText>[0]["tools"],',
    );
  });
});

describe("assistant fence coverage", () => {
  const src = read("./../../../modules/assistant/index.ts");

  it("applies the central guard before fencing assistant tool results", () => {
    expect(src).toContain(
      "withToolGuard(centrallyGuardedTools, fenceState, null)",
    );
    const redactIdx = src.indexOf("withToolRedaction(tools)");
    const centralIdx = src.indexOf("withCentralToolGuards(");
    const fenceIdx = src.indexOf("withToolGuard(centrallyGuardedTools");
    expect(redactIdx).toBeGreaterThan(-1);
    expect(centralIdx).toBeGreaterThan(redactIdx);
    expect(fenceIdx).toBeGreaterThan(centralIdx);
  });

  it("includes the fence protocol in the system prompt", () => {
    expect(src).toContain("fenceSystemPrompt(fenceState),");
  });

  it("passes the guarded toolset to generateText", () => {
    expect(src).toContain(
      'tools: guardedTools as Parameters<typeof generateText>[0]["tools"],',
    );
  });

  it("audits every Telegram turn before the model runs", () => {
    expect(src).toContain("AUDIT_KINDS.assistantExec");
  });
});

describe("approval audit hook", () => {
  const src = read("./../store/chatStore.ts");

  it("records approve/deny decisions from the single responder funnel", () => {
    expect(src).toContain("AUDIT_KINDS.approvalApprove : AUDIT_KINDS.approvalDeny");
    // Fire-and-forget: the append happens before the responder runs but must
    // not await anything (the approval click must stay instant).
    expect(src).toContain("auditAppend(");
  });
});

describe("security deny audit hook", () => {
  const src = read("./security.ts");

  it("records read denials at every early-return in checkReadableCanonical", () => {
    const occurrences = src.split('auditDeny("read"').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });

  it("records write denials at every early-return in checkWritableCanonical", () => {
    const occurrences = src.split('auditDeny("write"').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(4);
  });

  it("uses the security.deny kind", () => {
    expect(src).toContain("AUDIT_KINDS.securityDeny");
  });
});
