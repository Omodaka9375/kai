import { create } from "zustand";

/**
 * Project chat grid state (2026-11-18).
 *
 * An overview surface: every OPEN project gets one live chat cell
 * (mini-window body, no top bar) with a working input and the shared mic.
 * The grid lives in its own store so the Header toggle (App-level) and the
 * ProjectChatGrid component (AppShell-level, above the per-project
 * workspaces) can share the flag without a new prop-drilling chain.
 *
 * ADAPTIVE LAYOUT (2026-11-26): the grid shape follows the number of OPEN
 * projects instead of a fixed 2x4 with holes. gridLayoutFor maps the count
 * to a tier; GRID_CHAT_MAX (24 = 3 rows x 8 columns) is the absolute cap.
 * Projects beyond the cap get no cell (the rail remains the full list) and
 * the grid shows a "close one to make room" notice — never a crash and
 * never a scroll region.
 *
 * GRID_ROWS/GRID_COLS remain the DEFAULT tier (3-8 projects) so existing
 * pins and the persisted gridOrder row-major semantics stay stable.
 */
export const GRID_ROWS = 2;
export const GRID_COLS = 4;
/** Absolute cap on Workspaces cells: the 3x8 tier. */
export const GRID_CHAT_MAX = 24;

export type GridLayout = { rows: number; cols: number };

/** Grid tier per open-project count (capacity always >= count up to the cap):
 *   1        -> 1x1 (single full-size card)
 *   2        -> 1x2 (50/50 split)
 *   3..8     -> 2x4 (the long-standing default)
 *   9..24    -> 3x8 (dense overview)
 * Anything past 24 keeps the 3x8 shape; the component caps `cells` and
 * surfaces a "close a project" notice instead of growing or scrolling. */
export function gridLayoutFor(projectCount: number): GridLayout {
  if (projectCount <= 1) return { rows: 1, cols: 1 };
  if (projectCount === 2) return { rows: 1, cols: 2 };
  if (projectCount <= GRID_ROWS * GRID_COLS) return { rows: GRID_ROWS, cols: GRID_COLS };
  return { rows: 3, cols: 8 };
}

type ProjectChatGridState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
};

export const useProjectChatGridStore = create<ProjectChatGridState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
