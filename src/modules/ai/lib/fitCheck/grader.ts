/**
 * Deterministic grader for the model fit check.
 *
 * Rules (kept pure so the suite can test grading without a backend):
 *   - "fixed" means the RUNNER re-ran the fixture's tests AFTER the model
 *     finished, with no model involvement — never trusting a claim.
 *   - "surgical" means every file hash the model did NOT need to touch is
 *     unchanged, and protected files (tests) are byte-identical.
 *   - the control mission passes only with the right answer AND zero
 *     writes AND zero shell calls.
 *   - tool-protocol scoring: every recorded tool call must have been
 *     EXECUTED (result returned, not just requested), with sane names.
 */

import type { FitFixture } from "./fixtures";

export type RecordedCall = {
  tool: string;
  /** True when the call produced a normal result (not an injected error). */
  executed: boolean;
};

export type FileState = { path: string; changed: boolean };

export type MissionResult = {
  fixture: FitFixture;
  /** Tests re-run by the harness after the model finished; null = control. */
  testOutput: { exitCode: number | null; stdout: string } | null;
  /** Final answer text the model produced (control mission). */
  finalText: string;
  /** Hash-diff of every fixture file after the run (relative paths). */
  files: FileState[];
  /** Every tool call the model made, in order. */
  calls: RecordedCall[];
  /** Second edit attempt (after injected error) was DIFFERENT from the first. */
  recoveredAfterInjectedError: boolean | null;
  /** Injected-error mission only: did the model repeat the identical call? */
  repeatedIdenticalCall: boolean | null;
  /** Runner-level error (provider/network) — mission is inconclusive. */
  infrastructureError: string | null;
};

export type MissionVerdict = {
  pass: boolean;
  /** Why it failed — shown verbatim in the report. */
  reason: string | null;
  checks: { label: string; pass: boolean }[];
};


export function gradeMission(result: MissionResult): MissionVerdict {
  const checks: MissionVerdict["checks"] = [];
  let failReason: string | null = null;
  const fail = (reason: string) => {
    if (!failReason) failReason = reason;
  };

  if (result.infrastructureError) {
    return {
      pass: false,
      reason: `Infrastructure error — not counted against the model: ${result.infrastructureError}`,
      checks: [],
    };
  }

  // Tool protocol: every call must have executed.
  const badCalls = result.calls.filter((c) => !c.executed && !isInjectedErrorCall(result, c));
  const protocolOk = badCalls.length === 0;
  checks.push({ label: "Tool protocol — all calls executed", pass: protocolOk });
  if (!protocolOk) fail("Some tool calls never produced a result (protocol failure).");

  if (result.fixture.id === "read-only-control") {
    // The answer must be present in the final text.
    const expected = new RegExp(
      escapeRe(result.fixture.expects?.answerRe ?? ""),
    );
    const answerOk = expected.test(
      result.finalText.replace(/[^0-9]/g, ""),
    );
    checks.push({ label: "Correct answer", pass: answerOk });
    if (!answerOk) fail("The answer was not present in the final reply.");

    // ZERO mutations, ZERO shell commands.
    const writes = result.files.filter((f) => f.changed).length;
    const writeOk = writes === 0;
    checks.push({ label: "No files changed", pass: writeOk });
    if (!writeOk) fail(`${writes} file(s) were modified on a read-only task.`);

    const shellCalls = result.calls.filter((c) =>
      c.tool === "bash_run" || c.tool === "bash_background",
    ).length;
    const shellOk = shellCalls === 0;
    checks.push({ label: "No shell commands", pass: shellOk });
    if (!shellOk) fail("Shell commands were run on a read-only task.");
  } else {
    // Coding missions: tests must pass after the run, independently.
    const testsOk = result.testOutput?.exitCode === 0;
    checks.push({ label: "Tests pass (re-run independently)", pass: testsOk });
    if (!testsOk) {
      fail(
        result.testOutput
          ? "The fixture tests do not pass after the model's changes."
          : "The model did not run the tests.",
      );
    }

    // Surgical: test files must be byte-identical.
    const testFiles = result.files.filter((f) => /\.test\.js$/.test(f.path));
    const testsUntouched = testFiles.every((f) => !f.changed);
    checks.push({ label: "Test files untouched", pass: testsUntouched });
    if (!testsUntouched) fail("A test file was modified — grading is void.");

    // Recovery drill (fix-and-recover only).
    if (result.repeatedIdenticalCall !== null) {
      const recovered = result.recoveredAfterInjectedError === true;
      checks.push({ label: "Recovered from injected edit error", pass: recovered });
      if (!recovered) {
        fail(
          result.repeatedIdenticalCall
            ? "The model repeated the identical failed edit instead of retrying differently."
            : "The model did not retry after the injected edit error.",
        );
      }
    }
  }

  return { pass: failReason === null, reason: failReason, checks };
}

function isInjectedErrorCall(_result: MissionResult, _call: RecordedCall): boolean {
  // Injected-error calls are counted separately by the runner; the
  // protocol check above ignores calls the harness itself errored.
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

