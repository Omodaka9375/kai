import { create } from "zustand";

/**
 * Project chat grid state (2026-11-18).
 *
 * A 2x4 overview surface: every OPEN project gets one live chat cell
 * (mini-window body, no top bar) with a working input and the shared mic.
 * The grid lives in its own store so the Header toggle (App-level) and the
 * ProjectChatGrid component (AppShell-level, above the per-project
 * workspaces) can share the flag without a new prop-drilling chain.
 *
 * GRID_CHAT_MAX (8): fixed 2 rows x 4 columns, no scroll. Open projects
 * beyond the 8th simply have no cell (the rail remains the full list).
 */
export const GRID_ROWS = 2;
export const GRID_COLS = 4;
export const GRID_CHAT_MAX = GRID_ROWS * GRID_COLS;

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
