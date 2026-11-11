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
    shellSessionClose: vi.fn(async () => undefined),
    shellSessionCancel: vi.fn(async () => undefined),
    watchHeartbeat: vi.fn(async () => undefined),
  },
}));
const { injectMessageMock } = vi.hoisted(() => ({ injectMessageMock: vi.fn() }));
vi.mock("../store/chatStore", () => ({
  useChatStore: { getState: () => ({ injectMessage: injectMessageMock }) },
  flushAllPendingWatchWakes: vi.fn(),
  // Cross-project news surfacing (watch firing in a non-active project).
  projectIdForSession: vi.fn(() => null),
  activeProjectId: vi.fn(() => null),
}));
vi.mock("../lib/security", () => ({
  checkShellCommand: vi.fn(() => ({ ok: true })),
  powerShellFileSurgeryHint: vi.fn(() => null),
}));
vi.mock("../lib/sandbox", () => ({
  checkShellSandbox: vi.fn(async () => ({ ok: true })),
  sandboxExecRoot: vi.fn(async () => null),
}));

const watchModule = await import("./watch");
const { native } = await import("../lib/native");

type TestContext = import("./context").ToolContext;
function testContext(nativeOverride?: TestContext["native"]): TestContext {
  return {
    getSessionId: () => "watch-create-session",
    getCwd: () => "D:/watch-root",
    native: nativeOverride,
  } as TestContext;
}

type CreateTool = {
  execute: (input: {
    command: string;
    interval_secs: number;
    condition?: string;
    mode: "fire_on_match" | "fire_on_change";
  }) => Promise<{ error?: string; watch_id?: string }>;
};

