import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "./chatStore";
import {
  __projectLayoutForTest,
  flushProjectLayouts,
  getProjectLayout,
  patchProjectLayout,
} from "@/modules/workspace/projectLayout";

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

function restore(projectId: string): void {
  const aiWindow = getProjectLayout(projectId).aiWindow;
  useChatStore.setState({
    mini: { open: aiWindow.open, expanded: aiWindow.expanded },
    panelOpen: aiWindow.panelOpen,
  });
}

describe("per-project AI window state", () => {
  beforeEach(async () => {
    __projectLayoutForTest.clear();
    await flushProjectLayouts();
    useChatStore.setState({
      mini: { open: false, expanded: false },
      panelOpen: false,
    });
  });

  it("restores expanded, minimized and closed states across A→B→A", () => {
    patchProjectLayout("local:a", {
      aiWindow: { open: true, expanded: true, panelOpen: true },
    });
    restore("local:a");
    expect(useChatStore.getState().mini.expanded).toBe(true);

    patchProjectLayout("local:b", {
      aiWindow: { open: false, expanded: false, panelOpen: true },
    });
    restore("local:b");
    expect(useChatStore.getState()).toMatchObject({
      mini: { open: false, expanded: false },
      panelOpen: true,
    });

    restore("local:a");
    expect(useChatStore.getState()).toMatchObject({
      mini: { open: true, expanded: true },
      panelOpen: true,
    });

    patchProjectLayout("local:b", {
      aiWindow: { open: false, expanded: false, panelOpen: false },
    });
    restore("local:b");
    expect(useChatStore.getState().panelOpen).toBe(false);
    expect(getProjectLayout("local:a").aiWindow.open).toBe(true);
  });
});
