import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GRID_COLS,
  GRID_ROWS,
  GRID_CHAT_MAX,
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

  it("grid geometry is fixed 2 rows x 4 columns (8 cells, no scroll)", () => {
    expect(GRID_ROWS).toBe(2);
    expect(GRID_COLS).toBe(4);
    expect(GRID_CHAT_MAX).toBe(8);
  });
});
