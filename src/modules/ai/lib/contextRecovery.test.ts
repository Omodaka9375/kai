import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compactModelMessagesDetailed, effectiveContextLimit } from "./compact";

/**
 * Context-continuity contract (2026-10-31) — the "restart resumes at 4%
 * but a live session hits the context limit" report.
 *
 * The restart path compacts at EVERY send (transport.maybeSummarize ->
 * agent pre-run compaction), which is why a fresh start of a heavy session
 * sails through. The live path had three gaps, all pinned here:
 *
 *  1. MID-RUN GROWTH: the pre-run compaction ran once at send time; steps
 *     2..N re-attached fresh tool results with no re-elision. Fixed: agent.ts
 *     prepareStep re-runs compactModelMessagesDetailed on the step messages
 *     and overrides them when anything changed.
 *  2. NO OVERFLOW RECOVERY: a provider 400 "prompt is too long" fell to the
 *     manual error card. Fixed: isContextOverflowError routes it into the
 *     same compact-and-retry machinery stalls use (one retry, distinct
 *     notice, own budget).
 *  3. LATE TRIGGER: summarization fired at 75% of effective limit, leaving
 *     only 25% headroom at send time. Fixed: 60%, aligned with phase-2.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8") as string;

describe("mid-run re-elision (agent.ts prepareStep)", () => {
  const agent = read("./agent.ts");

  it("prepareStep re-runs the compaction on the step messages", () => {
    expect(agent).toMatch(
      /prepareStep: \(\{ messages: stepMessages \}\) => \{[\s\S]*?compactModelMessagesDetailed\(messages, contextLimit\)/,
    );
  });

  it("a changed step history overrides THIS step's messages (the SDK contract)", () => {
    expect(agent).toMatch(/messages = stepCompact\.messages;/);
    expect(agent).toMatch(
      /return messages === stepMessages\s*\n\s*\?\s*undefined\s*\n\s*:\s*\{ messages \};/,
    );
  });

  it("mid-run elision is journaled like the pre-run one (model-visible <=> logged)", () => {
    // At least TWO compact journal sites: the pre-run one and prepareStep's.
    expect((agent.match(/kind: "compact",/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("overflow recovery (chatRuntime.ts)", () => {
  const runtime = read("./chatRuntime.ts");

  it("the overflow branch runs BEFORE the stall branch and uses the same compact machinery", () => {
    const overflowIdx = runtime.indexOf("isContextOverflowError(e)");
    const stallIdx = runtime.indexOf("isStallError(e)");
    expect(overflowIdx).toBeGreaterThan(-1);
    expect(stallIdx).toBeGreaterThan(overflowIdx);
    expect(runtime).toContain("context-overflow-compacted");
  });

  it("one retry max, reset on successful finish", () => {
    expect(runtime).toContain("const MAX_OVERFLOW_RETRIES = 1;");
    expect(runtime).toContain("overflowRetriesRef.current = 0;");
  });

  it("an already-minimal history falls through to the manual error card", () => {
    // The overflow branch only returns early when the compact SUCCEEDED.
    const branch = runtime.slice(
      runtime.indexOf("isContextOverflowError(e)"),
      runtime.indexOf("isStallError(e)"),
    );
    expect(branch).toContain("if (compacted) {");
  });
});

describe("summarization threshold (compact.ts)", () => {
  const src = read("./compact.ts");

  it("fires at 60% of the effective limit (was 75% - one heavy step of headroom)", () => {
    expect(src).toContain("approxTokens >= 0.6 * effectiveLimit");
    expect(src).not.toContain("0.75 * effectiveLimit");
  });

  it("behavior: needsSummarization fires at 60-75% (previously silent)", () => {
    // 32k limit -> effective 14k (floor 8k not hit). 60% = 8400 tokens.
    const limit = 32_000;
    const eff = effectiveContextLimit(limit);
    const target = 0.68 * eff; // between the new (60%) and old (75%) triggers
    const msg = { role: "user" as const, content: "x".repeat(target * 4) };
    const r = compactModelMessagesDetailed([msg], limit);
    expect(r.needsSummarization).toBe(true);
  });
});
