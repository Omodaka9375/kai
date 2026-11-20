import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * System-prompt STABILITY contract (2026-11-20): mode blocks that toggle
 * mid-session (auto-approve hint, plan mode) must NEVER be part of the
 * system prompt. Anthropic 5.x validates replayed thinking-block
 * signatures against the request prefix (system + tools + messages) -
 * a rebuilt system prompt 400s every later request with
 * "Invalid signature in thinking block. The block is bound to a
 * different conversation." Both blocks ride the per-turn last-user
 * injection instead (same slot as the env block).
 */

const src = (rel: string): string =>
  readFileSync(resolve(__dirname, rel), "utf8");

describe("system prompt stability (thinking signature prefix rule)", () => {
  it("the auto-approve hint rides the last-user injection, not the system prompt", () => {
    const transport = src("./transport.ts");
    // Present in the per-turn injection payload.
    expect(transport).toContain(
      "[envBlock, relevantBlock, autoApproveHint, planModeBlock]",
    );
    // NOT appended to the custom instructions (the old system-prompt slot).
    expect(transport).not.toMatch(
      /effectiveCustomInstructions\s*=[^;]*autoApproveHint/,
    );
  });

  it("the plan-mode block rides the last-user injection too", () => {
    const transport = src("./transport.ts");
    expect(transport).toContain(
      'deps.getPlanMode?.() ? PLAN_MODE_PROMPT : ""',
    );
    // agent.ts must not suffix the block onto the system prompt anymore.
    const agent = src("./agent.ts");
    expect(agent).not.toContain("${stableSystem}\\n\\n${PLAN_MODE_PROMPT}");
  });

  it("agent.ts still journals the planMode flag (evidence of what the request contained)", () => {
    const agent = src("./agent.ts");
    expect(agent).toContain("planMode: opts.planMode === true");
  });
});