describe("watch creation", () => {
  beforeEach(() => {
    for (const w of watchModule.listWatches()) watchModule.stopWatchById(w.id);
    vi.mocked(native.shellSessionOpen).mockReset();
  });

  it("rejects an invalid condition before opening a shell", async () => {
    const tools = watchModule.buildWatchTools(testContext());
    const result = await (tools.watch_create as unknown as CreateTool).execute({
      command: "status",
      interval_secs: 60,
      mode: "fire_on_match",
      condition: "stdout.trim() === \"ready\"",
    });
    expect(result.error).toContain("Invalid watch condition");
    expect(native.shellSessionOpen).not.toHaveBeenCalled();
  });

  it("opens a separate shell for each watch with its captured cwd", async () => {
    vi.mocked(native.shellSessionOpen).mockResolvedValueOnce(11).mockResolvedValueOnce(12);
    const create = watchModule.buildWatchTools(testContext()).watch_create as unknown as CreateTool;
    const first = await create.execute({ command: "Get-Location", interval_secs: 60, mode: "fire_on_change" });
    const second = await create.execute({ command: "Get-Location", interval_secs: 60, mode: "fire_on_change" });
    expect(native.shellSessionOpen).toHaveBeenCalledTimes(2);
    expect(native.shellSessionOpen).toHaveBeenNthCalledWith(1, "D:/watch-root");
    expect(native.shellSessionOpen).toHaveBeenNthCalledWith(2, "D:/watch-root");
    expect(first.watch_id).not.toBe(second.watch_id);
  });

  it("keeps the five-watch cap when creation calls run concurrently", async () => {
    vi.mocked(native.shellSessionOpen).mockImplementation(async () => 20);
    const create = watchModule.buildWatchTools(testContext()).watch_create as unknown as CreateTool;
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      create.execute({ command: `status-${i}`, interval_secs: 60, mode: "fire_on_change" }),
    ));
    expect(results.filter((r) => r.watch_id)).toHaveLength(5);
    expect(results.filter((r) => r.error)).toHaveLength(1);
    expect(native.shellSessionOpen).toHaveBeenCalledTimes(5);
  });
});

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

  it("treats a missing exit code as a failed command, not a broken condition", () => {
    const killed = { ...result, exit_code: null };
    expect(watchModule.evaluateConditionChecked("exit_code !== 0", killed)).toEqual({
      ok: true,
      value: true,
    });
    expect(watchModule.evaluateConditionChecked("exit_code === 0", killed)).toEqual({
      ok: true,
      value: false,
    });
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
    vi.mocked(native.shellSessionRun).mockReset();
    vi.mocked(native.shellSessionOpen).mockReset();
    vi.mocked(native.shellSessionCancel).mockClear();
    vi.mocked(native.shellSessionClose).mockClear();
    injectMessageMock.mockReset();
  });

  it("reaps only the owning session's watches", async () => {
    await watchModule.startWatch({
      id: "watch-reap-a",
      command: "status",
      intervalSecs: 60,
      mode: "fire_on_match",
      shellId: 1,
      cwd: null,
      sessionId: "session-a",
    });
    await watchModule.startWatch({
      id: "watch-reap-b",
      command: "status",
      intervalSecs: 60,
      mode: "fire_on_match",
      shellId: 2,
      cwd: null,
      sessionId: "session-b",
    });
    watchModule.reapSessionWatches("session-a");
    expect(watchModule.listWatches().map((w) => w.id)).toEqual(["watch-reap-b"]);
  });

  it("does not inject or retry after a watch is killed during its poll", async () => {
    const run = vi.mocked(native.shellSessionRun);
    let finish: ((value: Awaited<ReturnType<typeof native.shellSessionRun>>) => void) | undefined;
    run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const w = await watchModule.startWatch({
      id: "watch-kill-in-flight",
      command: "status",
      intervalSecs: 60,
      mode: "fire_on_match",
      shellId: 7,
      cwd: null,
      sessionId: "session-kill",
    });
    const polling = watchModule.pollWatchForTest(w);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(watchModule.stopWatchById(w.id)).toBe(true);
    finish?.({
      exit_code: 0,
      stdout: "late",
      stderr: "",
      timed_out: false,
      cancelled: false,
      truncated: false,
      cwd_after: "D:/",
    });
    await polling;
    expect(injectMessageMock).not.toHaveBeenCalled();
    expect(native.shellSessionCancel).toHaveBeenCalledWith(7);
    expect(native.shellSessionClose).toHaveBeenCalledWith(7);
  });

  it("does not execute a command when stopped while reopening its shell", async () => {
    const run = vi.mocked(native.shellSessionRun);
    const open = vi.mocked(native.shellSessionOpen);
    run.mockResolvedValueOnce({
      exit_code: null,
      stdout: "",
      stderr: "no shell session",
      timed_out: false,
      cancelled: false,
      truncated: false,
      cwd_after: "D:/one",
    });
    let finish: ((id: number) => void) | undefined;
    open.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const w = await watchModule.startWatch({
      id: "watch-kill-reopen",
      command: "status",
      intervalSecs: 60,
      mode: "fire_on_match",
      shellId: 9,
      cwd: "D:/one",
      sessionId: "session-reopen",
    });
    const polling = watchModule.pollWatchForTest(w);
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith("D:/one"));
    watchModule.stopWatchById(w.id);
    finish?.(10);
    await polling;
    expect(run).toHaveBeenCalledOnce();
    expect(native.shellSessionClose).toHaveBeenCalledWith(10);
    expect(injectMessageMock).not.toHaveBeenCalled();
  });

  it("retries identical output when its delivery fails", async () => {
    injectMessageMock.mockRejectedValueOnce(new Error("hydration failed"));
    const w = await watchModule.startWatch({
      id: "watch-delivery-retry",
      command: "status",
      intervalSecs: 60,
      mode: "fire_on_match",
      shellId: 1,
      cwd: null,
      sessionId: "session-delivery",
    });
    const result = { exit_code: 0, stdout: "ready", stderr: "", timed_out: false };
    await watchModule.handlePollResult(w, result);
    expect(watchModule.listWatches().find((item) => item.id === w.id)?.deliveryError)
      .toBe("hydration failed");
    await watchModule.handlePollResult(w, result);
    expect(injectMessageMock).toHaveBeenCalledTimes(2);
    expect(watchModule.listWatches().find((item) => item.id === w.id)?.deliveryError)
      .toBeNull();
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

describe("mid-run watch fires are passive (no queued self-initiated wake)", () => {
  // REGRESSION (user report): "it fires in the middle of my conversation and
  // messes everything up." A fire landing while the agent was streaming used
  // to queue a self-initiated wake that fired the moment the run settled —
  // interrupting the user's exchange with an unsolicited narrated response.
  // The pending-wake queue (pendingWatchWakes / queueWatchWake /
  // flushPendingWatchWakes / flushAllPendingWatchWakes) was REMOVED entirely:
  // mid-run fires now sit in history and ride the next request; only idle
  // fires wake inline.
  it("injectMessage does NOT queue a wake when the agent is mid-run", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../store/chatStore.ts", import.meta.url), "utf8"),
    );
    expect(src).not.toContain("pendingWatchWakes");
    expect(src).not.toContain("queueWatchWake");
    expect(src).not.toContain("flushPendingWatchWakes");
    expect(src).not.toContain("flushAllPendingWatchWakes");
    // And the passive branch exists with the idle wake intact.
    expect(src).toMatch(/hasPendingApprovals\(chat\)/);
    expect(src).toContain("chat.sendMessage()");
  });

  it("watch.ts no longer flushes the removed queue", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./watch.ts", import.meta.url), "utf8"),
    );
    expect(src).not.toContain("flushAllPendingWatchWakes");
    expect(src).not.toContain("flushPendingWatchWakes");
  });

  it("AgentRunBridge no longer flushes on settle", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../components/AgentRunBridge.tsx", import.meta.url),
        "utf8",
      ),
    );
    expect(src).not.toContain("flushPendingWatchWakes");
  });

  it("Set iteration DOES revisit a re-added item deleted then re-added mid-iteration", () => {
    // Engine semantics kept from the old freeze test (historical record): JS
    // for..of over a Set revisits an id deleted then re-added mid-iteration.
    // The queue is gone so nothing can trigger this shape anymore, but the
    // fact stays pinned in case a future queue reintroduces live iteration.
    const live = new Set(["a"]);
    const visited = [];
    let guard = 0;
    for (const id of live) {
      visited.push(id);
      live.delete(id);
      live.add(id);
      if (++guard > 50) break;
    }
    expect(visited.length).toBeGreaterThan(1);
    const snap = new Set(["a"]);
    const visited2 = [];
    for (const id of [...snap]) {
      visited2.push(id);
      snap.delete(id);
      snap.add(id);
    }
    expect(visited2).toEqual(["a"]);
  });
});

