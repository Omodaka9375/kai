import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-contract tests for the bash_run timeout behavior (project pattern:
 * no jsdom; the two linkages pinned here both shipped broken before).
 *
 * 1. slowCommandTimeout is internal, so its VALUES are pinned via the
 *    source: test commands must get 300s, not 120s — vitest/jest boot a
 *    per-file worker pool (30-60s node_modules resolution cold) and a full
 *    suite regularly exceeds 120s through pnpm -> node -> runner, which
 *    killed the pwsh runner MID-TEST with all collected output lost (the
 *    recurring artifact; same class as 8a58c89's build fix).
 * 2. A timeout result must carry a `hint` that names the escape routes
 *    (bash_background detach, larger timeout_secs) — otherwise the agent
 *    retries the same undersized call blind.
 */

const src = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");

describe("slowCommandTimeout heuristics", () => {
  it("gives test/lint/typecheck/check commands 300s, not 120s", () => {
    expect(src).toMatch(/\(test\|lint\|typecheck\|check\)\\b\/\.test\(lower\)\) return 300;/);
    expect(src).not.toMatch(/\(test\|lint\|typecheck\|check\)\\b\/\.test\(lower\)\) return 120;/);
  });

  it("covers bare runner invocations (vitest/jest) too", () => {
    // shell.ts regex literal, matched as plain source text: \b(vitest|jest)\b
    expect(src).toContain("\\b(vitest|jest)\\b");
  });

  it("keeps the 600s class for builds and cargo/tsc", () => {
    expect(src).toContain("return 600;");
    expect(src).toContain("(cargo\\s+build|cargo\\s+test|tsc)");
  });
});

describe("timeout result is actionable for the agent", () => {
  it("branch on r.timed_out returns a hint naming bash_background and timeout_secs", () => {
    expect(src).toContain("if (r.timed_out) {");
    // The hint names both escape routes and the actual budget.
    expect(src).toMatch(/hint: `Command exceeded the \$\{effectiveTimeout\}s timeout/);
    expect(src).toContain("re-spawn it via bash_background and poll bash_logs");
    expect(src).toContain("larger timeout_secs (max 1000)");
    // Non-timeout path must stay a clean result WITHOUT the hint field.
    const nonTimeout = src.split("if (r.timed_out) {")[1] ?? "";
    expect(nonTimeout).toContain("timed_out: false");
  });
});
