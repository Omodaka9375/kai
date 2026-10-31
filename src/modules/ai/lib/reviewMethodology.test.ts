import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Review/security-audit methodology contract (2026-10-31).
 *
 * "I want to have a strong code review agent... we need something like
 * https://github.com/cloudflare/security-audit-skill" — KAI adopted the
 * skill's METHODOLOGY, not its file harness: the phased audit, the
 * attack-class checklist, the verdict discipline (confirmed /
 * needs_validation / rejected), severity = likelihood x impact,
 * defense-in-depth gaps as hardening notes, and adversarial validation
 * (the verifier is never the finder).
 *
 * The single source of truth is lib/reviewMethodology.ts, interpolated by
 * BOTH the builtin personas (agents.ts) and the sub-agent registry
 * (agents/registry.ts) — the discipline cannot drift between the
 * interactive reviewer and the spawned workers.
 */

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8") as string;

const method = read("./reviewMethodology.ts");
const agents = read("./agents.ts");
const registry = read("../agents/registry.ts");

describe("the methodology module carries the Cloudflare-skill discipline", () => {
  it("phases: recon, coverage-led hunting, validation, verdicts, report", () => {
    expect(method).toContain("AUDIT PHASES");
    expect(method).toMatch(/2\. COVERAGE-LED HUNTING/);
    expect(method).toMatch(/3\. ADVERSARIAL VALIDATION/);
  });

  it("verdict vocabulary is the skill's triad with its rules", () => {
    expect(method).toMatch(/confirmed \/ needs_validation \/ rejected/);
    expect(method).toContain("No severity on these");
    expect(method).toContain("Severity = likelihood x impact");
  });

  it("defense-in-depth gaps are hardening notes, never findings", () => {
    expect(method).toContain("HARDENING NOTES, not vulnerabilities");
  });

  it("the verifier-is-never-the-finder rule is stated", () => {
    expect(method).toContain("The verifier is NEVER the finder");
  });

  it("coverage honesty: skipped units are named, no completeness claims", () => {
    expect(method).toContain("what was NOT covered");
    expect(method).toContain("units skipped and why");
  });

  it("the attack-class checklist includes the classes KAI's own surfaces need", () => {
    for (const cls of [
      "SSRF",
      "prompt injection",
      "PowerShell AND POSIX",
      "Supply chain",
      "Desktop/IPC",
      "webview bridges",
      "path traversal",
    ]) {
      expect(method).toContain(cls);
    }
  });
});

describe("personas interpolate the shared methodology (no restatement drift)", () => {
  it("the Code Reviewer persona carries the diff-review protocol", () => {
    expect(agents).toContain('import {\n  DIFF_REVIEW_PROTOCOL,');
    expect(agents).toContain("DIFF_REVIEW_PROTOCOL,");
    // The [MUST/SHOULD/NIT] contract lives IN the protocol the persona
    // interpolates (reviewMethodology), not restated in agents.ts.
    expect(method).toContain("[MUST/SHOULD/NIT] file:line - issue -> fix");
  });

  it("the Security persona carries the full-audit protocol + verifier rule", () => {
    expect(agents).toContain("SECURITY_AUDIT_PROTOCOL,");
    expect(agents).toContain("FULL-AUDIT MODE");
    expect(agents).toContain("spawn an independent verifier subagent");
  });

  it("the old inline persona bodies are gone (no duplicated discipline)", () => {
    expect(agents).not.toContain("You are a meticulous code reviewer.\\n- Focus on what tools cannot catch");
    expect(agents).not.toContain("Threat-model the change: what attacker, what asset");
  });
});

describe("sub-agents interpolate the same sections + verifier instructions", () => {
  it("registry imports the shared modules", () => {
    expect(registry).toContain('import {\n  ATTACK_CLASSES,');
    expect(registry).toContain("VERDICT_DISCIPLINE,\n} from \"../lib/reviewMethodology\";");
  });

  it("both review subagents embed the verdict discipline", () => {
    const crIdx = registry.indexOf('"code-review"');
    const secIdx = registry.indexOf("  security: {");
    const crBlock = registry.slice(crIdx, secIdx);
    const secBlock = registry.slice(secIdx);
    expect(crBlock).toContain("VERDICT_DISCIPLINE");
    expect(secBlock).toContain("VERDICT_DISCIPLINE");
    expect(secBlock).toContain("ATTACK_CLASSES");
  });

  it("both review subagents carry disprove-first verifier instructions", () => {
    expect(registry).toMatch(/DISPROVE it: re-read the cited source/g);
    // The security verifier reports the blocked-at triad.
    expect(registry).toContain("survives / blocked-at (file:line) / unverifiable");
  });

  it("the old single-string prompts are gone", () => {
    expect(registry).not.toContain(
      "You are a code-review subagent. Inspect the requested code and report only ACTIONABLE findings: correctness bugs, architecture violations, performance issues, security risks. Skip style/formatting. Format",
    );
  });
});

describe("run_subagent tool-facing docs expose the review types", () => {
  it("the tool description derives its type list from the registry", () => {
    const subagent = read("../tools/subagent.ts");
    // Types flow from SUBAGENTS via TYPE_KEYS, so the verifier types are
    // always in the model-facing list without a literal string here.
    expect(subagent).toContain("TYPE_KEYS");
    expect(registry).toContain('"code-review": {');
    expect(registry).toContain("  security: {");
  });
});
