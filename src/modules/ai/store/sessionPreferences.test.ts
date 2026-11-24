import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writes = vi.hoisted(() => vi.fn());
const entriesMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue({}),
    set: writes,
    entries: entriesMock,
    save: vi.fn(),
  })),
}));

import {
  getSessionPreferences,
  removeSessionPreferences,
  setSessionPreferences,
  subscribeSessionPreferences,
} from "./sessionPreferences";

describe("per-session agent preferences", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    writes.mockClear();
    setSessionPreferences("a", { projectId: "local:a" });
    setSessionPreferences("b", { projectId: "local:b" });
    vi.runAllTimers();
    writes.mockClear();
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it("keeps model and persona overrides isolated by session", () => {
    setSessionPreferences("a", { modelId: "openai/gpt-5.5", personaId: "reviewer" });
    expect(getSessionPreferences("a").modelId).toBe("openai/gpt-5.5");
    expect(getSessionPreferences("b").modelId).toBeUndefined();
    expect(getSessionPreferences("b").personaId).toBeUndefined();
  });

  it("persists drafts separately and clears empty optional values", () => {
    setSessionPreferences("a", { draft: "unfinished A" });
    setSessionPreferences("b", { draft: "unfinished B" });
    expect(getSessionPreferences("a").draft).toBe("unfinished A");
    setSessionPreferences("a", { draft: undefined });
    expect(getSessionPreferences("a").draft).toBeUndefined();
    expect(getSessionPreferences("b").draft).toBe("unfinished B");
  });

  it("writes only the changed session's pref:<id> key on debounce (no full-map rewrite)", () => {
    setSessionPreferences("a", { draft: "hello" });
    setSessionPreferences("a", { draft: "hello world" });
    // Debounced: no immediate store write during typing bursts.
    expect(writes).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    // Exactly one per-session write for "a", never the full legacy "sessions" map.
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledWith("pref:a", expect.objectContaining({ draft: "hello world" }));
    expect(writes).not.toHaveBeenCalledWith("sessions", expect.anything());
  });

  it("writes an empty tombstone when a session's preferences are removed", () => {
    removeSessionPreferences("b");
    vi.advanceTimersByTime(300);
    expect(writes).toHaveBeenCalledWith("pref:b", {});
  });

  it("archive is a reversible view state and notifies listeners", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionPreferences(listener);
    setSessionPreferences("a", { archivedAt: 42 });
    expect(getSessionPreferences("a").archivedAt).toBe(42);
    setSessionPreferences("a", { archivedAt: undefined });
    expect(getSessionPreferences("a").archivedAt).toBeUndefined();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});
