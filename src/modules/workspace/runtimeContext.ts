import { createContext, useContext } from "react";
import type { ProjectRuntime } from "./projectRuntime";

const ProjectRuntimeContext = createContext<ProjectRuntime | null>(null);
export const ProjectRuntimeProvider = ProjectRuntimeContext.Provider;

/** Present in project workspaces; null in global surfaces such as Settings. */
export function useProjectRuntime(): ProjectRuntime | null {
  return useContext(ProjectRuntimeContext);
}

export function requireProjectRuntime(): ProjectRuntime {
  const runtime = useProjectRuntime();
  if (!runtime) throw new Error("No active project runtime");
  return runtime;
}
