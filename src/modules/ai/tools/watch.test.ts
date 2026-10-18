import { describe, expect, it, vi, beforeEach } from "vitest";

// The tool module imports the Tauri native bridge and the chat store — both
// unavailable in Node. Mock them before the module loads; the pure exports
// under test (pollTimeoutSecsFor, evaluateCondition, WATCH_MAX_CONSECUTIVE_FAILURES)
// never touch them on their paths.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../lib/native", () => ({
  native: {
    shellSessionRun: vi.fn(),
    shellSessionOpen: vi.fn(),
    shellSessionClose: vi.fn(),
    watchHeartbeat: vi.fn(),
  },
}));
vi.mock("../store/chatStore", () => ({
  useChatStore: { getState: () => ({ injectMessage: vi.fn() }) },
  flushAllPendingWatchWakes: vi.fn(),
}));
vi.mock("../lib/security", () => ({
  checkShellCommand: vi.fn(() => ({ ok: true })),
}));
vi.mock("../lib/sandbox", () => ({
  checkShellSandbox: vi.fn(async () => ({ ok: true })),
  sandboxExecRoot: vi.fn(async () => null),
}));

const watchModule = await import("./watch");

describe("pollTimeoutSecsFor", () => {
  it("scales the per-poll timeout to the interval", () => {
    // Slow command on a short interval must not serialize three tick periods.
    expect(watchModule.pollTimeoutSecsFor(5)).toBe(5);
    expect(watchModule.pollTimeoutSecsFor(15)).toBe(15);
    expect(watchModule.pollTimeoutSecsFor(30)).toBe(30);
  });

  it("caps at 30s for long intervals", () => {
    expect(watchModule.pollTimeoutSecsFor(60)).toBe(30);
    expect(watchModule.pollTimeoutSecsFor(300)).toBe(30);
  });
});

describe("evaluateCondition", () => {
  const result = {
    exit_code: 0,
    stdout: "MERGED into main",
    stderr: "",
    timed_out: false,
  };

  it("fires unconditionally when no condition is given", () => {
    expect(watchModule.evaluateCondition(undefined, result)).toBe(true);
  });

  it("evaluates exit-code conditions", () => {
    expect(watchModule.evaluateCondition("exit_code !== 0", result)).toBe(false);
    expect(
      watchModule.evaluateCondition("exit_code !== 0", { ...result, exit_code: 1 }),
    ).toBe(true);
  });

  it("evaluates stdout-content conditions", () => {
    expect(watchModule.evaluateCondition('stdout.includes("MERGED")', result)).toBe(true);
    expect(watchModule.evaluateCondition('stdout.includes("CLOSED")', result)).toBe(false);
  });

  it("sees timed_out", () => {
    expect(
      watchModule.evaluateCondition("timed_out", { ...result, timed_out: true }),
    ).toBe(true);
  });

  it("returns false on a throwing condition, never crashes", () => {
    expect(watchModule.evaluateCondition("stdout.missing.property", result)).toBe(false);
    expect(watchModule.evaluateCondition("syntax ((( error", result)).toBe(false);
  });
});

