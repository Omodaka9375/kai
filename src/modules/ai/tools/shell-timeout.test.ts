import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { capOutputForContext } from "./shell";

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

describe("capOutputForContext — stream reaches the model, not the whole capture", () => {
  it("passes short output through untouched (no marker, no elision)", () => {
    const s = "hello\nworld";
    const r = capOutputForContext(s);
    expect(r.text).toBe(s);
    expect(r.elided).toBe(0);
  });

  it("keeps the head and tail and elides only the middle when over budget", () => {
    const head = "H".repeat(8192);
    const mid = "M".repeat(50_000);
    const tail = "T".repeat(8192);
    const r = capOutputForContext(head + mid + tail, 8192, 8192);
    expect(r.elided).toBe(50_000);
    expect(r.text.startsWith(head)).toBe(true);
    expect(r.text.endsWith(tail)).toBe(true);
    expect(r.text).toContain("50,000 characters elided");
    // The middle must NOT be present verbatim (that's the context sink).
    expect(r.text).not.toContain(mid);
    // Marker carries an actionable escape route.
    expect(r.text).toContain("> out.log");
  });

  it("is an identity at the exact budget boundary", () => {
    const s = "x".repeat(8192 + 8192);
    expect(capOutputForContext(s).elided).toBe(0);
    expect(capOutputForContext(s + "y").elided).toBe(1);
  });

  it("bash_run wires the cap into every return branch (source contract)", () => {
    // stdout/stderr are capped once at the source and `truncated` reflects
    // elision via outTruncated, so a verbose command can't silently fill
    // context on either the normal or timed_out path.
    expect(src).toContain("const stdoutCapped = capOutputForContext(stripAnsi(r.stdout));");
    expect(src).toContain("const stderrCapped = capOutputForContext(stripAnsi(r.stderr));");
    expect(src).toContain("const outTruncated = r.truncated || stdoutCapped.elided > 0");
    // No session-path return still passes the raw r.truncated through.
    expect(src).toContain("truncated: outTruncated,");
    // Elevated branch caps independently.
    expect(src).toContain("const so = capOutputForContext(stripAnsi(r.stdout));");
  });
});
