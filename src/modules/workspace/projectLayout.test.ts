import { beforeEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MIN } from "@/modules/settings/store";
import {
  DEFAULT_PROJECT_LAYOUT,
  __projectLayoutForTest,
  flushProjectLayouts,
  getProjectLayout,
  hydrateProjectLayouts,
  patchProjectLayout,
} from "./projectLayout";

const { storeGet, storeSet, storeSave } = vi.hoisted(() => ({
  storeGet: vi.fn(),
  storeSet: vi.fn(async (_key: string, _value: unknown) => {}),
  storeSave: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    get = storeGet;
    set = storeSet;
    save = storeSave;
  },
}));

describe("per-project workspace layout", () => {
  beforeEach(async () => {
    __projectLayoutForTest.clear();
    await flushProjectLayouts();
    storeGet.mockReset();
    storeSet.mockClear();
    storeSave.mockClear();
  });

  it("opens the default sidebar one pixel above its collapse threshold", () => {
    expect(SIDEBAR_WIDTH_DEFAULT).toBe(201);
    expect(SIDEBAR_WIDTH_DEFAULT).toBe(SIDEBAR_WIDTH_MIN + 1);
  });

  it("keeps width, collapse and AI state independent for each project", () => {
    patchProjectLayout("local:a", {
      sidebar: { width: 237, collapsed: true },
      aiWindow: { open: false, panelOpen: true, expanded: true },
    });
    patchProjectLayout("local:b", {
      sidebar: { width: 310, collapsed: false },
      aiWindow: { open: true, panelOpen: true, expanded: false },
    });
    expect(getProjectLayout("local:a")).toMatchObject({
      sidebar: { width: 237, collapsed: true },
      aiWindow: { open: false, panelOpen: true, expanded: true },
    });
    expect(getProjectLayout("local:b")).toMatchObject({
      sidebar: { width: 310, collapsed: false },
      aiWindow: { open: true, panelOpen: true, expanded: false },
    });
    // Minimized is distinct from fully closed; expanded is restored with it.
    expect(getProjectLayout("local:a").aiWindow.panelOpen).toBe(true);
    expect(getProjectLayout("local:a").aiWindow.open).toBe(false);
  });

  it("uses the compact default for a project with no saved record", () => {
    expect(getProjectLayout("local:new")).toEqual(DEFAULT_PROJECT_LAYOUT);
  });

  it("flushes pending changes and restores them after a restart", async () => {
    patchProjectLayout("wsl:ubuntu:/work/a", {
      sidebar: { width: 222, collapsed: true },
      aiWindow: { open: true, panelOpen: true, expanded: true },
    });
    await flushProjectLayouts();
    expect(storeSet).toHaveBeenCalledWith("layouts", {
      "wsl:ubuntu:/work/a": getProjectLayout("wsl:ubuntu:/work/a"),
    });
    const saved = storeSet.mock.calls[storeSet.mock.calls.length - 1]?.[1] as unknown;
    __projectLayoutForTest.clear();
    storeGet.mockResolvedValue(saved);
    await hydrateProjectLayouts();
    expect(getProjectLayout("wsl:ubuntu:/work/a").aiWindow).toMatchObject({
      open: true, panelOpen: true, expanded: true,
    });
    expect(getProjectLayout("wsl:ubuntu:/work/a").sidebar.collapsed).toBe(true);
  });

  it("clamps sidebar geometry and ignores malformed records", async () => {
    storeGet.mockResolvedValue({
      "local:good": {
        sidebar: { width: 99999, collapsed: true },
        aiWindow: { open: true, expanded: true },
      },
      "local:bad": { sidebar: "wide" },
    });
    await hydrateProjectLayouts();
    expect(getProjectLayout("local:good").sidebar.width).toBe(480);
    expect(getProjectLayout("local:good").aiWindow).toMatchObject({
      open: true, expanded: true,
    });
    expect(getProjectLayout("local:bad")).toEqual(DEFAULT_PROJECT_LAYOUT);
  });
});