describe("match-mode replay dedup (chat scrolling duplicates / context fill)", () => {
  // REGRESSION (user report): a fire_on_match condition that keeps matching
  // on IDENTICAL output fired on EVERY poll — each firing injected a fresh
  // 2000-char stdout chunk and woke a full agent turn, so the chat scrolled
  // duplicate "Watch fired" blocks "like a replay" and the context filled.
  // Fix: identical fired-result → suppressed; changed output → fires;
  // a non-matching poll clears the dedup so flapping states re-fire.

  const mkWatch = () =>
    watchModule.startWatch({
      id: `watch_test_${Math.random().toString(36).slice(2, 8)}`,
      command: "Get-Status",
      intervalSecs: 5,
      mode: "fire_on_match",
      label: "status",
      shellId: 1,
      cwd: null,
      sessionId: "test-session",
    });

  beforeEach(() => {
    injectMessageMock.mockClear();
  });

  it("fires ONCE for a persistent condition on identical output", async () => {
    const w = await mkWatch();
    const same = { exit_code: 0, stdout: "STATUS: OK", stderr: "", timed_out: false };
    await watchModule.handlePollResult(w,same);
    await watchModule.handlePollResult(w,same);
    await watchModule.handlePollResult(w,same);
    expect(injectMessageMock).toHaveBeenCalledTimes(1);
  });

  it("re-fires when the output changes (log growth, new status lines)", async () => {
    const w = await mkWatch();
    await watchModule.handlePollResult(w,{ exit_code: 0, stdout: "STATUS: OK", stderr: "", timed_out: false });
    await watchModule.handlePollResult(w,{ exit_code: 0, stdout: "STATUS: OK\nNEW LINE", stderr: "", timed_out: false });
    expect(injectMessageMock).toHaveBeenCalledTimes(2);
  });

  it("clears the dedup when the condition stops matching — flapping states re-fire", async () => {
    const w = await mkWatch();
    w.condition = "exit_code !== 0";
    const down = { exit_code: 1, stdout: "STATUS: DOWN", stderr: "", timed_out: false };
    const ok = { exit_code: 0, stdout: "STATUS: OK", stderr: "", timed_out: false };
    // down → fires; recovers → no match, dedup cleared; down again → re-fires.
    await watchModule.handlePollResult(w,down);
    await watchModule.handlePollResult(w,ok);
    await watchModule.handlePollResult(w,down);
    expect(injectMessageMock).toHaveBeenCalledTimes(2);
  });

  it("fires once for a condition-less watch while output is unchanged", async () => {
    const w = await mkWatch();
    w.condition = undefined; // no condition = always true
    const same = { exit_code: 0, stdout: "tick", stderr: "", timed_out: false };
    await watchModule.handlePollResult(w,same);
    await watchModule.handlePollResult(w,same);
    expect(injectMessageMock).toHaveBeenCalledTimes(1);
  });

  it("survives the (stdout || \"\") coalesce style without bogus re-fires", async () => {
    // The field-report condition shape: `(stdout || "").includes(...)`.
    // stdout is always a string here, so coalescing must not perturb the
    // fired fingerprint between polls.
    const w = await mkWatch();
    w.condition = '((stdout || "")).includes("ALL_EVALS_DONE")';
    const res = { exit_code: 0, stdout: "… ALL_EVALS_DONE …", stderr: "", timed_out: false };
    await watchModule.handlePollResult(w,res);
    await watchModule.handlePollResult(w,res);
    expect(injectMessageMock).toHaveBeenCalledTimes(1);
  });
});

