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

/**
 * WORKSPACE ACTIVATION CONTEXT (2026-11-02 switch-lag fix, round 2).
 *
 * The user report: "switching is much better now, but still lags when
 * switching between two projects where agents are actively thinking or
 * writing." Root cause: `isActive` was a PROP on the memoized
 * ProjectWorkspace — memo cannot skip the TWO workspaces whose prop
 * flips, so every switch fully reconciled BOTH workspace trees (header,
 * explorer, stacks, panels), and with active streams those trees are
 * large and being pumped by token flushes that repeatedly interrupt the
 * startTransition.
 *
 * Now activation rides this CONTEXT instead. AppShell flips the provider
 * value; only the components that actually NEED activation re-render
 * (the small gate components in App.tsx, TerminalStack/PreviewStack for
 * their per-tab visibility classes). ProjectWorkspace itself never
 * re-renders on a switch.
 *
 * Default true so standalone surfaces (single-project tests, previews)
 * behave as active.
 */
const WorkspaceActiveContext = createContext(true);
export const WorkspaceActiveProvider = WorkspaceActiveContext.Provider;

/** True when THIS workspace is the foreground project. Subscribe ONLY
 *  from small gate/leaf components — subscribing from a large component
 *  re-renders its whole subtree on every project switch (the exact cost
 *  this context exists to remove). */
export function useWorkspaceActive(): boolean {
  return useContext(WorkspaceActiveContext);
}
