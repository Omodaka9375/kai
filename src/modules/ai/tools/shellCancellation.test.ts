import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../lib/security", () => ({
  checkShellCommand: vi.fn(() => ({ ok: true })),
  powerShellFileSurgeryHint: vi.fn(() => null),
}));
vi.mock("../lib/sandbox", () => ({
  checkShellSandbox: vi.fn(async () => ({ ok: true })),
  sandboxExecRoot: vi.fn(async () => null),
}));
const { native } = vi.hoisted(() => ({
  native: {
    shellSessionOpen: vi.fn(),
    shellSessionRun: vi.fn(),
    shellSessionCancel: vi.fn(async () => undefined),
    shellSessionClose: vi.fn(async () => undefined),
  },
}));
vi.mock("../lib/native", () => ({ native }));

import { buildShellTools, cancelAllShellSessions } from "./shell";
import type { ToolContext } from "./context";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const okResult: Awaited<ReturnType<typeof native.shellSessionRun>> = {
  stdout: "ok",
  stderr: "",
  exit_code: 0,
  timed_out: false,
  cancelled: false,
  truncated: false,
  cwd_after: "D:/project",
};

function context(): ToolContext {
  return {
    getSessionId: () => "cancel-session",
    getCwd: () => "D:/project",
    workspaceEnv: { kind: "local" },
  } as ToolContext;
}

type Execute = (input: { command: string }, options: { abortSignal: AbortSignal }) => Promise<unknown>;

describe("bash_run cancellation and shell replacement", () => {
  beforeEach(() => {
    cancelAllShellSessions();
    native.shellSessionOpen.mockReset();
    native.shellSessionRun.mockReset();
    native.shellSessionCancel.mockClear();
    native.shellSessionClose.mockClear();
    vi.useRealTimers();
  });

  it("does not dispatch a command aborted while its shell was opening", async () => {
    const opening = deferred<number>();
    native.shellSessionOpen.mockReturnValue(opening.promise);
    const execute = buildShellTools(context()).bash_run.execute as unknown as Execute;
    const controller = new AbortController();
    const running = execute({ command: "Get-Location" }, { abortSignal: controller.signal });
    await vi.waitFor(() => expect(native.shellSessionOpen).toHaveBeenCalledOnce());
    controller.abort();
    opening.resolve(41);
    await expect(running).resolves.toMatchObject({ cancelled: true });
    expect(native.shellSessionRun).not.toHaveBeenCalled();
    expect(native.shellSessionCancel).toHaveBeenCalledWith(41);
  });

  it("drops aborted queued commands and closes the retired native shell", async () => {
    vi.useFakeTimers();
    native.shellSessionOpen.mockResolvedValue(42);
    const runningNative = deferred<typeof okResult>();
    native.shellSessionRun.mockReturnValue(runningNative.promise);
    const execute = buildShellTools(context()).bash_run.execute as unknown as Execute;
    const controller = new AbortController();
    const first = execute({ command: "pnpm verify" }, { abortSignal: controller.signal });
    const second = execute({ command: "pnpm test" }, { abortSignal: controller.signal });
    await vi.waitFor(() => expect(native.shellSessionRun).toHaveBeenCalledTimes(1));
    cancelAllShellSessions("cancel-session");
    controller.abort();
    await expect(second).resolves.toMatchObject({ error: expect.stringContaining("cancelled") });
    runningNative.resolve({ ...okResult, cancelled: true, exit_code: null });
    await first;
    expect(native.shellSessionRun).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(native.shellSessionClose).toHaveBeenCalledWith(42);
  });

  it("allows a later turn to replace an aborted native shell", async () => {
    native.shellSessionOpen.mockResolvedValueOnce(45).mockResolvedValueOnce(46);
    let abandonOldCommand = false;
    native.shellSessionRun.mockImplementation((id: number) =>
      id === 45 && !abandonOldCommand ? new Promise(() => {}) : Promise.resolve(okResult),
    );
    const execute = buildShellTools(context()).bash_run.execute as unknown as Execute;
    const first = new AbortController();
    const running = execute({ command: "pnpm verify" }, { abortSignal: first.signal });
    await vi.waitFor(() => expect(native.shellSessionRun).toHaveBeenCalledOnce());
    first.abort();
    // A late native cancellation normally abandons the previous call before
    // this next one; model the small intentional overlap of old and new.
    abandonOldCommand = true;
    await expect(execute({ command: "git diff --check" }, {
      abortSignal: new AbortController().signal,
    })).resolves.toMatchObject({ exit_code: 0 });
    await running;
    expect(native.shellSessionRun).toHaveBeenCalledWith(
      46, "git diff --check", "D:/project", undefined, null,
    );
  });

  it("runs a replacement shell even if the interrupted native call never settles", async () => {
    native.shellSessionOpen.mockResolvedValueOnce(43).mockResolvedValueOnce(44);
    native.shellSessionRun.mockImplementation((id: number) =>
      id === 43 ? new Promise(() => {}) : Promise.resolve(okResult),
    );
    const execute = buildShellTools(context()).bash_run.execute as unknown as Execute;
    const oldController = new AbortController();
    const oldRun = execute({ command: "pnpm verify" }, { abortSignal: oldController.signal });
    await vi.waitFor(() => expect(native.shellSessionRun).toHaveBeenCalledWith(
      43, "pnpm verify", "D:/project", undefined, null,
    ));
    cancelAllShellSessions("cancel-session");
    oldController.abort();
    await expect(oldRun).resolves.toMatchObject({ error: expect.stringContaining("cancelled") });
    const next = await execute({ command: "pnpm test" }, {
      abortSignal: new AbortController().signal,
    });
    expect(next).toMatchObject({ command: "pnpm test", exit_code: 0 });
    expect(native.shellSessionRun).toHaveBeenCalledWith(
      44, "pnpm test", "D:/project", 300, null,
    );
  });
});
