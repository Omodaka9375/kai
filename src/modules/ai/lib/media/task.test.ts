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
    spawnMediaTask("s", "call", undefined, async () => ({ type: "image", base64: "bytes" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveMedia).toHaveBeenCalledWith("s", "call", { type: "image", base64: "bytes" });
  });

  it("turns a provider rejection into a terminal visible error", async () => {
    spawnMediaTask("s", "call", undefined, async () => { throw new Error("Google rejected the request"); });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveMedia).toHaveBeenCalledWith("s", "call", { error: "Google rejected the request" });
  });

  it("aborts a hung provider request at its deadline", async () => {
    spawnMediaTask("s", "call", undefined, () => new Promise(() => {}), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolveMedia).toHaveBeenCalledWith("s", "call", {
      error: "Generation timed out after 1 seconds.",
    });
  });

  it("session deletion cancels the job without recreating deleted chat state", async () => {
    spawnMediaTask("s", "call", undefined, () => new Promise(() => {}));
    cancelMediaTasksForSession("s");
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveMedia).not.toHaveBeenCalled();
  });

  it("an agent-stop abort reports the job as cancelled", async () => {
    const controller = new AbortController();
    spawnMediaTask("s", "call", controller.signal, () => new Promise(() => {}));
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveMedia).toHaveBeenCalledWith("s", "call", {
      error: "Generation cancelled before completion.",
    });
  });
});
