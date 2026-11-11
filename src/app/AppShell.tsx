import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getLaunchDir } from "@/lib/launchDir";
import { cn } from "@/lib/utils";
import { hydrateSessionPreferences } from "@/modules/ai/store/sessionPreferences";
import {
  getProjectAgentStatus,
  getProjectHasNews,
  setProjectHasNews,
  subscribeProjectAgentStatus,
} from "@/modules/ai/store/projectStatus";
import { hydrateGroups, removeProjectFromGroups } from "@/modules/ai/store/groupChatStore";
import { GroupChatPanel } from "@/modules/ai/components/GroupChatPanelView";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  createProjectRuntime,
  LOCAL_WORKSPACE,
  ProjectRuntimeProvider,
  WorkspaceActiveProvider,
  type ProjectRuntime,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { ProjectWorkspace } from "./App";
import { ProjectRailItemsContext, ProjectsMenuContext } from "./projectsMenu";
import { LazyStore } from "@tauri-apps/plugin-store";
import { Spinner } from "@/components/ui/spinner";

const openProjectsStore = new LazyStore("kai-open-projects.json", { defaults: {}, autoSave: 200 });

/** Canonical key for project icon overrides: forward slashes, no trailing
 * slashes - the same normalization createProjectRuntime applies to roots. */
