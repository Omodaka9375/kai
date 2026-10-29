import { beforeEach, describe, expect, it, vi } from "vitest";

const writes = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue({}),
    set: writes,
    save: vi.fn(),
  })),
}));

import {
  getSessionPreferences,
  setSessionPreferences,
  subscribeSessionPreferences,
} from "./sessionPreferences";

describe("per-session agent preferences", () => {
  beforeEach(() => {
    setSessionPreferences("a", { projectId: "local:a" });
    setSessionPreferences("b", { projectId: "local:b" });
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
