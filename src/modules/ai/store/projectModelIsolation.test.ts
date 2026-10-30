import { describe, expect, it, beforeEach } from "vitest";
import {
  getProjectModel,
  setActiveProjectRuntime,
  setProjectModel,
  useChatStore,
} from "./chatStore";
import {
  createProjectRuntime,
} from "@/modules/workspace/projectRuntime";
import { LOCAL_WORKSPACE } from "@/modules/workspace/env";
import type { ProjectRuntime } from "@/modules/workspace/projectRuntime";
import { vi } from "vitest";

/**
 * Per-project model isolation (user invariant): switching projects must
 * never change either project's model. The live-session bleed was real —
 * the restore path in App.tsx used to call setSelectedModelId, whose
 * persistProjectModel wrote to live.getWorkspaceRoot(); during a switch
 * that still points at the OUTGOING project (the incoming setLive runs
 * later in the live-bridge effect), so project A's persisted model got
 * overwritten with B's selection.
 *
 * These tests pin the STORE-LEVEL pieces the App effect relies on:
 *   1. projectModels is keyed per project id — activating B and capturing
 *      B's model never touches A's capture.
 *   2. setSelectedModelId mirrors into the ACTIVE project only — a pick
 *      while B is visible stamps B, never A.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
  })),
}));

function runtimeAt(root: string): ProjectRuntime {
  return createProjectRuntime(root, LOCAL_WORKSPACE);
}

describe("per-project model isolation across project switches", () => {
  beforeEach(() => {
    useChatStore.setState({
      activeSessionId: null,
      selectedModelId: "gpt-5.5",
    });
  });

  it("activating B and capturing B's model leaves A's capture untouched (A→B core)", () => {
    const a = runtimeAt("D:/Code/project-a");
    const b = runtimeAt("D:/Code/project-b");
    setProjectModel(a.id, "gpt-5.5", "p1");
    // Switch: activate B, capture B's own model.
    setActiveProjectRuntime(b);
    setProjectModel(b.id, "claude-sonnet-5", "p1");
    expect(getProjectModel(a.id)).toBe("gpt-5.5");
    expect(getProjectModel(b.id)).toBe("claude-sonnet-5");
  });

  it("a model pick while B is active stamps only B's capture", () => {
    const a = runtimeAt("D:/Code/project-a");
    const b = runtimeAt("D:/Code/project-b");
    setActiveProjectRuntime(a);
    setProjectModel(a.id, "gpt-5.5", "p1");
    // A→B switch.
    setActiveProjectRuntime(b);
    setProjectModel(b.id, "claude-sonnet-5", "p1");
    // The user picks a new model while B is visible.
    useChatStore.getState().setSelectedModelId("gemini-2.5-pro");
    expect(getProjectModel(b.id)).toBe("gemini-2.5-pro");
    expect(getProjectModel(a.id)).toBe("gpt-5.5");
    expect(useChatStore.getState().selectedModelId).toBe("gemini-2.5-pro");
  });

  it("A→B→A round trip restores A's model in the global selection", () => {
    const a = runtimeAt("D:/Code/project-a");
    const b = runtimeAt("D:/Code/project-b");
    setActiveProjectRuntime(a);
    setProjectModel(a.id, "gpt-5.5", "p1");
    useChatStore.setState({ selectedModelId: "gpt-5.5" });
    // A→B.
    setActiveProjectRuntime(b);
    setProjectModel(b.id, "claude-sonnet-5", "p1");
    useChatStore.setState({ selectedModelId: "claude-sonnet-5" });
    // B→A: the App restore effect does setActiveProjectRuntime + direct
    // setState(selectedModelId) — simulate exactly that.
    setActiveProjectRuntime(a);
    useChatStore.setState({ selectedModelId: getProjectModel(a.id) });
    expect(useChatStore.getState().selectedModelId).toBe("gpt-5.5");
    expect(getProjectModel(b.id)).toBe("claude-sonnet-5");
  });
});
