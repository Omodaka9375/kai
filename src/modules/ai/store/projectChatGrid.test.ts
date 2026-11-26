import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GRID_COLS,
  GRID_ROWS,
  GRID_CHAT_MAX,
  gridLayoutFor,
  useProjectChatGridStore,
} from "./projectChatGrid";

describe("project chat grid store", () => {
  beforeEach(() => {
    useProjectChatGridStore.getState().setOpen(false);
  });

  it("defaults to closed", () => {
    expect(useProjectChatGridStore.getState().open).toBe(false);
  });

  it("setOpen and toggle flip the flag", () => {
    useProjectChatGridStore.getState().setOpen(true);
    expect(useProjectChatGridStore.getState().open).toBe(true);
    useProjectChatGridStore.getState().toggle();
    expect(useProjectChatGridStore.getState().open).toBe(false);
    useProjectChatGridStore.getState().toggle();
    expect(useProjectChatGridStore.getState().open).toBe(true);
  });

  it("subscribers are notified on toggle", () => {
    const listener = vi.fn();
    const unsub = useProjectChatGridStore.subscribe(listener);
    useProjectChatGridStore.getState().toggle();
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    useProjectChatGridStore.getState().setOpen(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("default tier stays 2 rows x 4 columns and the absolute cap is 24", () => {
    expect(GRID_ROWS).toBe(2);
    expect(GRID_COLS).toBe(4);
    expect(GRID_CHAT_MAX).toBe(24);
  });

  it("gridLayoutFor maps every count to a tier whose capacity covers it (up to the cap)", () => {
    expect(gridLayoutFor(1)).toEqual({ rows: 1, cols: 1 });
    expect(gridLayoutFor(2)).toEqual({ rows: 1, cols: 2 });
    for (let n = 3; n <= 8; n++) {
      expect(gridLayoutFor(n)).toEqual({ rows: 2, cols: 4 });
    }
    for (let n = 9; n <= 24; n++) {
      expect(gridLayoutFor(n)).toEqual({ rows: 3, cols: 8 });
    }
    // Past the cap the layout stays 3x8 — the component caps cells and
    // shows the overflow notice instead of growing or scrolling.
    expect(gridLayoutFor(30)).toEqual({ rows: 3, cols: 8 });
    // Zero/negative counts never produce a degenerate grid.
    expect(gridLayoutFor(0)).toEqual({ rows: 1, cols: 1 });
    expect(gridLayoutFor(-3)).toEqual({ rows: 1, cols: 1 });
  });
});
