/**
 * Fit check unit tests — fixtures and grader are pure, so these run without
 * a Tauri backend. The runner itself (needs native fs) is exercised
 * manually via the Settings dialog.
 */

import { describe, expect, it } from "vitest";
import {
  allFixtures,
  makeFitCheckSeed,
  surgicalFixFixture,
  fixAndRecoverFixture,
  readOnlyControlFixture,
} from "./fixtures";
import { gradeMission, type MissionResult } from "./grader";
import { fixtureParentDirs } from "./runner";

function resultFor(
  fixture: ReturnType<typeof allFixtures>[number],
  overrides: Partial<MissionResult> = {},
): MissionResult {
  return {
    fixture,
    testOutput: null,
    finalText: "",
    files: fixture.files.map((f) => ({ path: f.path, changed: false })),
    calls: [],
    recoveredAfterInjectedError: null,
    repeatedIdenticalCall: null,
    infrastructureError: null,
    ...overrides,
  };
}

describe("fixtures", () => {
  it("produces three missions with unique ids", () => {
    const seed = makeFitCheckSeed();
    const fixtures = allFixtures(seed);
    const ids = fixtures.map((f) => f.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain("surgical-fix");
    expect(ids).toContain("fix-and-recover");
    expect(ids).toContain("read-only-control");
  });

  it("varies with the seed (anti-memorization)", () => {
    const a = surgicalFixFixture({ base: 111, tag: 1111 });
    const b = surgicalFixFixture({ base: 999, tag: 9999 });
    expect(a.files[0]!.content).not.toBe(b.files[0]!.content);
    const controlA = readOnlyControlFixture({ base: 111, tag: 1111 });
    const controlB = readOnlyControlFixture({ base: 999, tag: 9999 });
    expect(controlA.expects?.answerRe).not.toBe(controlB.expects?.answerRe);
  });

  it("surgical fixture fails tests as shipped and passes after the one-line fix", () => {
    const seed = { base: 200, tag: 1234 };
    const f = surgicalFixFixture(seed);
    // Simulate the fix: remove the +1.
    const math = f.files[0]!.content.replace(" + 1;", ";");
    const fixed = {
      ...f,
      files: f.files.map((file, i) =>
        i === 0 ? { ...file, content: math } : file,
      ),
    };
    // The EXPECTED constant must equal scale(1) after the fix.
    const re = /return value \* factor;/;
    expect(re.test(math)).toBe(true);
    const factor = Number(
      /export function scale\(value, factor = (\d+)\)/.exec(
        fixed.files[0]!.content,
      )![1],
    );
    const expected = Number(
      /EXPECTED_SCALE_1 = (\d+)/.exec(fixed.files[0]!.content)![1],
    );
    expect(1 * factor).toBe(expected);
    void seed;
  });

  it("control fixture answer matches its own arithmetic", () => {
    const seed = { base: 300, tag: 1234 };
    const f = readOnlyControlFixture(seed);
    const answer = Number(f.expects?.answerRe);
    const question = Number(
      /what is (\d+) \* 3 \+ 7/.exec(f.files[0]!.content)![1],
    );
    expect(question * 3 + 7).toBe(answer);
  });

  it("fix-and-recover fixture carries an injected-error drill", () => {
    const f = fixAndRecoverFixture({ base: 50, tag: 1234 });
    expect(f.injectErrorOnFirstCall?.tool).toBe("edit");
    expect(f.injectErrorOnFirstCall?.error).toBeTruthy();
  });
});

describe("fixtureParentDirs - the already-exists regression", () => {
  // The first shipped version created a parent dir once PER FILE; sibling
  // files sharing a directory (surgical-fix: src/math.js + src/math.test.js)
  // hit fs_create_dir's "already exists" refusal on the second call and
  // aborted the whole fit check with a red error.
  it("yields ONE entry for sibling files sharing a directory", () => {
    const f = surgicalFixFixture({ base: 100, tag: 1234 });
    const dirs = fixtureParentDirs(f, "base\\surgical-fix");
    expect(dirs).toEqual(["base\\surgical-fix\\src"]);
  });

  it("returns nothing for root-level files and stays separator-safe", () => {
    const control = readOnlyControlFixture({ base: 100, tag: 1234 });
    expect(fixtureParentDirs(control, "base/control")).toEqual([]);
    const f = fixAndRecoverFixture({ base: 100, tag: 1234 });
    expect(fixtureParentDirs(f, "base/recover")).toEqual(["base/recover/lib"]);
  });
});


describe("grader", () => {
  it("passes a clean surgical mission", () => {
    const f = surgicalFixFixture({ base: 100, tag: 1234 });
    const r = resultFor(f, {
      testOutput: { exitCode: 0, stdout: "ok" },
      finalText: "FIX_DONE",
      calls: [
        { tool: "bash_run", executed: true },
        { tool: "edit", executed: true },
        { tool: "bash_run", executed: true },
      ],
    });
    const verdict = gradeMission(r);
    expect(verdict.pass).toBe(true);
    expect(verdict.reason).toBeNull();
  });

  it("fails when tests do not pass after the run", () => {
    const f = surgicalFixFixture({ base: 100, tag: 1234 });
    const verdict = gradeMission(
      resultFor(f, { testOutput: { exitCode: 1, stdout: "fail" } }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("do not pass");
  });

  it("fails when the model modified a test file", () => {
    const f = surgicalFixFixture({ base: 100, tag: 1234 });
    const verdict = gradeMission(
      resultFor(f, {
        testOutput: { exitCode: 0, stdout: "ok" },
        files: f.files.map((file) => ({
          path: file.path,
          changed: file.path.endsWith(".test.js"),
        })),
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("test file");
  });

  it("fails the control on writes", () => {
    const f = readOnlyControlFixture({ base: 100, tag: 1234 });
    const verdict = gradeMission(
      resultFor(f, {
        finalText: "The answer is 307",
        files: f.files.map((file) => ({ path: file.path, changed: true })),
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/modified/);
  });

  it("fails the control on shell calls", () => {
    const f = readOnlyControlFixture({ base: 100, tag: 1234 });
    const verdict = gradeMission(
      resultFor(f, {
        finalText: "307",
        calls: [{ tool: "bash_run", executed: true }],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("Shell");
  });

  it("passes the control with correct answer and no actions", () => {
    const f = readOnlyControlFixture({ base: 100, tag: 1234 });
    const answer = f.expects!.answerRe;
    const verdict = gradeMission(resultFor(f, { finalText: `The answer is ${answer}.` }));
    expect(verdict.pass).toBe(true);
  });

  it("marks infrastructure errors as inconclusive, not model failure", () => {
    const f = surgicalFixFixture({ base: 100, tag: 1234 });
    const verdict = gradeMission(
      resultFor(f, { infrastructureError: "401 unauthorized" }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("Infrastructure");
  });

  it("fails the recovery drill when the identical call was repeated", () => {
    const f = fixAndRecoverFixture({ base: 100, tag: 1234 });
    const verdict = gradeMission(
      resultFor(f, {
        testOutput: { exitCode: 0, stdout: "ok" },
        recoveredAfterInjectedError: false,
        repeatedIdenticalCall: true,
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("identical");
  });

  it("passes the recovery drill after a corrected retry", () => {
    const f = fixAndRecoverFixture({ base: 100, tag: 1234 });
    const verdict = gradeMission(
      resultFor(f, {
        testOutput: { exitCode: 0, stdout: "ok" },
        recoveredAfterInjectedError: true,
        repeatedIdenticalCall: false,
      }),
    );
    expect(verdict.pass).toBe(true);
  });

  it("fails protocol when calls never executed", () => {
    const f = surgicalFixFixture({ base: 100, tag: 1234 });
    const verdict = gradeMission(
      resultFor(f, {
        testOutput: { exitCode: 0, stdout: "ok" },
        calls: [
          { tool: "edit", executed: true },
          { tool: "read_file", executed: false },
        ],
      }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain("protocol");
  });
});