function projectIconOverrideKey(root: string): string {
  return root.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Race a boot-critical promise with a timeout + rejection guard so a wedged
 * IPC call can never wedge the WHOLE boot: on failure or timeout, log loudly
 * (the console bridge forwards into kai-<pid>.log) and continue with the
 * fallback. main.tsx's pre-render race covers the same wedge class for
 * ReactDOM.render; this covers AppShell's ready gate — before this, a single
 * hung await left a permanently blank, themed window with zero diagnostics. */
async function bootAwait<T>(
  p: Promise<T>,
  fallback: () => T,
  label: string,
  ms = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = p.then(
    (value) => value,
    (err) => {
      console.error(`[boot] ${label} failed:`, err);
      return fallback();
    },
  );
  const timed = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[boot] ${label} stuck for ${ms}ms - continuing with fallback (IPC wedged?)`);
      resolve(fallback());
    }, ms);
  });
  try {
    return await Promise.race([guarded, timed]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** App-level owner of retained project workspaces. Project switches are
 * visibility changes, NOT destructive `resetWorkspace` calls: terminals,
 * editors, previews, and agents keep running in the owning workspace. */
export default function App() {
  const [projects, setProjects] = useState<ProjectRuntime[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Project icon/color customizations (2026-11-11), keyed by canonical root
  // so they survive env switches and close/reopen. Persisted under the
  // "projectIcons" key of kai-open-projects.json, independent of the roots
  // list so closing a project never loses its customization.
  const [projectIconOverrides, setProjectIconOverrides] = useState<
    Record<string, { icon?: string; color?: string }>
  >({});
  const [ready, setReady] = useState(false);
  const [statusVersion, setStatusVersion] = useState(0);
  /** Human-readable boot phase - rendered by the pre-ready placeholder so a
   * stuck boot is diagnosable from the window itself, no devtools needed. */
  const [bootStep, setBootStep] = useState("starting");
  /** Pending close confirmation (rail X) - null when none. */
  const [closeConfirm, setCloseConfirm] = useState<{
    id: string;
    name: string;
    root: string;
    running: boolean;
  } | null>(null);
  // RAIL STATUS VERSION (2026-11-02 switch-freeze fix): ONE subscription
  // bumps this version — projectStatus transitions (deduped by the store:
  // identical statuses never fire) — so the rail dots/labels refresh. The
  // old code ALSO bumped on every per-tick agent-meta listener fire (every
  // ~50ms throttle flush of EVERY streaming agent) and every session-
  // preference write: each bump re-rendered AppShell → ALL mounted
  // workspaces → every editor pane + explorer + terminal wrapper, which
  // with 3 parallel projects was the hard switch freeze.
  useEffect(() => subscribeProjectAgentStatus(() => setStatusVersion((v) => v + 1)), []);
  useEffect(() => { void hydrateSessionPreferences(); }, []);
  useEffect(() => { void hydrateGroups(); }, []);

  useEffect(() => {
    void (async () => {
      // Every IPC here is boot-critical and hangs (not rejects) when the
      // channel wedges - guard each with bootAwait so one stuck call can't
      // leave a permanently blank window. The phase label shows in the
      // placeholder, making the wedge visible in the window itself.
      const launch = getLaunchDir();
      setBootStep("loading preferences");
      await bootAwait(usePreferencesStore.getState().init(), () => undefined, "preferences.init");
      const prefs = usePreferencesStore.getState();
      setBootStep("resolving home directory");
      const home = await bootAwait(
        homeDir().then((p) => p.replace(/\\/g, "/")),
        () => "",
        "homeDir",
      );
      setBootStep("restoring open projects");
      const saved = await bootAwait(
        openProjectsStore.get<{
          roots?: Array<string | { root: string; env: WorkspaceEnv }>;
          activeId?: string;
        }>("workspaces"),
        () => null,
        "openProjectsStore.get(workspaces)",
      );
      const savedProjects = (saved?.roots ?? []).map((entry) =>
        typeof entry === "string" ? { root: entry, env: LOCAL_WORKSPACE } : entry,
      );
      // Icon overrides are non-critical but boot-coupled (tiles would flash
      // the default glyph otherwise); same guarded race as the roots.
      const savedIconOverrides = await bootAwait(
        openProjectsStore.get<Record<string, { icon?: string; color?: string }>>("projectIcons"),
        () => ({}) as Record<string, { icon?: string; color?: string }>,
        "openProjectsStore.get(projectIcons)",
      );
      setProjectIconOverrides(savedIconOverrides ?? {});
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

  // New Project: save-style dialog (pick location + name), the Rust side
  // creates the folder, then it flows through addProject — the SAME open
  // path, so the new folder lands in the rail exactly like an opened one.
  const newProject = useCallback(async () => {
    try {
      const created = await invoke<string | null>("new_project_folder");
      if (!created) return; // user cancelled the dialog
      await addProject(created);
    } catch (error) {
      console.error("New project failed:", error);
    }
  }, [addProject]);

  // FIX 2 (2026-11-02 review): activeId/projects are read at CALL time
  // only - through refs, so changeEnvironment's identity is STABLE across
  // switches. It rides menuActions -> ProjectsMenuContext, and an unstable
  // identity re-rendered EVERY memoized workspace body on every switch
  // (defeating the activation-context refactor: the body subscribes via
  // useProjectsMenu()).
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const changeEnvironment = useCallback((id: string, env: WorkspaceEnv, home: string | null) => {
    const source = projectsRef.current.find((project) => project.id === id);
    if (!source) return;
    const next = createProjectRuntime(home ?? source.root, env);
    const existing = projectsRef.current.find((project) => project.id === next.id && project.id !== id);
    if (existing) {
      // The target workspace is already open: switch to it instead of
      // creating duplicate React keys and duplicate agent runtimes.
      if (id === activeIdRef.current) setActiveId(existing.id);
      return;
    }
    setProjects((current) => current.map((project) => project.id === id ? next : project));
    if (activeIdRef.current === id) setActiveId(next.id);
  }, []);

  const closeProject = useCallback((id: string) => {
    const project = projects.find((p) => p.id === id);
    if (!project) return;
    // The WebView's native confirm() is a SILENT NO-OP under Tauri — the
    // rail's X used to close a project instantly with no confirmation at
    // all. Arm the themed AlertDialog below instead and let the user
    // decide; performClose only runs from its destructive action.
    const running = getProjectAgentStatus(id) !== "idle";
    setCloseConfirm({
      id,
      name: project.root.split(/[\\/]/).filter(Boolean).pop() ?? project.root,
      root: project.root,
      running,
    });
  }, [projects]);

  const performClose = useCallback(() => {
    const pending = closeConfirm;
    setCloseConfirm(null);
    if (!pending) return;
    const id = pending.id;
    // Drop the project from any cross-project group chats first (arcs and
    // pending queues must not dangle); unmounting the retained workspace
    // then triggers its own project-scoped terminal/session cleanup.
    void removeProjectFromGroups(id);
    setProjects((current) => current.filter((p) => p.id !== id));
    setActiveId((current) => {
      if (current !== id) return current;
      const remaining = projects.filter((p) => p.id !== id);
      return remaining[0]?.id ?? null;
    });
  }, [closeConfirm, projects]);

  const items = useMemo(() => projects.map((project) => {
    const iconOverride = projectIconOverrides[projectIconOverrideKey(project.root)];
    return {
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
      // Unseen cross-project news (watch fired / agent replied while another
      // project was active). Amber pulse on the tile; cleared on switch.
      hasNews: project.id !== activeId && getProjectHasNews(project.id),
      active: project.id === activeId,
      icon: iconOverride?.icon,
      color: iconOverride?.color,
    };
  }), [projects, activeId, statusVersion, projectIconOverrides]);

  useEffect(() => {
    if (!ready) return;
    void openProjectsStore.set("workspaces", {
      roots: projects.map((p) => ({ root: p.root, env: p.env })),
      activeId,
    });
  }, [projects, activeId, ready]);

  // Icon/color customizations persist per canonical root, independent of the
  // open-roots list: close a project, reopen it later, the glyph is back.
  useEffect(() => {
    if (!ready) return;
    void openProjectsStore.set("projectIcons", projectIconOverrides);
  }, [projectIconOverrides, ready]);

  // STABLE ACTIONS CONTEXT (2026-11-02): the menu value is memoized on the
  // action callbacks ONLY. `items` live in their own context — a status
  // transition (items identity change) must not invalidate THIS context,
  // which every memoized ProjectWorkspace reads.
  const switchProject = useCallback((id: string) => {
    // startTransition: the visibility flip paints first; the heavy
    // re-render cascade (global chatStore session switch, hydration,
    // rail re-render) stays interruptible instead of blocking the frame.
    startTransition(() => setActiveId(id));
  }, []);
  // MANUAL RAIL ORDER: drag-to-reorder. The projects array IS the rail
  // order, and the persistence effect below saves roots in array order —
  // so this single splice covers live preview, persistence, and restore.
  const moveProject = useCallback((dragId: string, overId: string) => {
    if (dragId === overId) return;
    setProjects((current) => {
      const from = current.findIndex((p) => p.id === dragId);
      const to = current.findIndex((p) => p.id === overId);
      if (from < 0 || to < 0 || from === to) return current;
      const next = current.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);
  const changeProjectIcon = useCallback((id: string, icon: string | null, color: string | null) => {
    const project = projectsRef.current.find((p) => p.id === id);
    if (!project) return;
    const key = projectIconOverrideKey(project.root);
    setProjectIconOverrides((current) => {
      const merged = { ...current[key] };
      if (icon === null) delete merged.icon;
      else merged.icon = icon;
      if (color === null) delete merged.color;
      else merged.color = color;
      const next = { ...current };
      if (!merged.icon && !merged.color) delete next[key];
      else next[key] = merged;
      return next;
    });
  }, []);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const menuActions = useMemo(
    () => ({
      getItems: () => itemsRef.current,
      addProject,
      newProject,
      closeProject,
      switchProject,
      changeEnvironment,
      moveProject,
      changeProjectIcon,
    }),
    [addProject, newProject, closeProject, switchProject, changeEnvironment, moveProject, changeProjectIcon],
  );

  // Entering a project consumes its unseen-news flag: whatever fired while
  // the user was elsewhere (watch firing, background agent reply) has now
  // been seen.
  useEffect(() => {
    if (activeId) setProjectHasNews(activeId, false);
  }, [activeId]);

  if (!ready) {
    // Diagnosable boot placeholder instead of a blank themed window: shows
    // the exact phase (and that the frontend is alive) if a boot IPC wedges.
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Spinner className="size-5" />
          <span className="text-sm">Starting KAI ({bootStep})…</span>
        </div>
      </div>
    );
  }
  return (
    <ProjectsMenuContext.Provider value={menuActions}>
      <ProjectRailItemsContext.Provider value={items}>
      <div className="flex h-screen w-full">
        <div className="relative min-w-0 flex-1">
          <GroupChatPanel projects={items} activeProjectId={activeId} />
          {projects.map((project) => (
            <div
              key={project.id}
              className={cn(
                "absolute inset-0",
                project.id !== activeId && "invisible pointer-events-none",
              )}
              aria-hidden={project.id !== activeId}
              inert={project.id !== activeId ? true : undefined}
            >
              <ProjectRuntimeProvider value={project}>
                {/* ACTIVATION CONTEXT (2026-11-02 switch-lag round 2):
                    flipping THIS value re-renders only the small gate
                    components that subscribe — ProjectWorkspace itself
                    never re-renders on a switch (isActive-as-a-prop
                    reconciled BOTH flipping workspaces fully; with active
                    agent streams that was the residual lag). */}
                <WorkspaceActiveProvider value={project.id === activeId}>
                  <ProjectWorkspace />
                </WorkspaceActiveProvider>
              </ProjectRuntimeProvider>
            </div>
          ))}
          {activeId === null ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No projects open.
              <button type="button" className="ml-2 underline" onClick={() => void addProject()}>Open project</button>
            </div>
          ) : null}
          <AlertDialog
            open={closeConfirm !== null}
            onOpenChange={(open) => {
              if (!open) setCloseConfirm(null);
            }}
          >
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Close {closeConfirm?.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  {closeConfirm?.running
                    ? "Its running agents and terminals will be stopped."
                    : "This closes the project workspace. Terminals and editors are cleaned up."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={performClose}>
                  Close project
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
      </ProjectRailItemsContext.Provider>
    </ProjectsMenuContext.Provider>
  );
}


