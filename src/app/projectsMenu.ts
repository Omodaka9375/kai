import { createContext, useContext } from "react";
import type { ProjectSwitcherItem } from "@/modules/workspace";

export type ProjectsMenu = {
  items: ProjectSwitcherItem[];
  sessions: import("@/modules/ai/lib/sessions").SessionMeta[];
  addProject: (path?: string) => void | Promise<void>;
  closeProject: (id: string) => void;
  switchProject: (id: string) => void;
  switchSession: (projectId: string, sessionId: string) => void;
  newSession: (projectId: string) => void;
  archiveSession: (sessionId: string) => void;
  restoreSession: (projectId: string, sessionId: string) => void;
  changeEnvironment: (id: string, env: import("@/modules/workspace").WorkspaceEnv, home: string | null) => void;
};

export const ProjectsMenuContext = createContext<ProjectsMenu | null>(null);
export function useProjectsMenu(): ProjectsMenu | null {
  return useContext(ProjectsMenuContext);
}
