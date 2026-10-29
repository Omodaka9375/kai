import { createContext, useContext } from "react";
import type { ProjectSwitcherItem } from "@/modules/workspace";

export type ProjectsMenu = {
  items: ProjectSwitcherItem[];
  addProject: (path?: string) => void;
  closeProject: (id: string) => void;
  switchProject: (id: string) => void;
  changeEnvironment: (id: string, env: import("@/modules/workspace").WorkspaceEnv, home: string | null) => void;
};

export const ProjectsMenuContext = createContext<ProjectsMenu | null>(null);
export function useProjectsMenu(): ProjectsMenu | null {
  return useContext(ProjectsMenuContext);
}
