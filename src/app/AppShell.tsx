import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getLaunchDir } from "@/lib/launchDir";
import { useChatStore } from "@/modules/ai";
import { projectIdForSession, setActiveProjectRuntime, setProjectActiveSession, subscribeSessionAgentMeta } from "@/modules/ai/store/chatStore";
import { hydrateSessionPreferences, setSessionPreferences, subscribeSessionPreferences } from "@/modules/ai/store/sessionPreferences";
import { getProjectAgentStatus, subscribeProjectAgentStatus } from "@/modules/ai/store/projectStatus";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  createProjectRuntime,
  LOCAL_WORKSPACE,
  ProjectRuntimeProvider,
  type ProjectRuntime,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { ProjectWorkspace } from "./App";
import { ProjectsMenuContext } from "./projectsMenu";
import { LazyStore } from "@tauri-apps/plugin-store";

const openProjectsStore = new LazyStore("kai-open-projects.json", { defaults: {}, autoSave: 200 });

/** App-level owner of retained project workspaces. Project switches are
 * visibility changes, NOT destructive `resetWorkspace` calls: terminals,
 * editors, previews, and agents keep running in the owning workspace. */
export default function App() {
  const [projects, setProjects] = useState<ProjectRuntime[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [statusVersion, setStatusVersion] = useState(0);
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);

  useEffect(() => subscribeProjectAgentStatus(() => setStatusVersion((v) => v + 1)), []);
  useEffect(() => { void hydrateSessionPreferences(); }, []);
  useEffect(() => subscribeSessionAgentMeta(() => setStatusVersion((v) => v + 1)), []);
  useEffect(() => subscribeSessionPreferences(() => setStatusVersion((v) => v + 1)), []);

  useEffect(() => {
    void (async () => {
      const launch = getLaunchDir();
      await usePreferencesStore.getState().init().catch(() => undefined);
      const prefs = usePreferencesStore.getState();
      const home = await homeDir().then((p) => p.replace(/\\/g, "/")).catch(() => "");
      const saved = await openProjectsStore.get<{
        roots?: Array<string | { root: string; env: WorkspaceEnv }>;
        activeId?: string;
      }>("workspaces").catch(() => null);
      const savedProjects = (saved?.roots ?? []).map((entry) =>
        typeof entry === "string" ? { root: entry, env: LOCAL_WORKSPACE } : entry,
      );
      const roots = [
        launch ? { root: launch, env: LOCAL_WORKSPACE } : null,
        ...savedProjects,
        ...(savedProjects.length ? [] : [
          { root: prefs.lastWorkspaceCwd ?? "", env: LOCAL_WORKSPACE },
          ...prefs.recentProjects.slice(0, 1).map((root) => ({ root, env: LOCAL_WORKSPACE })),
        ]),
      ].filter((entry): entry is { root: string; env: WorkspaceEnv } => Boolean(entry?.root));
      const seen = new Set<string>();
      const initial: ProjectRuntime[] = [];
      for (const { root, env } of roots) {
        const runtime = createProjectRuntime(root, env);
        if (seen.has(runtime.id)) continue;
        seen.add(runtime.id);
        initial.push(runtime);
      }
      if (initial.length === 0) initial.push(createProjectRuntime(home));
      setProjects(initial);
      setActiveId(
        launch
          ? initial[0]!.id
          : saved?.activeId && initial.some((p) => p.id === saved.activeId)
            ? saved.activeId
            : initial[0]!.id,
      );
      setReady(true);
    })();
  }, []);

  const addProject = useCallback(async (requestedPath?: string) => {
    try {
      const selected = requestedPath ?? await invoke<string | null>("pick_project_folder");
      if (!selected) return;
      const runtime = createProjectRuntime(selected, LOCAL_WORKSPACE);
      setProjects((current) => current.some((p) => p.id === runtime.id) ? current : [...current, runtime]);
      setActiveId(runtime.id);
    } catch (error) {
      console.error("Open project failed:", error);
    }
  }, []);

  const changeEnvironment = useCallback((id: string, env: WorkspaceEnv, home: string | null) => {
    const source = projects.find((project) => project.id === id);
    if (!source) return;
    const next = createProjectRuntime(home ?? source.root, env);
    const existing = projects.find((project) => project.id === next.id && project.id !== id);
    if (existing) {
      // The target workspace is already open: switch to it instead of
      // creating duplicate React keys and duplicate agent runtimes.
      if (id === activeId) setActiveId(existing.id);
      return;
    }
    setProjects((current) => current.map((project) => project.id === id ? next : project));
    if (activeId === id) setActiveId(next.id);
  }, [activeId, projects]);

  const switchSession = useCallback((projectId: string, sessionId: string) => {
    setProjectActiveSession(projectId, sessionId);
    setSessionPreferences(sessionId, { projectId });
    if (projectId !== activeId) {
      setActiveId(projectId);
      return;
    }
    const project = projects.find((item) => item.id === projectId);
    if (project) setActiveProjectRuntime(project);
    useChatStore.getState().switchSession(sessionId);
  }, [activeId, projects]);

  const newSession = useCallback((projectId: string) => {
    const project = projects.find((item) => item.id === projectId);
    if (project) setActiveProjectRuntime(project);
    if (projectId !== activeId) setActiveId(projectId);
    useChatStore.getState().newSession();
  }, [activeId, projects]);

  const restoreSession = useCallback((projectId: string, sessionId: string) => {
    setProjectActiveSession(projectId, sessionId);
    if (projectId !== activeId) {
      setActiveId(projectId);
      return;
    }
    const project = projects.find((item) => item.id === projectId);
    if (project) setActiveProjectRuntime(project);
    useChatStore.getState().restoreSession(sessionId);
  }, [activeId, projects]);

  const closeProject = useCallback((id: string) => {
    const project = projects.find((p) => p.id === id);
    if (!project) return;
    const running = getProjectAgentStatus(id) !== "idle";
    const detail = running ? " Its running agents and terminals will be stopped." : "";
    if (!window.confirm(`Close ${project.root}?${detail}`)) return;
    // Unmounting the retained workspace triggers its own project-scoped
    // terminal/session cleanup; never use the foreground session here.
    setProjects((current) => current.filter((p) => p.id !== id));
    if (activeId === id) {
      const remaining = projects.filter((p) => p.id !== id);
      setActiveId(remaining[0]?.id ?? null);
    }
  }, [activeId, projects]);

  const items = useMemo(() => projects.map((project) => ({
    id: project.id,
    root: project.root,
    name: project.root.split(/[\\/]/).filter(Boolean).pop() ?? project.root,
    status: (() => {
      const status = getProjectAgentStatus(project.id);
      return status === "awaiting-approval" ? "awaiting" as const
        : status === "error" ? "error" as const
        : status === "idle" ? "idle" as const
        : "running" as const;
    })(),
    active: project.id === activeId,
  })), [projects, activeId, sessions, activeSessionId, statusVersion]);

  useEffect(() => {
    if (!ready) return;
    void openProjectsStore.set("workspaces", {
      roots: projects.map((p) => ({ root: p.root, env: p.env })),
      activeId,
    });
  }, [projects, activeId, ready]);

  if (!ready) return null;
  return (
    <ProjectsMenuContext.Provider value={{
      items,
      sessions,
      addProject,
      closeProject,
      switchProject: setActiveId,
      switchSession,
      newSession,
      archiveSession: (id) => {
        const owner = sessions.find((session) => session.id === id);
        if (owner) setSessionPreferences(id, { projectId: projectIdForSession(id) ?? undefined });
        useChatStore.getState().archiveSession(id);
      },
      restoreSession,
      changeEnvironment,
    }}>
      <div className="relative h-screen w-full">
        {projects.map((project) => (
          <div key={project.id} className="absolute inset-0">
            <ProjectRuntimeProvider value={project}>
              <ProjectWorkspace isActive={project.id === activeId} />
            </ProjectRuntimeProvider>
          </div>
        ))}
        {activeId === null ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No projects open.
            <button type="button" className="ml-2 underline" onClick={() => void addProject()}>Open project</button>
          </div>
        ) : null}
      </div>
    </ProjectsMenuContext.Provider>
  );
}


