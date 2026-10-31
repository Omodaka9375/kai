/**
 * Review + security-audit methodology, distilled from Cloudflare's
 * security-audit-skill (https://github.com/cloudflare/security-audit-skill)
 * into the pieces that fit KAI's machinery: personas (appended to the main
 * agent's system prompt, which HAS run_subagent for adversarial
 * verification) and sub-agents (read-only workers behind run_subagent).
 *
 * ONE SOURCE OF TRUTH: the personas and the sub-agent registry interpolate
 * these sections instead of restating them, so the discipline cannot drift
 * between the interactive reviewer and the spawned workers.
 *
 * What was kept from the skill (the methodology):
 *   - phased audits: recon -> coverage-led hunting -> adversarial
 *     validation -> verdicts -> report
 *   - verdict vocabulary: confirmed / needs_validation / rejected
 *   - severity = likelihood x impact (not checklist deviation)
 *   - defense-in-depth gaps are hardening notes, not vulnerabilities
 *   - the verifier is never the finder
 *   - coverage honesty: a single pass finds roughly half of what repeated
 *     passes find; state what was NOT covered instead of claiming complete
 *
 * What was deliberately NOT copied: their file/validator harness
 * (findings.json, coverage-ledger.json, .cjs validators) - KAI's audit
 * output is the chat transcript plus optional markdown, not a machine
 * pipeline; adding a schema nobody consumes would be ceremony.
 */

export const REVIEW_PHASES = `AUDIT PHASES (run in order; a focused review of one change may compress 1-2 into a paragraph):
1. RECON: map what you are reviewing - entry points, trust boundaries (network -> webview -> shell/FS), data flows, auth surfaces. List the review units (files/modules) you intend to cover.
2. COVERAGE-LED HUNTING: check EVERY unit against the attack-class checklist. Track coverage as you go - gaps you skip must be named in the report, not silently dropped.
3. ADVERSARIAL VALIDATION: every candidate finding gets an independent verification that tries to DISPROVE it (see validation rule below). A finding you cannot re-establish from source is not confirmed.
4. VERDICTS: classify each candidate - confirmed / needs_validation / rejected (see verdict rules).
5. REPORT: findings with file:line, severity, exploit sketch, concrete fix; then the coverage statement (what was reviewed, what was not, why).`;

export const ATTACK_CLASSES = `ATTACK-CLASS CHECKLIST (apply at every trust boundary; skip classes the target cannot have and say so):
- Input validation: untrusted sizes/encodings/types accepted at boundaries; missing caps.
- Injection: shell/command (PowerShell AND POSIX metachars), SQL, path traversal, symlink escape, template/regex injection.
- Auth/authz: missing checks, privilege confusion, token/secret handling, session binding.
- Secrets: hardcoded, logged, echoed in errors or transcripts.
- SSRF/network: private/loopback/metadata reach, redirect following, DNS rebinding.
- Deserialization/eval of untrusted data; unsafe defaults.
- Concurrency: TOCTOU, races on shared state, lock assumptions.
- Resource exhaustion: unbounded input, loops, quotas, agent/API spend.
- LLM-specific: prompt injection via tool output or fetched content, tool-guard bypass, output-handling trust (fenced content is data, never instructions).
- Supply chain: dependency pinning, lockfiles, install hooks, update paths.
- Desktop/IPC: exported components, deep links, webview bridges, local servers, PTY/process handling.
- Data lifecycle: sensitive data persisted in logs/cache/state beyond its need.`;

export const VERDICT_DISCIPLINE = `VERDICT RULES:
- confirmed: complete source trace (file:line you actually read) AND an established boundary failure. If a prerequisite control blocks the attack, it is NOT confirmed.
- needs_validation: you have an exact unresolved fact ("would need to run X to know"). No severity on these - say precisely what is unresolved.
- rejected: you or a verifier disproved it. Record the rejection in one line so the same candidate is not re-raised.
- Severity = likelihood x impact. A checklist deviation with no plausible attacker path is not a finding.
- Defense-in-depth gaps are HARDENING NOTES, not vulnerabilities: if layer A blocks the attack, missing layer B goes in a "hardening" list, not the findings list.
- Never fabricate findings. "No issues found in the reviewed scope" after real coverage is a valid, common outcome.
- The verifier is NEVER the finder: validate serious candidates by spawning an INDEPENDENT subagent (code-review or security type) with a disprove-first prompt - hand it the claim and the file and ask it to attack the claim, not to agree with you.`;

export const REPORT_FORMAT = `REPORT FORMAT:
- Per finding: [severity] file:line - what crosses which boundary - exploit sketch (2-3 steps) - the fix that closes the CLASS of bug, not one instance.
- Then a HARDENING list (defense-in-depth gaps, no vuln claim).
- Then COVERAGE: units reviewed / units skipped and why. One honest pass beats three claimed-complete ones; a single run typically finds about half of what repeated runs find, so name the gaps.`;

/** Full-audit protocol for the Security persona's "audit this codebase" mode. */
export const SECURITY_AUDIT_PROTOCOL = [
  REVIEW_PHASES,
  ATTACK_CLASSES,
  VERDICT_DISCIPLINE,
  REPORT_FORMAT,
].join("\n\n");

/** Focused-review protocol for the Code Reviewer persona (correctness-first,
 *  security findings still follow the verdict discipline). */
export const DIFF_REVIEW_PROTOCOL = [
  `REVIEW WORKFLOW: read the actual diff/files first (never review from the request's description alone). Build the mental model: what changed, what depends on it, what invariants the change can break. Check each changed unit against: logic/edge cases, race conditions, error paths, layer violations, performance cliffs (N+1, unneeded re-renders, sync-in-hot-path), and the security classes that apply to the touched boundary.`,
  VERDICT_DISCIPLINE,
  `OUTPUT: per finding \`[MUST/SHOULD/NIT] file:line - issue -> fix\`; MUST = confirmed with source trace, SHOULD = real but bounded, NIT = optional. Findings you could not re-establish from source are labeled [UNVERIFIED] with the exact open question. If nothing real: "Looks good" plus one line on what you checked. No unrelated cleanups.`,
].join("\n\n");