describe("evaluateConditionChecked", () => {
  const result = {
    exit_code: 0,
    stdout: "MERGED into main",
    stderr: "",
    timed_out: false,
  };

  it("reports ok for a valid expression (match and no-match)", () => {
    expect(watchModule.evaluateConditionChecked("exit_code === 0", result)).toEqual({
      ok: true,
      value: true,
    });
    expect(watchModule.evaluateConditionChecked("exit_code === 1", result)).toEqual({
      ok: true,
      value: false,
    });
  });

  it("reports ok:true with value:true when no condition is given", () => {
    expect(watchModule.evaluateConditionChecked(undefined, result)).toEqual({
      ok: true,
      value: true,
    });
  });

  it("reports ok:false for a typo'd identifier (the never-fires trap)", () => {
    // A typo like `resuls` throws a ReferenceError on EVERY poll — the watch
    // could never fire, yet the old code treated it as a normal no-match.
    expect(watchModule.evaluateConditionChecked("resuls.exit_code === 0", result)).toMatchObject({
      ok: false,
    });
  });

  it("reports ok:false for a syntax error", () => {
    expect(watchModule.evaluateConditionChecked("syntax ((( error", result)).toMatchObject({
      ok: false,
    });
  });

  it("parses the eval-free DSL the packaged CSP requires (regression: every conditional watch auto-stopped under script-src without unsafe-eval)", () => {
    // The exact condition from the field report that auto-stopped in the
    // packaged app: an A || B of .includes over stdout.
    expect(
      watchModule.evaluateConditionChecked(
        '((stdout || "")).includes("ALL_EVALS_DONE") || ((stdout || "")).includes("eval chain exited")',
        { ...result, stdout: "… ALL_EVALS_DONE …" },
      ),
    ).toEqual({ ok: true, value: true });
    expect(
      watchModule.evaluateConditionChecked(
        '((stdout || "")).includes("ALL_EVALS_DONE") || ((stdout || "")).includes("eval chain exited")',
        { ...result, stdout: "still running" },
      ),
    ).toEqual({ ok: true, value: false });
  });

  it("supports the full documented DSL surface", () => {
    // Comparisons, .length, !, &&, parentheses, numeric literals.
    expect(watchModule.evaluateConditionChecked("stdout.length > 3", result)).toEqual({
      ok: true,
      value: true,
    });
    expect(watchModule.evaluateConditionChecked("stdout.length > 100", result)).toEqual({
      ok: true,
      value: false,
    });
    expect(watchModule.evaluateConditionChecked("exit_code !== 0", result)).toEqual({
      ok: true,
      value: false,
    });
    expect(
      watchModule.evaluateConditionChecked(
        "(exit_code === 0 && stdout.includes(\"MERGED\")) || timed_out",
        result,
      ),
    ).toEqual({ ok: true, value: true });
    expect(watchModule.evaluateConditionChecked("!timed_out", result)).toEqual({
      ok: true,
      value: true,
    });
  });

  it("reports a parser reason for DSL violations (no more blind catch)", () => {
    const out = watchModule.evaluateConditionChecked("exit_code.process.pid === 0", result);
    expect(out.ok).toBe(false);
    expect(typeof out.reason).toBe("string");
    expect(out.reason!.length).toBeGreaterThan(0);
    // Method outside the DSL is rejected, not silently false.
    const evil = watchModule.evaluateConditionChecked(
      'stdout.constructor.constructor("return 1")()',
      result,
    );
    expect(evil.ok).toBe(false);
  });
});

describe("circuit breaker threshold", () => {
  it("trips after 10 consecutive failures", () => {
    expect(watchModule.WATCH_MAX_CONSECUTIVE_FAILURES).toBe(10);
  });
});

describe("watch registry lifecycle", () => {
  beforeEach(() => {
    // Clear any watches left by other tests.
    for (const w of watchModule.listWatches()) {
      watchModule.stopWatchById(w.id);
    }
  });

  it("reaps only the owning session's watches", () => {
    watchModule.reapSessionWatches("session-a");
    expect(watchModule.listWatches().every((w) => w.sessionId !== "session-a")).toBe(true);
  });
});

describe("notify_telegram (schema field → WatchConfig)", () => {
  // The schema exposes notify_telegram; the config carries notifyTelegram.
  // Contract test: the field name must survive the snake→camel boundary —
  // a dropped param would silently disable phone pings (the voice_arg bug
  // class: unknown keys are silently ignored by the AI SDK).
  it("is described in the watch_create schema", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./watch.ts", import.meta.url), "utf8"),
    );
    expect(src).toContain("notify_telegram: z.boolean().optional()");
    expect(src).toContain("notifyTelegram: notify_telegram === true");
    // And the firing path actually pings when the flag is set.
    expect(src).toContain("if (w.notifyTelegram)");
    expect(src).toContain("telegramPing");
  });
});

