import { createContext, useContext } from "react";
import type { ProjectSwitcherItem } from "@/modules/workspace";

export type ProjectsMenu = {
  /** Snapshot of the rail items, read at EVENT time — consumers of this
   *  context never re-render when statuses change (2026-11-02
   *  switch-freeze fix: items used to ride this context, so every agent
   *  status bump re-rendered every workspace that consumed the menu). */
  getItems: () => ProjectSwitcherItem[];
  addProject: (path?: string) => void | Promise<void>;
  /** Create a NEW project folder (save-style dialog), then open it in the
   *  rail via the same path as addProject. */
  newProject: () => void | Promise<void>;
  closeProject: (id: string) => void;
  switchProject: (id: string) => void;
  /** MANUAL RAIL ORDER (2026-11-02): move the dragged project to the
   *  hovered project's position in the rail. The `projects` array IS the
   *  display order and persists as the roots order in kai-open-projects.json,
   *  so a reorder survives restarts with no extra storage. */
  moveProject: (dragId: string, overId: string) => void;
  changeEnvironment: (id: string, env: import("@/modules/workspace").WorkspaceEnv, home: string | null) => void;
};

export const ProjectsMenuContext = createContext<ProjectsMenu | null>(null);
export function useProjectsMenu(): ProjectsMenu | null {
  return useContext(ProjectsMenuContext);
}

/** Live rail items. Consumed ONLY by components that render item DATA
 *  (ProjectRail, StatusBar): a status transition re-renders those, never
 *  the memoized workspaces. */
export const ProjectRailItemsContext = createContext<ProjectSwitcherItem[]>([]);
export function useProjectRailItems(): ProjectSwitcherItem[] {
  return useContext(ProjectRailItemsContext);
}
