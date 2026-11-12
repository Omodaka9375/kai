import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelMediaTasksForSession, spawnMediaTask } from "./task";

const resolveMedia = vi.fn();
vi.mock("../../store/chatStore", () => ({
  useChatStore: { getState: () => ({ resolveMedia }) },
}));

describe("background media task lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resolveMedia.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    cancelMediaTasksForSession("s");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("patches the real result into the originating tool call", async () => {
    spawnMediaTask("s", "call", async () => ({ type: "image", base64: "bytes" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveMedia).toHaveBeenCalledWith("s", "call", { type: "image", base64: "bytes" });
  });

  it("turns a provider rejection into a terminal visible error", async () => {
    spawnMediaTask("s", "call", async () => {
      throw new Error("Google rejected the request");
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveMedia).toHaveBeenCalledWith("s", "call", { error: "Google rejected the request" });
  });

  it("aborts a hung provider request at its deadline", async () => {
    spawnMediaTask("s", "call", () => new Promise(() => {}), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolveMedia).toHaveBeenCalledWith("s", "call", {
      error: "Generation timed out after 1 seconds.",
    });
  });

  it("session deletion cancels the job without patching a deleted chat", async () => {
    spawnMediaTask("s", "call", () => new Promise(() => {}));
    cancelMediaTasksForSession("s");
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveMedia).not.toHaveBeenCalled();
  });

  it("Stop surfaces a visible cancellation on the card", async () => {
    // Regression: the card used to spin forever after a stop because the
    // silent (deleted-session) path also swallowed user-initiated cancels.
    spawnMediaTask("s", "call", () => new Promise(() => {}));
    cancelMediaTasksForSession("s", "Generation cancelled before completion.");
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveMedia).toHaveBeenCalledWith("s", "call", {
      error: "Generation cancelled before completion.",
    });
  });

  it("outlives the agent run that spawned it", async () => {
    // THE reported bug: the job took the run's AbortSignal, which is aborted
    // as soon as any new run supersedes the current one — killing a
    // 3-minute image render seconds in, as "Generation cancelled before
    // completion.", with the card stuck on "generating".
    const controller = new AbortController();
    spawnMediaTask("s", "call", () =>
      new Promise((resolve) => setTimeout(() => resolve({ type: "image", base64: "ok" }), 5000)),
    );
    // The agent run is torn down: a new run replaces the controller.
    controller.abort();
    await vi.advanceTimersByTimeAsync(5000);
    expect(resolveMedia).toHaveBeenCalledWith("s", "call", { type: "image", base64: "ok" });
  });

  it("shares one provider request between retries of the same prompt", async () => {
    // "you are generating images in loop and I only wanted one": a model that
    // reads the placeholder as a failure re-calls with the same prompt.
    const run = vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ type: "image", base64: "one" }), 1000),
        ),
    );
    spawnMediaTask("s", "call-a", run, 10_000, "google:prompt");
    spawnMediaTask("s", "call-b", run, 10_000, "google:prompt");
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    // BOTH cards receive the result, so neither is left spinning.
    expect(resolveMedia).toHaveBeenCalledWith("s", "call-a", { type: "image", base64: "one" });
    expect(resolveMedia).toHaveBeenCalledWith("s", "call-b", { type: "image", base64: "one" });
  });

  it("reuses a completed result instead of generating the same image twice", async () => {
    const first = vi.fn(async () => ({ type: "image", base64: "cached" }));
    spawnMediaTask("s", "call-a", first, 10_000, "google:prompt");
    await vi.advanceTimersByTimeAsync(0);
    // The model retries AFTER the first card resolved.
    spawnMediaTask("s", "call-b", first, 10_000, "google:prompt");
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledTimes(1);
    expect(resolveMedia).toHaveBeenCalledWith("s", "call-b", { type: "image", base64: "cached" });
  });

  it("does not cache a failure: the retry really retries", async () => {
    const run = vi.fn(async () => {
      throw new Error("blocked");
    });
    spawnMediaTask("s", "call-a", run, 10_000, "google:prompt");
    await vi.advanceTimersByTimeAsync(0);
    spawnMediaTask("s", "call-b", run, 10_000, "google:prompt");
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps jobs with different prompts independent", async () => {
    const run = vi.fn(async () => ({ type: "image", base64: "x" }));
    spawnMediaTask("s", "call-a", run, 10_000, "google:one");
    spawnMediaTask("s", "call-b", run, 10_000, "google:two");
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not accept the run's abort signal at all (signature pin)", async () => {
    // No parameter position for a run signal: the job's lifetime is its own
    // timeout, never the agent turn's.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./task.ts", import.meta.url), "utf8"),
    );
    expect(src).toMatch(/export function spawnMediaTask\(\s*sessionId: string \| null,\s*toolCallId: string,\s*run: \(\) => Promise<unknown>,\s*timeoutMs/);
    expect(src).not.toMatch(/signal: AbortSignal \| undefined/);
  });
});
