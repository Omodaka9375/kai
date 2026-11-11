import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { FileMenuTriggerProvider } from "./fileMenu";
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
import { cn } from "@/lib/utils";
import {
  AgentRunBridge,
  AiInputBar,
  AiInputBarConnect,
  AiMiniWindow,
  GroupPill,
  getAllKeys,
  hasAnyKey,
  useChatStore,
} from "@/modules/ai";
import { CustomContextMenu } from "@/modules/ai/components/CustomContextMenu";
import { ApiTesterPane } from "@/modules/api-tester/ApiTesterPane";
import { AiComposerProvider } from "@/modules/ai/components/composer";
import { registerChatFileOpen } from "@/modules/ai/components/ChatFileLink";
import { AiErrorBoundary } from "@/modules/ai/components/AiErrorBoundary";
import { redactSensitive } from "@/modules/ai/lib/redact";
import { setSandboxRoot } from "@/modules/ai/lib/sandbox";
import { registerProjectRuntime, setProjectLive, setProjectActiveSession, projectIdForSession, stopSession } from "@/modules/ai/store/chatStore";
import { setSessionPreferences } from "@/modules/ai/store/sessionPreferences";
import { native } from "@/modules/ai/lib/native";
import { WorkspaceActivationGate } from "./workspaceActivation";
import {
  AiDiffStack,
  EditorStack,
  GitDiffStack,
  NewEditorDialog,
  type EditorPaneHandle,
} from "@/modules/editor";
import { MarkdownPreviewPane } from "@/modules/editor/MarkdownPreviewPane";
import {
  isFormattable,
  formatterLabelFor,
} from "@/modules/editor/lib/formatter";
import { GitHistoryStack } from "@/modules/git-history";
import { normalizeWorkspacePath } from "@/modules/ai/lib/workspacePath";
import { useZoom } from "@/lib/useZoom";
import { FileExplorer, type FileExplorerHandle } from "@/modules/explorer";
import {
  Header,
  FileMenu,
  type SearchInlineHandle,
  type SearchTarget,
} from "@/modules/header";
import { PreviewStack, type PreviewPaneHandle } from "@/modules/preview";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { onKeysChanged, setSidebarView, setSidebarWidth, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX } from "@/modules/settings/store";
import { ShortcutsDialog } from "@/modules/shortcuts";
import { useAppShortcuts } from "./useAppShortcuts";
import { useProjectsMenu } from "./projectsMenu";
import {
  ExtensionsView,
  SidebarRail,
  SIDEBAR_RAIL_HEIGHT,
  type SidebarViewId,
} from "@/modules/sidebar";
import { SourceControlPanel } from "@/modules/source-control";
import { useSourceControlWiring } from "./useSourceControlWiring";
import { StatusBar } from "@/modules/statusbar";
import { StartPage, useTabs, useWorkspaceCwd, type EditorTab } from "@/modules/tabs";
import {
  disposeSession,
  findLeafCwd,
  hasLeaf,
  leafIds,
  respawnSession,
  TerminalStack,
  type TerminalPaneHandle,
} from "@/modules/terminal";
import { ThemeProvider } from "@/modules/theme";
import { initBusHandlers } from "@/modules/ai/lib/busHandlers";
import { UpdaterDialog } from "@/modules/updater";
import {
  getWslHome,
  LOCAL_WORKSPACE,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
  createProjectRuntime,
  useProjectRuntime,
  useWorkspaceActive,
  ProjectRail,
} from "@/modules/workspace";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import type { SearchAddon } from "@xterm/addon-search";
import { AnimatePresence, motion } from "motion/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";


// Initialize agent bus event handlers once.
initBusHandlers();

/**
 * Session-stamp child (2026-11-02 switch-freeze fix): the GLOBAL
 * activeSessionId subscription lives here, so every session switch
 * re-renders only this null-rendering component — not the whole (now
 * memoized) workspace tree. Previously the subscription sat in
 * ProjectWorkspace itself: any session switch anywhere re-rendered
 * EVERY mounted workspace.
 */
function ProjectSessionStamp({
  projectRuntime,
}: {
  projectRuntime: ReturnType<typeof createProjectRuntime>;
}) {
  // Context subscriber (tiny/null-rendering): a project switch re-renders
  // this child, never the workspace body.
  const isActive = useWorkspaceActive();
  const activeChatSessionId = useChatStore((s) => s.activeSessionId);
  useEffect(() => {
    if (!isActive || !activeChatSessionId) return;
    // The global active id briefly still names the OUTGOING project's chat
    // when the foreground changes. Never stamp that id onto this project.
    if (projectIdForSession(activeChatSessionId) !== projectRuntime.id) return;
    setSessionPreferences(activeChatSessionId, { projectId: projectRuntime.id });
    setProjectActiveSession(projectRuntime.id, activeChatSessionId);
  }, [isActive, projectRuntime.id, activeChatSessionId]);
  return null;
}

/** ActiveRefSink - the ONE activation subscriber inside the workspace
 *  subtree: keeps isActiveRef current so document-level listeners and lazy
 *  tool callbacks can check foreground status without re-rendering the
 *  body on every project switch. Renders null. */
function ActiveRefSink({ isActiveRef }: { isActiveRef: React.MutableRefObject<boolean> }) {
  const isActive = useWorkspaceActive();
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive, isActiveRef]);
  return null;
}

/** AgentRunBridgeGate - context-subscribed wrapper: the bridge's isActive
 *  prop follows the activation context without the body re-rendering. The
 *  diff-tab callbacks ride the bridge's own prop types (DiffOpenInput et
 *  al) via ComponentProps inference. */
function AgentRunBridgeGate(
  props: Omit<React.ComponentProps<typeof AgentRunBridge>, "isActive">,
) {
  const isActive = useWorkspaceActive();
  return <AgentRunBridge {...props} isActive={isActive} />;
}

/** ActiveSurfaces - the right-gutter AI surfaces (mini window / group
 *  pill). Mounted per workspace; only the foreground one renders content.
 *  Context-subscribed so a switch re-renders this tiny component, not the
 *  workspace body. */
function ActiveSurfaces(props: {
  hasComposer: boolean;
  miniOpen: boolean;
  stackSurface: string;
  panelOpen: boolean;
}) {
  const isActive = useWorkspaceActive();
  if (!isActive) return null;
  const { hasComposer, miniOpen, stackSurface, panelOpen } = props;
  if (miniOpen && hasComposer && stackSurface !== "group") {
    return (
      <AiErrorBoundary label="mini-window">
        <AiMiniWindow key="ai-mini-window" />
      </AiErrorBoundary>
    );
  }
  if (hasComposer && stackSurface === "group") {
    return <GroupPill />;
  }
  // MINIMIZED AI WINDOW (2026-11-06): the window's _ button hid it while
  // the AI panel stayed open - the pill in the bottom strip is the re-entry
  // surface, the same collapse-to-pill pattern the group chat uses.
  // panelOpen is the gate: closing the panel via the status bar hides the
  // pill too (mini.open and panelOpen both false = fully closed).
  if (hasComposer && panelOpen && stackSurface !== "group") {
    return <GroupPill />;
  }
  return null;
}

/** Memoized (2026-11-02): AppShell re-renders on project-status transitions
 *  and its own state; the workspace reconciles only on ITS OWN state
 *  changes. ACTIVATION (round 2, same day - the residual switch lag with
 *  actively-streaming agents): isActive was a PROP, so the two flipping
 *  workspaces always fully reconciled on every switch; with live streams
 *  those trees are large AND being pumped by token flushes that kept
 *  interrupting the switch transition. Activation now rides
 *  WorkspaceActiveContext: the workspace body NEVER subscribes - all
 *  activation effects live in the null-rendering WorkspaceActivationGate
 *  child, and every visual/behavioral gate is a tiny context subscriber. */
export const ProjectWorkspace = memo(function ProjectWorkspace() {
  const runtime = useProjectRuntime();
  const projectsMenu = useProjectsMenu();
  // ACTIVATION REFS (2026-11-02): document-level listeners and lazy tool
  // callbacks check activation via this ref - it is kept current by the
  // <ActiveRefSink> child (the ONLY place the body's subtree subscribes to
  // the activation context). The body itself never re-renders on a switch.
  const isActiveRef = useRef(false);
  const setLiveRef = useRef<(() => void) | null>(null);
  const {
    tabs,
    activeId,
    setActiveId,
    newTab,
    newPrivateTab,
    openFileTab,
    pinTab,
    newPreviewTab,
    openAiDiffTab,
    closeAiDiffTab,
    openGitDiffTab,
    openCommitHistoryTab,
    openCommitFileDiffTab,
    newApiTesterTab,
    openMarkdownPreview,
    closeTab,
    updateTab,
    selectByIndex,
    setLeafCwd,
    focusPane,
    focusNextPaneInTab,
    splitActivePane,
    closeActivePane,
    closePaneByLeaf,
    resetWorkspace,
    closeOthers,
    moveTab,
  } = useTabs({ defer: true });

  // Mirror `tabs` into a ref so callbacks scheduled with `setTimeout`
  // (e.g. cdInNewTab) read the latest pane state instead of a stale closure.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const activeTerminalTab = useMemo(() => {
    const t = tabs.find((x) => x.id === activeId);
    return t && t.kind === "terminal" ? t : null;
  }, [tabs, activeId]);
  const activeLeafId = activeTerminalTab?.activeLeafId ?? null;

  const searchAddons = useRef<Map<number, SearchAddon>>(new Map());
  const [activeSearchAddon, setActiveSearchAddon] =
    useState<SearchAddon | null>(null);
  const searchInlineRef = useRef<SearchInlineHandle | null>(null);
  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(new Map());
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(new Map());
  const previewRefs = useRef<Map<number, PreviewPaneHandle>>(new Map());
  const [activeEditorHandle, setActiveEditorHandle] =
    useState<EditorPaneHandle | null>(null);
  const { zoomIn, zoomOut, zoomReset } = useZoom();
  const explorerRef = useRef<FileExplorerHandle>(null);
  const explorerReturnFocusRef = useRef<HTMLElement | null>(null);

  const sidebarRef = useRef<PanelImperativeHandle | null>(null);
  const sidebarWidthRef = useRef(SIDEBAR_WIDTH_DEFAULT);
  const sidebarWidthWriteTimerRef = useRef(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarView, setSidebarViewState] = useState<SidebarViewId>("explorer");
  const persistSidebarView = useCallback((view: SidebarViewId) => {
    setSidebarViewState(view);
    void setSidebarView(view);
  }, []);

  // ── Expanded-AI-window left offset ──────────────────────────────────────
  // `--kai-workspace-left` (rail 48px + sidebar + handle) is a document-global
  // var the expanded AiMiniWindow positions its left edge against. Every
  // ProjectWorkspace mounts its OWN sidebar panel, and background panels fire
  // onResize on mount — without a gate, the var tracked whichever project
  // mounted or resized last, not the foreground one. And a project switch
  // resizes nothing, so a stale value from the outgoing project made the
  // incoming project's expanded window render over its file tree (or leave a
  // gap past it). Two rules keep it correct:
  //   1. only the foreground instance writes the var (onResize gate below);
  //   2. the foreground instance re-syncs the var on every activation.
  // Width and collapsed state are naturally per-project — each instance owns
  // its panel for its whole mounted life, so there is nothing to save/restore
  // across switches beyond the var itself.
  const writeWorkspaceLeft = useCallback((inPixels: number) => {
    const handleW = inPixels > 0 ? 1 : 0;
    document.documentElement.style.setProperty(
      "--kai-workspace-left",
      `${inPixels + handleW + 48}px`,
    );
  }, []);
  // The activation-dependent --kai-workspace-left write moved into
  // <WorkspaceActivationGate>. Body callbacks (panel onResize) gate on
  // isActiveRef; the gate re-syncs the var on every activation (a switch
  // resizes nothing, so without the re-sync the incoming project's
  // expanded window rendered at the outgoing project's offset).
  const getSidebarPx = useCallback(() => {
    const panel = sidebarRef.current;
    return panel
      ? panel.getSize().inPixels
      : sidebarCollapsed
        ? 0
        : sidebarWidthRef.current;
  }, [sidebarCollapsed]);

  const toggleSidebar = useCallback(() => {
    const p = sidebarRef.current;
    if (!p) return;
    if (p.getSize().asPercentage <= 0) p.expand();
    else p.collapse();
  }, []);
  const cycleSidebarView = useCallback(
    (view: SidebarViewId) => {
      const panel = sidebarRef.current;
      const collapsed = panel ? panel.getSize().asPercentage <= 0 : false;
      if (collapsed) {
        if (panel) panel.resize(`${sidebarWidthRef.current}px`);
        if (view !== sidebarView) persistSidebarView(view);
        return;
      }
      if (view === sidebarView) {
        panel?.collapse();
        return;
      }
      persistSidebarView(view);
    },
    [persistSidebarView, sidebarView],
  );
  const persistSidebarWidth = useCallback((next: number) => {
    sidebarWidthRef.current = next;
    if (sidebarWidthWriteTimerRef.current) {
      window.clearTimeout(sidebarWidthWriteTimerRef.current);
    }
    sidebarWidthWriteTimerRef.current = window.setTimeout(() => {
      sidebarWidthWriteTimerRef.current = 0;
      void setSidebarWidth(next);
    }, 200);
  }, []);
  useEffect(() => {
    return () => {
      if (sidebarWidthWriteTimerRef.current) {
        window.clearTimeout(sidebarWidthWriteTimerRef.current);
      }
    };
  }, []);

  const toggleExplorerFocus = useCallback(() => {
    const explorer = explorerRef.current;
    const panel = sidebarRef.current;
    const collapsed = panel ? panel.getSize().asPercentage <= 0 : false;
    if (sidebarView !== "explorer" || collapsed) {
      if (panel && collapsed) panel.resize(`${sidebarWidthRef.current}px`);
      if (sidebarView !== "explorer") persistSidebarView("explorer");
      const active = document.activeElement;
      explorerReturnFocusRef.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
      requestAnimationFrame(() => explorerRef.current?.focus());
      return;
    }
    if (!explorer) return;
    if (explorer.isFocused()) {
      const target = explorerReturnFocusRef.current;
      explorerReturnFocusRef.current = null;
      if (target && document.body.contains(target)) {
        target.focus();
      } else {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      return;
    }
    const active = document.activeElement;
    explorerReturnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    explorer.focus();
  }, [persistSidebarView, sidebarView]);

  const [home, setHome] = useState<string | null>(null);
  const [pendingCloseTab, setPendingCloseTab] = useState<number | null>(null);
  // Dirty-editor tabs awaiting "Close others" confirmation. Null when the
  // dialog is closed; the kept tab id is stored alongside so the handler can
  // resume after the dialog resolves.
  const [pendingCloseOthers, setPendingCloseOthers] = useState<{
    keepId: number;
    dirtyIds: number[];
  } | null>(null);
  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const setWorkspaceEnv = useWorkspaceEnvStore((s) => s.setEnv);
  const [launchCwd, setLaunchCwd] = useState<string | null>(null);
  const [launchCwdResolved, setLaunchCwdResolved] = useState(false);
  const [pendingDeleteTabs, setPendingDeleteTabs] = useState<number[] | null>(
    null,
  );
  // Project switch awaiting dirty-editor confirmation. Opening a project
  // while another one is open SWITCHES the workspace (previous project's
  // tabs close); dirty editors from the outgoing project get one batched
  // confirmation first. Null when the dialog is closed.
  const [pendingProjectOpen, setPendingProjectOpen] = useState<{
    path: string;
    dirtyIds: number[];
  } | null>(null);
  useEffect(() => {
    homeDir()
      .then(async (p) => {
        const normalized = p.replace(/\\/g, "/");
        setHome(normalized);
        try {
          await native.workspaceAuthorize(normalized);
        } catch {
          // Bootstrap already authorizes home from Rust; ignore.
        }
      })
      .catch(() => setHome(null));
  }, []);

  const switchWorkspace = useCallback(
    async (env: WorkspaceEnv) => {
      if (
        env.kind === workspaceEnv.kind &&
        (env.kind === "local" ||
          (workspaceEnv.kind === "wsl" && env.distro === workspaceEnv.distro))
      ) {
        return;
      }
      const dirty = tabsRef.current.some((t) => t.kind === "editor" && t.dirty);
      if (dirty) {
        window.alert("Save or close unsaved editor tabs before switching workspace.");
        return;
      }

      let nextHome: string | null = null;
      try {
        if (env.kind === "wsl") {
          nextHome = await getWslHome(env.distro);
        } else {
          nextHome = (await homeDir()).replace(/\\/g, "/");
        }
      } catch (e) {
        window.alert(String(e));
        return;
      }

      for (const id of liveLeavesRef.current) disposeSession(id);
      searchAddons.current.clear();
      terminalRefs.current.clear();
      editorRefs.current.clear();
      previewRefs.current.clear();
      setActiveSearchAddon(null);
      setActiveEditorHandle(null);
      setWorkspaceEnv(env.kind === "local" ? LOCAL_WORKSPACE : env);
      setHome(nextHome);
      setLaunchCwd(nextHome);
      if (nextHome) {
        try {
          await native.workspaceAuthorize(nextHome);
        } catch {
          // Non-fatal — git panel will surface "not authorized" if needed.
        }
      }
      if (runtime && projectsMenu) {
        projectsMenu.changeEnvironment(runtime.id, env, nextHome);
        return;
      }
      resetWorkspace();
    },
    [runtime, projectsMenu, workspaceEnv, setWorkspaceEnv, resetWorkspace],
  );
  // On launch, resolve the workspace root ONLY — no auto-spawned terminal.
  // A mount-time PTY raced the first paint / window-state restore / the
  // renderer font-gate (the renderer-bind race class); the StartPage now
  // fills the zero-tab state and terminals spawn on demand.

  // ── Workspace split ────────────────────────────────────────────────
  // When non-null, the workspace splits into two side-by-side panels.
  // The left panel shows the primary activeId tab; the right panel
  // shows this tab.
  const [splitTabId, setSplitTabId] = useState<number | null>(null);
  const splitTab = splitTabId !== null ? tabs.find((t) => t.id === splitTabId) : null;
  // Auto-clear if the split tab was closed.
  useEffect(() => {
    if (splitTabId !== null && !tabs.some((t) => t.id === splitTabId)) {
      setSplitTabId(null);
    }
  }, [tabs, splitTabId]);
  const toggleSplitTab = useCallback(
    (tabId: number) => {
      setSplitTabId((cur) => (cur === tabId ? null : tabId));
    },
    [],
  );
  const closeSplit = useCallback(() => setSplitTabId(null), []);
  const miniOpen = useChatStore((s) => s.mini.open);
  // Right-gutter stack: when a group chat owns the expanded slot, the AI
  // mini window is NOT mounted — the GroupPill (AppShell-level, since the
  // group panel is app-level) swaps back on click.
  const stackSurface = useChatStore((s) => s.stackRail.surface);
  const focusInput = useChatStore((s) => s.focusInput);
  const openPanel = useChatStore((s) => s.openPanel);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const apiKeys = useChatStore((s) => s.apiKeys);
  const setApiKeys = useChatStore((s) => s.setApiKeys);
  const setLive = useChatStore((s) => s.setLive);
  const respondToApproval = useChatStore((s) => s.respondToApproval);
  const openaiCompatibleModelId = usePreferencesStore(
    (s) => s.openaiCompatibleModelId,
  );
  const openaiCompatibleBaseURL = usePreferencesStore(
    (s) => s.openaiCompatibleBaseURL,
  );
  const hasLocalModel =
    openaiCompatibleBaseURL.trim().length > 0 &&
    openaiCompatibleModelId.trim().length > 0;
  const hasComposer = hasAnyKey(apiKeys) || hasLocalModel;

  const [keysLoaded, setKeysLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const reload = () => {
      void getAllKeys().then((keys) => {
        if (!alive) return;
        setApiKeys(keys);
        setKeysLoaded(true);
      });
    };
    reload();
    const unlistenP = onKeysChanged(reload);
    return () => {
      alive = false;
      void unlistenP.then((fn) => fn());
    };
  }, [setApiKeys]);

  // Hydrate the cross-window preference store and mirror the default model
  // into chatStore so the dropdown reflects what the user picked in Settings.
  const initPrefs = usePreferencesStore((s) => s.init);
  const prefDefaultModel = usePreferencesStore((s) => s.defaultModelId);
  const prefsHydrated = usePreferencesStore((s) => s.hydrated);
  useEffect(() => {
    void initPrefs();
  }, [initPrefs]);

  // Apply persisted sidebar geometry once prefs hydrate. Per-PID WebView2
  // profiles mean localStorage no longer survives launches, so the store is
  // the authoritative restore path.
  useEffect(() => {
    if (!prefsHydrated) return;
    const s = usePreferencesStore.getState();
    sidebarWidthRef.current = s.sidebarWidth;
    // ALWAYS start on the file tree. The persisted view is intentionally not
    // restored here: if source-control was the last view, every launch opened
    // the git panel first — it kicks off its snapshot + auto-fetch at mount
    // and races the file tree / PTY init for the main thread, which reads as
    // startup lag. The git panel is one click away on the rail when wanted.
    setSidebarViewState("explorer");

    const applyWidth = () => {
      const panel = sidebarRef.current;
      if (panel && s.sidebarWidth !== SIDEBAR_WIDTH_DEFAULT) {
        panel.resize(`${s.sidebarWidth}px`);
      }
    };
    // The panel ref may not be attached yet when prefs resolve (hydration can
    // beat the resizable panel mount). Retry once on the next frame.
    applyWidth();
    if (s.sidebarWidth !== SIDEBAR_WIDTH_DEFAULT && !sidebarRef.current) {
      const raf = requestAnimationFrame(applyWidth);
      return () => cancelAnimationFrame(raf);
    }
  }, [prefsHydrated]);
  const projectModelIds = usePreferencesStore((s) => s.projectModelIds);

  const hydrateSessions = useChatStore((s) => s.hydrateSessions);

  const activeTab = tabs.find((t) => t.id === activeId);
  const isTerminalTab = activeTab?.kind === "terminal";
  const isEditorTab = activeTab?.kind === "editor";
  const isPreviewTab = activeTab?.kind === "preview";
  const isAiDiffTab = activeTab?.kind === "ai-diff";
  const isGitDiffTab =
    activeTab?.kind === "git-diff" || activeTab?.kind === "git-commit-file";
  const isGitHistoryTab = activeTab?.kind === "git-history";
  const isApiTesterTab = activeTab?.kind === "api-tester";

  // VSCode-style auto-reveal: switching to an editor tab focuses that file in
  // the tree (expand ancestors, select, scroll into view). Only while the
  // explorer is the visible sidebar view — a reveal against a mounted-elsewhere
  // or unmounted FileExplorer is pointless churn. Terminal/preview/diff tabs
  // have no tree row to reveal, so their path is null and the effect no-ops.
  useEffect(() => {
    if (sidebarView !== "explorer") return;
    if (activeTab?.kind !== "editor") return;
    const path = activeTab.path;
    if (!path) return;
    explorerRef.current?.revealFile(path);
  }, [activeTab, sidebarView]);

  // NOTE: editor reloads after agent writes are no longer driven from here.
  // Rust emits `fs-changed` on every fs_write_file/fs_write_file_bytes, and
  // each open editor listens (useDocument): clean buffers auto-reload, dirty
  // buffers show a conflict banner. That covers ai-diff approvals AND
  // auto-approved writes, which the old per-approval effect missed.

  const { explorerRoot, inheritedCwdForNewTab, _setRoot } = useWorkspaceCwd(
    activeTab,
    tabs,
    launchCwd ?? home,
  ) as ReturnType<typeof useWorkspaceCwd> & { _setRoot: (cwd: string) => void };
  const setRootRef = useRef(_setRoot);
  setRootRef.current = _setRoot;
  const projectRuntime = useMemo(
    () => runtime ?? createProjectRuntime(explorerRoot ?? launchCwd ?? home ?? "", workspaceEnv),
    [runtime, explorerRoot, launchCwd, home, workspaceEnv],
  );

  // The foreground-only height observer lives in WorkspaceActivationGate.
  // The ref itself stays stable: an inline callback would install a new
  // observer on every commit and leak the previous one.
  const inputBarRef = useRef<HTMLDivElement | null>(null);

  const onOpenProject = useCallback(
    (path: string) => {
      // Opening a project SWITCHES the workspace: the previous project's
      // tabs close and you land in the new one (same reset as the local ↔
      // WSL env switch — terminals of the old project cannot follow). A
      // same-project click is a no-op when tabs are open — no surprise
      // terminal massacre on a Recent-click of the project you are already
      // in — but still lands you in the project when you are on the
      // StartPage with zero tabs.
      if (projectsMenu) {
        const normalized = path.replace(/\\/g, "/").toLowerCase();
        const existing = projectsMenu.getItems().find(
          (item) => item.root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === normalized.replace(/\/+$/, ""),
        );
        if (existing) projectsMenu.switchProject(existing.id);
        else projectsMenu.addProject(path);
        return;
      }
      const norm = (p: string) => p.replace(/\\/g, "/");
      if (explorerRoot && norm(explorerRoot) === norm(path)) {
        if (tabs.length === 0) newTab(path);
        return;
      }
      const dirtyIds = tabs
        .filter((t) => t.kind === "editor" && t.dirty)
        .map((t) => t.id);
      if (dirtyIds.length > 0) {
        setPendingProjectOpen({ path, dirtyIds });
        return;
      }
      setRootRef.current(path);
      // Clean start: kills the old project's terminals, lands on the
      // StartPage — no auto-spawn racing the renderer bind. Also reset the
      // sidebar to the file tree: sidebarView persists globally across
      // projects, so once source-control was active EVERY project opened
      // with the git panel (with stale data) instead of the explorer.
      persistSidebarView("explorer");
      resetWorkspace();
    },
    [tabs, explorerRoot, resetWorkspace, newTab, projectsMenu],
  );

  // Single-instance forwarding: a second KAI launch (e.g. "Open with KAI" in
  // Explorer, or a pinned shortcut with a path argument) no longer starts a
  // second process — the Rust single-instance plugin hands its argv to THIS
  // window. Open the forwarded project here, same as File > Open Project.
  const onOpenProjectRef = useRef(onOpenProject);
  onOpenProjectRef.current = onOpenProject;
  useEffect(() => {
    // Ref-gated (passive listener): subscribing the body to activation is
    // what this refactor removes. The gate owns foreground-only work.
    if (!isActiveRef.current) return;
    const promise = listen<string>("Kai://open-project", (event) => {
      const path = event.payload;
      if (!path) return;
      onOpenProjectRef.current(path.replace(/\\/g, "/"));
    });
    return () => {
      void promise.then((un) => un());
    };
  }, []);

  // Current project folder name — the last path segment. Used for the window
  // title (taskbar / Alt+Tab disambiguation) and the header's project label.
  const projectName = useMemo(() => {
    if (!explorerRoot) return null;
    return explorerRoot.split(/[\\/]/).filter(Boolean).pop() ?? explorerRoot;
  }, [explorerRoot]);





  // Personal assistant (Telegram bridge) — ONCE per app launch.
  //
  // Deliberately its own effect: the bootstrap above re-runs whenever
  // `explorerRoot` changes (project switch), which would stack duplicate claim
  // listeners. This one depends on nothing.
  //
  // The main window is the long-lived owner of Telegram event delivery.
  // `reclaimAssistantEvents` re-registers the poll loop's Channel here (the
  // loop itself is a global Rust thread), and the claim listener lets the
  // Settings panel hand delivery over after it enables the bot — otherwise
  // closing that transient window would strand the loop on a dead Channel and
  // the bot would silently ignore every message.

  useEffect(() => {
    setActiveSearchAddon(
      activeLeafId !== null ? (searchAddons.current.get(activeLeafId) ?? null) : null,
    );
    setActiveEditorHandle(editorRefs.current.get(activeId) ?? null);
  }, [activeId, activeLeafId]);

  const handleSearchReady = useCallback(
    (leafId: number, addon: SearchAddon) => {
      searchAddons.current.set(leafId, addon);
      if (leafId === activeLeafId) setActiveSearchAddon(addon);
    },
    [activeLeafId],
  );

  const disposeTab = useCallback(
    (id: number) => {
      // Terminal-leaf-keyed maps (terminalRefs/searchAddons) are pruned by
      // the effect below as the pane tree changes; only the tab-id-keyed
      // handles need explicit cleanup here.
      editorRefs.current.delete(id);
      previewRefs.current.delete(id);
      closeTab(id);
    },
    [closeTab],
  );

  // Drives session disposal off the pane tree, not React lifecycles —
  // split/unsplit re-mount components but the leaf is still live.
  const liveLeavesRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const live = new Set<number>();
    for (const t of tabs) {
      if (t.kind === "terminal") {
        for (const id of leafIds(t.paneTree)) live.add(id);
      }
    }
    for (const id of liveLeavesRef.current) {
      if (!live.has(id)) disposeSession(id);
    }
    liveLeavesRef.current = live;
    for (const k of [...terminalRefs.current.keys()])
      if (!live.has(k)) terminalRefs.current.delete(k);
    for (const k of [...searchAddons.current.keys()])
      if (!live.has(k)) searchAddons.current.delete(k);
  }, [tabs]);

  const handleClose = useCallback(
    (id: number) => {
      const t = tabs.find((x) => x.id === id);
      if (t?.kind === "editor" && t.dirty) {
        setPendingCloseTab(id);
        return;
      }
      disposeTab(id);
    },
    [tabs, disposeTab],
  );

  const confirmClose = useCallback(() => {
    if (pendingCloseTab !== null) {
      disposeTab(pendingCloseTab);
      setPendingCloseTab(null);
    }
  }, [pendingCloseTab, disposeTab]);

  const cancelClose = useCallback(() => {
    setPendingCloseTab(null);
  }, []);

  /**
   * "Close others" from a tab's context menu. Mirrors handleClose's
   * dirty-editor policy for every OTHER tab: dirty editors get the
   * confirmation dialog (batched), everything else closes immediately.
   */
  const handleCloseOthers = useCallback(
    (keepId: number) => {
      const others = tabs.filter((t) => t.id !== keepId);
      const dirtyIds = others
        .filter((t) => t.kind === "editor" && t.dirty)
        .map((t) => t.id);
      if (dirtyIds.length > 0) {
        setPendingCloseOthers({ keepId, dirtyIds });
        return;
      }
      const closed = closeOthers(keepId);
      for (const id of closed) {
        editorRefs.current.delete(id);
        previewRefs.current.delete(id);
      }
    },
    [tabs, closeOthers],
  );

  const confirmCloseOthers = useCallback(() => {
    if (pendingCloseOthers === null) return;
    const { keepId } = pendingCloseOthers;
    setPendingCloseOthers(null);
    const closed = closeOthers(keepId);
    for (const id of closed) {
      editorRefs.current.delete(id);
      previewRefs.current.delete(id);
    }
  }, [pendingCloseOthers, closeOthers]);

  const cancelCloseOthers = useCallback(() => {
    setPendingCloseOthers(null);
  }, []);

  const confirmProjectOpen = useCallback(() => {
    if (pendingProjectOpen === null) return;
    const { path } = pendingProjectOpen;
    setPendingProjectOpen(null);
    // Mirror the env-switch cleanup: the unmount ref callbacks do NOT
    // null the ACTIVE editor/search handles once activeId has already
    // moved to the new terminal tab — clear them explicitly.
    searchAddons.current.clear();
    terminalRefs.current.clear();
    editorRefs.current.clear();
    previewRefs.current.clear();
    setActiveSearchAddon(null);
    setActiveEditorHandle(null);
    setRootRef.current(path);
    resetWorkspace();
  }, [pendingProjectOpen, resetWorkspace]);

  const cancelProjectOpen = useCallback(() => {
    setPendingProjectOpen(null);
  }, []);
  const cycleTab = useCallback(
    (delta: 1 | -1) => {
      if (tabs.length < 2) return;
      const idx = tabs.findIndex((t) => t.id === activeId);
      const nextIdx = (idx + delta + tabs.length) % tabs.length;
      setActiveId(tabs[nextIdx].id);
    },
    [tabs, activeId, setActiveId],
  );

  const captureActiveSelection = useCallback((): string | null => {
    const t = tabs.find((x) => x.id === activeId);
    if (!t) return null;
    if (t.kind === "terminal") {
      const lid = t.activeLeafId;
      return terminalRefs.current.get(lid)?.getSelection() ?? null;
    }
    if (t.kind === "editor") {
      return editorRefs.current.get(activeId)?.getSelection() ?? null;
    }
    return null;
  }, [tabs, activeId]);

  const togglePanelAndFocus = useCallback(() => {
    if (!hasComposer) {
      void openSettingsWindow("models");
      return;
    }
    if (panelOpen) {
      useChatStore.getState().closePanel();
    } else {
      openPanel();
      focusInput(null);
    }
  }, [hasComposer, panelOpen, openPanel, focusInput]);

  const attachSelection = useChatStore((s) => s.attachSelection);

  const handleAttachFileToAgent = useCallback(
    (path: string) => {
      if (!hasComposer) {
        void openSettingsWindow("models");
        return;
      }
      // Dispatch a window event the composer listens for. Same pattern as
      // selections — keeps file-explorer decoupled from the AI module.
      window.dispatchEvent(
        new CustomEvent<{ path: string; projectId?: string }>("Kai:ai-attach-file", {
          detail: { path, projectId: projectRuntime.id },
        }),
      );
      openPanel();
      focusInput(null);
    },
    [hasComposer, openPanel, focusInput],
  );

  const askFromSelection = useCallback(() => {
    if (!hasComposer) {
      void openSettingsWindow("models");
      return;
    }
    const selection = captureActiveSelection();
    if (!selection || !selection.trim()) {
      focusInput(null);
      return;
    }
    const source: "terminal" | "editor" =
      activeTab?.kind === "editor" ? "editor" : "terminal";
    attachSelection(selection, source);
  }, [
    hasComposer,
    captureActiveSelection,
    focusInput,
    attachSelection,
    activeTab,
  ]);

  // Quote-from-transcript: the DOM selection inside a chat transcript is
  // captured at MENU-BUILD time (the browser clears it on mousedown before
  // the row's click fires), and the author is recovered from the nearest
  // [data-msg-author] wrapper. The group panel carries data-group-chat-panel
  // + the open group's id; its quote seeds the GROUP composer (scoped by
  // groupId), everything else seeds the session composer.
  const quoteFromTranscript = useCallback(
    (text: string, author: string, groupId?: string) => {
      if (groupId) {
        window.dispatchEvent(
          new CustomEvent<{ groupId: string; author: string; text: string }>(
            "Kai:group-quote",
            { detail: { groupId, author, text } },
          ),
        );
        return;
      }
      if (!hasComposer) {
        void openSettingsWindow("models");
        return;
      }
      window.dispatchEvent(
        new CustomEvent<{ author: string; text: string }>("Kai:ai-quote", {
          detail: { author, text },
        }),
      );
      openPanel();
      focusInput(null);
    },
    [hasComposer, openPanel, focusInput],
  );


  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    selectionText: string | null;
    isTerminal: boolean;
    /** Editor path when the menu targets a code editor (adds Format rows). */
    editorPath: string | null;
    /** Quote payload when the menu targets a chat transcript message. */
    quote: { author: string; text: string; groupId: string | null } | null;
  } | null>(null);

  /** Format errors from the context menu's Format actions — shown inline in
   *  the menu instead of a second overlapping menu. Cleared on dismiss. */
  const [formatMenuError, setFormatMenuError] = useState<string | null>(null);

  const handleCopy = useCallback(() => {
    const text = contextMenu?.selectionText ?? captureActiveSelection();
    if (text) void navigator.clipboard.writeText(text);
  }, [contextMenu, captureActiveSelection]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const t = tabsRef.current.find((x) => x.id === activeId);
      if (t?.kind === "terminal") {
        // Inject cleanly into the active shell PTY session
        const term = terminalRefs.current.get(t.activeLeafId);
        if (term) term.write(text);
      } else if (t?.kind === "editor") {
        const editor = editorRefs.current.get(activeId);
        if (editor) {
          editor.focus();
          document.execCommand("insertText", false, text);
        }
      }
    } catch (e) {
      console.error("Custom paste failed:", e);
    }
  }, [activeId]);

  const handleSelectAll = useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t?.kind === "editor") {
      const editor = editorRefs.current.get(activeId);
      if (editor) {
        editor.focus();
        document.execCommand("selectAll");
      }
    } else if (t?.kind === "terminal") {
      const term = terminalRefs.current.get(t.activeLeafId);
      if (term && "selectAll" in term) {
        (term as { selectAll?: () => void }).selectAll?.();
      }
    }
  }, [activeId]);

  const handleClearTerminal = useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t?.kind === "terminal") {
      const term = terminalRefs.current.get(t.activeLeafId);
      if (term) term.write("clear\r");
    }
  }, [activeId]);

  // Editor path for the active tab — read inside the document-level
  // contextmenu handler so format actions can be offered for editors.
  const activeTabPathRef = useRef<string | null>(null);
  useEffect(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    activeTabPathRef.current = t?.kind === "editor" ? t.path : null;
  }, [activeId, tabs]);

  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Allow native context menu in input fields, textareas, and general contenteditables,
      // EXCEPT inside CodeMirror's editable area (where we want our custom selection actions).
      if (
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable) &&
        !target.closest(".cm-content")
      ) {
        return;
      }

      e.preventDefault();

      const isTerminal = !!target.closest(".xterm-screen");
      const isEditor = !!target.closest(".cm-editor");
      // Chat transcripts (AI mini window, group panel): selection quoting.
      // The transcript author is stamped on the message wrapper via
      // data-msg-author; the browser selection is captured NOW because it
      // is cleared before the menu row's click handler runs.
      const msgEl = target.closest("[data-msg-author]");
      const quoteTarget = msgEl as { getAttribute(k: string): string | null } | null;
      // Group panel quotes seed the GROUP composer - recover the open group
      // from the panel container so the event lands in the right Composer.
      const groupPanelEl = target.closest("[data-group-chat-panel]");
      const groupQuoteId = groupPanelEl
        ? (groupPanelEl as { getAttribute(k: string): string | null }).getAttribute("data-group-id")
        : null;
      const transcriptSelection = msgEl
        ? String(document.getSelection?.() ?? "").trim() || null
        : null;

      // Do not open our custom context menu outside editor/terminal/chat panes
      if (!isTerminal && !isEditor && !quoteTarget) {
        setContextMenu(null);
        return;
      }
      // No selection in a chat message: fall through to the standard rows
      // only for terminal/editor; a bare chat right-click shows nothing.
      if (!isTerminal && !isEditor && !transcriptSelection) {
        setContextMenu(null);
        return;
      }

      const selectionText = isTerminal || isEditor
        ? captureActiveSelection()
        : transcriptSelection;
      setFormatMenuError(null);
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        selectionText,
        isTerminal,
        editorPath: isEditor ? activeTabPathRef.current : null,
        quote:
          quoteTarget && transcriptSelection
            ? {
                author: quoteTarget.getAttribute("data-msg-author") || "You",
                text: transcriptSelection,
                groupId: groupQuoteId,
              }
            : null,
      });
    };

    if (!isActiveRef.current) return;
    document.addEventListener("contextmenu", handleContextMenu);
    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [captureActiveSelection]);

  const openNewTab = useCallback(() => {
    newTab(inheritedCwdForNewTab());
  }, [newTab, inheritedCwdForNewTab]);

  const openNewPrivateTab = useCallback(() => {
    newPrivateTab(inheritedCwdForNewTab());
  }, [newPrivateTab, inheritedCwdForNewTab]);

  const sendCd = useCallback(
    (path: string) => {
      if (activeLeafId === null) return;
      const term = terminalRefs.current.get(activeLeafId);
      if (!term) return;
      const quoted = path.includes(" ")
        ? `'${path.replace(/'/g, `'\\''`)}'`
        : path;
      term.write(`cd ${quoted}\r`);
      term.focus();
    },
    [activeLeafId],
  );

  const cdInNewTab = useCallback(
    (path: string) => {
      const tabId = newTab(path);
      setTimeout(() => {
        const tab = tabsRef.current.find((x) => x.id === tabId);
        if (!tab || tab.kind !== "terminal") return;
        const t = terminalRefs.current.get(tab.activeLeafId);
        if (!t) return;
        const quoted = path.includes(" ")
          ? `'${path.replace(/'/g, `'\\''`)}'`
          : path;
        t.write(`cd ${quoted}\r`);
        t.focus();
      }, 80);
    },
    [newTab],
  );

  const dirtyEditorTabs = useMemo(
    () => tabs.filter((t): t is EditorTab => t.kind === "editor" && t.dirty),
    [tabs],
  );

  const handleSave = useCallback(() => {
    const active = tabs.find((t) => t.id === activeId);
    if (active?.kind === "editor" && active.dirty) {
      editorRefs.current.get(activeId)?.save();
    }
  }, [tabs, activeId]);

  const handleSaveAll = useCallback(() => {
    for (const t of dirtyEditorTabs) {
      editorRefs.current.get(t.id)?.save();
    }
  }, [dirtyEditorTabs]);

  const handleOpenFile = useCallback(
    (path: string, pin?: boolean, lineNum?: number) => {
      // An expanded AI window covers the whole workspace — opening a file
      // behind it would be invisible. Collapse to the docked mini window
      // so the editor takes focus visibly.
      useChatStore.getState().collapseMini();
      // Same visibility rule for an expanded group panel - it covers the
      // whole workspace too.
      useChatStore.getState().setGroupPanelExpanded(false);
      // Explorer defaults to preview (pin=false); explicit actions like
      // context-menu "Open" pass pin=true for a persistent tab.
      const tabId = openFileTab(path, pin ?? false);
      if (typeof lineNum === "number" && lineNum > 0) {
        setTimeout(() => {
          const handle = editorRefs.current.get(tabId ?? activeId);
          if (handle && "scrollToLine" in handle) {
            handle.scrollToLine(lineNum);
          }
        }, 120);
      }
    },
    [openFileTab, activeId],
  );

  // CHAT FILE LINKS (2026-11-02): agent-written relative paths (e.g.
  // docs/report.md in a [label](docs/report.md) markdown link) resolve
  // against the active project and open in the editor through the SAME
  // handler as explorer opens — same collapse rules, same line jumping.
  // Registered once; ChatFileLink degrades to plain text without it.
  useEffect(() => {
    registerChatFileOpen((path, line) => handleOpenFile(path, false, line));
    return () => registerChatFileOpen(null);
  }, [handleOpenFile]);

  // Clicking a tab follows the same visibility rule as opening a file from
  // the explorer (handleOpenFile): an expanded AI window or group panel
  // covers the whole workspace, so the tab switch behind it would be
  // invisible. Shrink whichever surface is expanded so the newly selected
  // tab takes focus visibly. Guarded so ordinary tab clicks (nothing
  // expanded) don't touch the chat store at all.
  const handleSelectTab = useCallback(
    (id: number) => {
      const s = useChatStore.getState();
      if (s.mini.expanded) s.collapseMini();
      if (s.groupPanelExpanded) s.setGroupPanelExpanded(false);
      setActiveId(id);
    },
    [setActiveId],
  );

  const handlePathRenamed = useCallback(
    (from: string, to: string) => {
      for (const t of tabs) {
        if (t.kind !== "editor") continue;
        if (t.path === from) {
          const i = to.lastIndexOf("/");
          updateTab(t.id, { path: to, title: i === -1 ? to : to.slice(i + 1) });
        } else if (t.path.startsWith(`${from}/`)) {
          const suffix = t.path.slice(from.length);
          const newPath = `${to}${suffix}`;
          const i = newPath.lastIndexOf("/");
          updateTab(t.id, {
            path: newPath,
            title: i === -1 ? newPath : newPath.slice(i + 1),
          });
        }
      }
    },
    [tabs, updateTab],
  );

  const confirmDeleteClose = useCallback(() => {
    if (pendingDeleteTabs !== null) {
      for (const id of pendingDeleteTabs) disposeTab(id);
      setPendingDeleteTabs(null);
    }
  }, [pendingDeleteTabs, disposeTab]);

  const cancelDeleteClose = useCallback(() => {
    setPendingDeleteTabs(null);
  }, []);

  const handlePathDeleted = useCallback(
    (path: string) => {
      const dirty: number[] = [];
      for (const t of tabs) {
        if (t.kind !== "editor") continue;
        if (t.path !== path && !t.path.startsWith(`${path}/`)) continue;
        if (t.dirty) {
          dirty.push(t.id);
        } else {
          disposeTab(t.id);
        }
      }
      if (dirty.length > 0) setPendingDeleteTabs(dirty);
    },
    [tabs, disposeTab],
  );

  const {
    sourceControl,
    activeTerminalLeafCwd,
    activeFilePath,
    workspaceFallbackPath,
    scheduleScRefreshRef,
    handleSourceControlIconClick,
    toggleSourceControl,
    openGitGraphFromContext,
  } = useSourceControlWiring({
    activeTab,
    explorerRoot,
    launchCwd,
    launchCwdResolved,
    home,
    cycleSidebarView,
    openCommitHistoryTab,
  });

  const openPreviewTab = useCallback(
    (url: string) => {
      const id = newPreviewTab(url);
      // Focus the address bar if the URL is empty so the user can type.
      if (!url) {
        setTimeout(() => previewRefs.current.get(id)?.focusAddressBar(), 0);
      }
      return id;
    },
    [newPreviewTab],
  );

  // Intercept link clicks: open in preview tab (localhost only);
  // external URLs go to the system browser.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!isActiveRef.current) return;
      const anchor = (e.target as HTMLElement)?.closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      if (!href.startsWith("http://") && !href.startsWith("https://")) return;
      if ((e.target as HTMLElement)?.closest?.("iframe")) return;

      const isLocal = (() => {
        try {
          const u = new URL(href);
          const h = u.hostname;
          return (
            h === "localhost" ||
            h === "*********" ||
            h === "*******" ||
            h === "*********" ||
            h === "******" ||
            h === "[::1]"
          );
        } catch { return false; }
      })();
      if (isLocal) {
        e.preventDefault();
        e.stopPropagation();
        openPreviewTab(href);
      } else {
        // External URL — open in system browser via Tauri opener plugin.
        e.preventDefault();
        e.stopPropagation();
        void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
          openUrl(href),
        );
      }
    };
    document.addEventListener("click", handler, true);
    const onCustom = (e: Event) => {
      if (!isActiveRef.current) return;
      const url = (e as CustomEvent<string>).detail;
      if (url) openPreviewTab(url);
    };
    window.addEventListener("Kai:open-in-preview", onCustom);
    return () => {
      document.removeEventListener("click", handler, true);
      window.removeEventListener("Kai:open-in-preview", onCustom);
    };
  }, [openPreviewTab]);

  const handleSplitPane = useCallback(
    (dir: "row" | "col") => {
      const t = tabsRef.current.find((x) => x.id === activeId);
      if (t?.kind === "terminal") splitActivePane(activeId, dir);
    },
    [activeId, splitActivePane],
  );
  const handleSplitRight = useCallback(
    () => handleSplitPane("row"),
    [handleSplitPane],
  );
  const handleSplitDown = useCallback(
    () => handleSplitPane("col"),
    [handleSplitPane],
  );

  const handleCloseTabOrPane = useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t?.kind === "terminal" && leafIds(t.paneTree).length > 1) {
      closeActivePane(activeId);
      return;
    }
    handleClose(activeId);
  }, [activeId, closeActivePane, handleClose]);

  const { shortcutsOpen, setShortcutsOpen, newEditorOpen, setNewEditorOpen } =
    useAppShortcuts({
      // Event-time getter (2026-11-02 review FIX 4): a VALUE here froze at
      // body-render time; since the memoized body never re-renders on a
      // switch, shortcuts stayed routed to the pre-switch workspace.
      isActive: () => isActiveRef.current,
      tabsRef,
      activeId,
      openNewTab,
      openNewPrivateTab,
      openPreviewTab,
      closeTabOrPane: handleCloseTabOrPane,
      cycleTab,
      selectByIndex,
      toggleSplitTab,
      splitActivePane,
      focusNextPaneInTab,
      closeActivePane,
      handleClose,
      toggleSourceControl,
      togglePanelAndFocus,
      askFromSelection,
      handleSave,
      handleSaveAll,
      toggleSidebar,
      toggleExplorerFocus,
      searchInlineRef,
      zoomIn,
      zoomOut,
      zoomReset,
    });

  const registerTerminalHandle = useCallback(
    (leafId: number, h: TerminalPaneHandle | null) => {
      if (h) terminalRefs.current.set(leafId, h);
      else terminalRefs.current.delete(leafId);
    },
    [],
  );

  const registerEditorHandle = useCallback(
    (id: number, h: EditorPaneHandle | null) => {
      if (h) editorRefs.current.set(id, h);
      else editorRefs.current.delete(id);
      if (id === activeId) setActiveEditorHandle(h);
    },
    [activeId],
  );

  const registerPreviewHandle = useCallback(
    (id: number, h: PreviewPaneHandle | null) => {
      if (h) previewRefs.current.set(id, h);
      else previewRefs.current.delete(id);
    },
    [],
  );

  const handlePreviewUrl = useCallback(
    (id: number, url: string) => updateTab(id, { url }),
    [updateTab],
  );

  const handleTerminalCwd = useCallback(
    (leafId: number, cwd: string) => setLeafCwd(leafId, cwd),
    [setLeafCwd],
  );

  const handleFocusLeaf = useCallback(
    (tabId: number, leafId: number) => focusPane(tabId, leafId),
    [focusPane],
  );

  // Track rapid respawns to break infinite crash loops. If the shell exits
  // more than 4 times within 3 seconds, stop respawning.
  const respawnTimestamps = useRef<number[]>([]);
  const RESPAWN_WINDOW_MS = 3000;
  const RESPAWN_MAX = 4;

  const handleLeafExit = useCallback(
    (leafId: number, _code: number) => {
      const all = tabsRef.current;
      const tab = all.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (!tab || tab.kind !== "terminal") return;
      const isLast =
        leafIds(tab.paneTree).length === 1 &&
        all.filter((t) => t.kind === "terminal").length === 1;
      if (isLast) {
        const now = Date.now();
        const recent = respawnTimestamps.current.filter(
          (t) => now - t < RESPAWN_WINDOW_MS,
        );
        recent.push(now);
        respawnTimestamps.current = recent;
        if (recent.length > RESPAWN_MAX) {
          console.error(
            `Shell crashed ${recent.length} times in ${RESPAWN_WINDOW_MS}ms — stopping respawn. Check your shell profile.`,
          );
          return;
        }
        void respawnSession(leafId, tab.cwd);
      } else {
        closePaneByLeaf(leafId);
      }
    },
    [closePaneByLeaf],
  );

  const handleEditorDirty = useCallback(
    (id: number, dirty: boolean) => updateTab(id, { dirty }),
    [updateTab],
  );

  const searchTarget = useMemo<SearchTarget>(() => {
    if (isTerminalTab && activeSearchAddon)
      return {
        kind: "terminal",
        addon: activeSearchAddon,
        focus: () => terminalRefs.current.get(activeId)?.focus(),
      };
    if (isEditorTab && activeEditorHandle)
      return {
        kind: "editor",
        handle: activeEditorHandle,
        focus: () => activeEditorHandle.focus(),
      };
    return null;
  }, [isTerminalTab, isEditorTab, activeId, activeSearchAddon, activeEditorHandle]);

  const activeCwd = (() => {
    // Terminal tabs show the live leaf cwd. Everything else (StartPage,
    // editor, preview, no tabs at all) falls back to the project folder —
    // with auto-spawn terminals gone, a bare `activeTerminalLeafCwd` left
    // the breadcrumb on "no directory" whenever no terminal was open.
    if (activeTab?.kind === "terminal") {
      return activeTerminalLeafCwd ?? activeTab.cwd ?? null;
    }
    return explorerRoot ?? workspaceFallbackPath ?? home ?? null;
  })();

  // Most recently active terminal tab — lets agent tools (display_image,
  // "Run edited") target a terminal even when the user is on an editor or
  // preview tab. Updated inside the live-bridge effect below.
  const lastTerminalTabIdRef = useRef<number | null>(null);

  // ACTIVATION MOVED (2026-11-02): the startTransition'd activate() block
  // (setActiveProjectRuntime + session flip + model capture + sandbox root)
  // lives in <WorkspaceActivationGate> now - the body must not subscribe to
  // activation. onActivateLive (passed to the gate) routes back into this
  // body's freshest closures via setLiveRef.
  const onActivateLive = useCallback(() => {
    setSandboxRoot(explorerRoot ?? launchCwd ?? home ?? null);
    setLiveRef.current?.();
  }, [explorerRoot, launchCwd, home]);
  useEffect(() => {
    registerProjectRuntime(projectRuntime);    const findCwd = () => {
      const active = tabs.find((x) => x.id === activeId);
      if (active?.kind === "terminal") {
        return findLeafCwd(active.paneTree, active.activeLeafId) ?? active.cwd ?? null;
      }
      for (let i = tabs.length - 1; i >= 0; i--) {
        const t = tabs[i];
        if (t.kind !== "terminal") continue;
        const cwd = findLeafCwd(t.paneTree, t.activeLeafId) ?? t.cwd;
        if (cwd) return cwd;
      }
      return explorerRoot ?? launchCwd ?? home ?? null;
    };

    // Keep the project sandbox confinement root in sync with the same root
    // tools resolve against — checkSandbox (security.ts) reads it on every
    // fs tool call.
    if (isActiveRef.current) setSandboxRoot(explorerRoot ?? launchCwd ?? home ?? null);

    // Track the most recently active terminal tab for the fallback path in
    // injectIntoActivePty above.
    const activeTab = tabs.find((x) => x.id === activeId);
    if (activeTab?.kind === "terminal") {
      lastTerminalTabIdRef.current = activeTab.id;
    }

    const live = {
      getCwd: findCwd,
      getTerminalContext: () => {
        const t = tabs.find((x) => x.id === activeId);
        if (t?.kind !== "terminal") return null;
        if (t.private) return null;
        const buf = terminalRefs.current.get(t.activeLeafId)?.getBuffer(300);
        return buf ? redactSensitive(buf) : null;
      },
      isActiveTerminalPrivate: () => {
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "terminal" && t.private === true;
      },
      injectIntoActivePty: (text: string) => {
        const isTerminalLike = (
          x: (typeof tabs)[number] | undefined,
        ): x is (typeof tabs)[number] & { activeLeafId: number } =>
          !!x && x.kind === "terminal";
        const active = tabs.find((x) => x.id === activeId);
        const last = tabs.find((x) => x.id === lastTerminalTabIdRef.current);
        const newest = [...tabs].reverse().find((x) => x.kind === "terminal");
        // Prefer the active tab when it's a terminal; otherwise fall back to
        // the most recently active terminal tab (or any terminal) so agent
        // images/commands still land somewhere instead of erroring out.
        const t = isTerminalLike(active)
          ? active
          : isTerminalLike(last)
            ? last
            : isTerminalLike(newest)
              ? newest
              : null;
        if (!t) return false;
        const term = terminalRefs.current.get(t.activeLeafId);
        if (!term) return false;
        term.write(text);
        term.focus();
        return true;
      },
      // DISPLAY write — raw bytes into the xterm parser of the terminal pane,
      // NOT shell stdin. The injector above is the shell-input path (used by
      // approval-run commands); escape sequences like OSC 1337 inline images
      // must be interpreted by the terminal, never typed into the shell.
      writeToActiveTerminalDisplay: (data: string) => {
        const isTerminalLike = (
          x: (typeof tabs)[number] | undefined,
        ): x is (typeof tabs)[number] & { activeLeafId: number } =>
          !!x && x.kind === "terminal";
        const active = tabs.find((x) => x.id === activeId);
        const last = tabs.find((x) => x.id === lastTerminalTabIdRef.current);
        const newest = [...tabs].reverse().find((x) => x.kind === "terminal");
        const t = isTerminalLike(active)
          ? active
          : isTerminalLike(last)
            ? last
            : isTerminalLike(newest)
              ? newest
              : null;
        if (!t) return false;
        const term = terminalRefs.current.get(t.activeLeafId);
        if (!term) return false;
        // No focus steal — displaying an image shouldn't yank keyboard focus.
        term.write(data);
        return true;
      },
      getWorkspaceRoot: () => explorerRoot ?? launchCwd ?? home ?? null,
      getActiveFile: () => {
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "editor" ? t.path : null;
      },
      openPreview: (url: string) => {
        openPreviewTab(url);
        return true;
      },
    };
    setProjectLive(projectRuntime.id, live);
    if (isActiveRef.current) setLive(live);
    setLiveRef.current = () => setLive(live);
  }, [projectRuntime, setLive, activeId, tabs, explorerRoot, launchCwd, home, openPreviewTab]);

  useEffect(() => {
    return () => {
      // Explicit project close, not a visibility switch: only THIS
      // workspace's terminals and sessions are torn down.
      for (const id of liveLeavesRef.current) disposeSession(id);
      for (const session of useChatStore.getState().sessions) {
        if (
          normalizeWorkspacePath(session.workspaceRoot) === normalizeWorkspacePath(projectRuntime.root) &&
          (session.workspaceEnv?.kind ?? "local") === projectRuntime.env.kind &&
          (projectRuntime.env.kind !== "wsl" || session.workspaceEnv?.kind === "wsl" && session.workspaceEnv.distro === projectRuntime.env.distro)
        ) {
          stopSession(session.id);
          void import("@/modules/ai/tools/watch").then(({ reapSessionWatches }) => reapSessionWatches(session.id));
          void projectRuntime.native.shellBgReap(session.id).catch(() => {});
        }
      }
    };
  }, [projectRuntime.root]);

  const fileMenuTrigger = (
    <FileMenu
      activeTab={activeTab}
      dirtyCount={dirtyEditorTabs.length}
      onSave={handleSave}
      onSaveAll={handleSaveAll}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-9 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-0 focus-visible:border-transparent focus:outline-none"
        title="File"
        aria-label="File"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
        </svg>
      </Button>
    </FileMenu>
  );

  const workspaceSurface = (
    <div className="relative h-full min-h-0">
      {tabs.length === 0 && (
        <StartPage
          onNewTerminal={() => newTab(inheritedCwdForNewTab())}
          onNewPrivateTerminal={() => newPrivateTab(inheritedCwdForNewTab())}
          onNewApiTester={() => newApiTesterTab()}
        />
      )}
      <div
        className={cn(
          "absolute inset-0 px-1 pt-1",
          !isTerminalTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isTerminalTab}
      >
        <TerminalStack
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerTerminalHandle}
          onSearchReady={handleSearchReady}
          onCwd={handleTerminalCwd}
          onExit={handleLeafExit}
          onFocusLeaf={handleFocusLeaf}
          onCloseLeaf={closePaneByLeaf}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isEditorTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isEditorTab}
      >
                <EditorStack
                  tabs={tabs}
                  activeId={activeId}
                  registerHandle={registerEditorHandle}
                  onDirtyChange={handleEditorDirty}
                  onSaved={() =>
                    window.dispatchEvent(new Event("Kai:sc-file-change"))
                  }
                  onCloseTab={disposeTab}
                />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isPreviewTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isPreviewTab}
      >
        <PreviewStack
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerPreviewHandle}
          onUrlChange={handlePreviewUrl}
          onCloseTab={disposeTab}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isAiDiffTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isAiDiffTab}
      >
        <AiDiffStack
          tabs={tabs}
          activeId={activeId}
          onAccept={(id) => respondToApproval(id, true)}
          onReject={(id) => respondToApproval(id, false)}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isGitDiffTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isGitDiffTab}
      >
        <GitDiffStack tabs={tabs} activeId={activeId} />
      </div>
      <div
        className={cn(
          "absolute inset-0",
          !isGitHistoryTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isGitHistoryTab}
      >
        <GitHistoryStack
          tabs={tabs}
          activeId={activeId}
          onOpenCommitFile={openCommitFileDiffTab}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isApiTesterTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isApiTesterTab}
      >
        {tabs
          .filter((t) => t.kind === "api-tester")
          .map((t) => (
            <ApiTesterPane key={t.id} visible={t.id === activeId} />
          ))}
      </div>
      {tabs
        .filter((t) => t.kind === "md-preview")
        .map((t) => (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0 px-3 pt-2 pb-2",
              t.id !== activeId && "invisible pointer-events-none",
            )}
            aria-hidden={t.id !== activeId}
          >
            <MarkdownPreviewPane
              path={(t as { path: string }).path}
              visible={t.id === activeId}
            />
          </div>
        ))}
    </div>
  );

  const shell = (
    <ThemeProvider>
      <TooltipProvider>
        <FileMenuTriggerProvider value={fileMenuTrigger}>
        <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
          <ProjectSessionStamp projectRuntime={projectRuntime} />
          <WorkspaceActivationGate
            explorerRoot={explorerRoot}
            launchCwd={launchCwd}
            home={home}
            prefsHydrated={prefsHydrated}
            launchCwdResolved={launchCwdResolved}
            projectName={projectName}
            hydrateSessions={hydrateSessions}
            openProject={(p) => onOpenProjectRef.current(p)}
            getSidebarPx={getSidebarPx}
            writeWorkspaceLeft={writeWorkspaceLeft}
            inputBarRef={inputBarRef}
            inputBarReady={keysLoaded}
            onActivateLive={onActivateLive}
            setLaunchCwd={setLaunchCwd}
            setLaunchCwdResolved={setLaunchCwdResolved}
            setRoot={(cwd) => setRootRef.current(cwd)}
            projectModelIds={projectModelIds}
            prefDefaultModel={prefDefaultModel}
          />
          <ActiveRefSink isActiveRef={isActiveRef} />
          <div className="flex min-h-0 flex-1">
          <ProjectRail
            onSwitch={(id) => projectsMenu?.switchProject(id)}
            onAdd={() => void projectsMenu?.addProject()}
            onNewProject={() => void projectsMenu?.newProject()}
            onClose={(id) => projectsMenu?.closeProject(id)}
          />
          <div className="flex h-full min-w-0 flex-1 flex-col">
          <Header
            tabs={tabs}
            activeId={activeId}
            onSelect={handleSelectTab}
            onNew={openNewTab}
            onNewEditor={() => setNewEditorOpen(true)}
            onNewApiTester={newApiTesterTab}
            onNewPrivate={openNewPrivateTab}
            onClose={handleClose}
            onCloseOthers={handleCloseOthers}
            onPin={pinTab}
            onMove={moveTab}
            onSplitTab={toggleSplitTab}
            splitTabId={splitTabId}
            onToggleSidebar={toggleSidebar}
            onSplit={handleSplitPane}
            onOpenShortcuts={() => setShortcutsOpen(true)}
            searchTarget={searchTarget}
            searchRef={searchInlineRef}
            projectName={projectName}
          />

          <main className="zoom-content flex min-h-0 flex-1 flex-col">
            <ResizablePanelGroup
              orientation="horizontal"
              className="min-h-0 flex-1"
            >
              <ResizablePanel
                id="sidebar"
                panelRef={sidebarRef}
                defaultSize={`${sidebarWidthRef.current}px`}
                minSize={`${SIDEBAR_WIDTH_MIN}px`}
                maxSize={`${SIDEBAR_WIDTH_MAX}px`}
                collapsible
                collapsedSize={0}
                onResize={(size) => {
                  if (size.inPixels > 0) persistSidebarWidth(size.inPixels);
                  setSidebarCollapsed(size.inPixels === 0);
                  // Track the workspace left edge (project rail + sidebar +
                  // handle) for the expanded agent window positioning.
                  // FOREGROUND ONLY: background project panels fire onResize
                  // on mount/resizes of their hidden subtree — an ungated
                  // write raced the var to whichever instance mounted last.
                  if (isActiveRef.current) writeWorkspaceLeft(size.inPixels);
                }}
              >
                <div className="flex h-full min-h-0 flex-col border-r border-border/60 bg-card">
                  <div className="min-h-0 flex-1">
                    {sidebarView === "explorer" ? (
                      <FileExplorer
                        ref={explorerRef}
                        rootPath={explorerRoot}
                        onOpenFile={handleOpenFile}
                        onPathRenamed={handlePathRenamed}
                        onPathDeleted={handlePathDeleted}
                        onRevealInTerminal={cdInNewTab}
                        onAttachToAgent={handleAttachFileToAgent}
                        onPreviewMarkdown={openMarkdownPreview}
                        onOpenPreview={openPreviewTab}
                      />
                    ) : sidebarView === "source-control" ? (
                      <SourceControlPanel
                        open
                        sourceControl={sourceControl}
                        onOpenDiff={openGitDiffTab}
                        onRequestRefresh={scheduleScRefreshRef.current}
                      />
                    ) : (
                      <ExtensionsView />
                    )}
                  </div>
                  <div style={{ height: SIDEBAR_RAIL_HEIGHT }} className="shrink-0">
                    <SidebarRail
                      activeView={sidebarView}
                      onSelectView={handleSourceControlIconClick}
                      changedCount={sourceControl.changedCount}
                      onOpenGitGraph={openGitGraphFromContext}
                    />
                  </div>
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel id="workspace" defaultSize="78%" minSize="30%">
                <div className="flex h-full min-h-0 flex-col">
                  <div className={cn("relative min-h-0 flex-1", sidebarCollapsed && "pl-1")}>
                    {splitTab ? (
                      <ResizablePanelGroup orientation="horizontal" className="h-full">
                        <ResizablePanel id="ws-primary" defaultSize="50%" minSize="20%">
                          {workspaceSurface}
                        </ResizablePanel>
                        <ResizableHandle withHandle />
                        <ResizablePanel id="ws-split" defaultSize="50%" minSize="20%">
                          <div className="relative h-full min-h-0">
                            {/* Close split button */}
                            <button
                              type="button"
                              onClick={closeSplit}
                              className="absolute top-1 right-1 z-10 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                              title="Close split"
                            >
                              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 3l8 8M11 3l-8 8"/></svg>
                            </button>
                            {splitTab.kind === "editor" && (
                              <div className="absolute inset-0 px-3 pt-2 pb-2">
                                <EditorStack
                                  tabs={tabs}
                                  activeId={splitTab.id}
                                  registerHandle={registerEditorHandle}
                                  onDirtyChange={handleEditorDirty}
                                  onSaved={() =>
                                    window.dispatchEvent(new Event("Kai:sc-file-change"))
                                  }
                                  onCloseTab={disposeTab}
                                />
                              </div>
                            )}
                            {splitTab.kind === "md-preview" && (
                              <div className="absolute inset-0 px-3 pt-2 pb-2">
                                <MarkdownPreviewPane
                                  path={(splitTab as { path: string }).path}
                                  visible
                                />
                              </div>
                            )}
                            {splitTab.kind === "preview" && (
                              <div className="absolute inset-0 px-3 pt-2 pb-2">
                                <PreviewStack
                                  tabs={tabs}
                                  activeId={splitTab.id}
                                  projectVisible={true}
                                  registerHandle={registerPreviewHandle}
                                  onUrlChange={handlePreviewUrl}
                                  onCloseTab={disposeTab}
                                />
                              </div>
                            )}
                            {splitTab.kind === "terminal" && (
                              <div className="absolute inset-0 px-1 pt-1 pb-0.5">
                                <TerminalStack
                                  tabs={tabs}
                                  activeId={splitTab.id}
                                  registerHandle={registerTerminalHandle}
                                  onSearchReady={handleSearchReady}
                                  onCwd={handleTerminalCwd}
                                  onExit={handleLeafExit}
                                  onFocusLeaf={handleFocusLeaf}
                                  onCloseLeaf={closePaneByLeaf}
                                />
                              </div>
                            )}
                            {splitTab.kind === "ai-diff" && (
                              <div className="absolute inset-0 px-3 pt-2 pb-2">
                                <AiDiffStack
                                  tabs={tabs}
                                  activeId={splitTab.id}
                                  onAccept={(id) => respondToApproval(id, true)}
                                  onReject={(id) => respondToApproval(id, false)}
                                />
                              </div>
                            )}
                            {splitTab.kind === "api-tester" && (
                              <div className="absolute inset-0 px-3 pt-2 pb-2">
                                <ApiTesterPane visible />
                              </div>
                            )}
                            {(splitTab.kind === "git-diff" || splitTab.kind === "git-commit-file") && (
                              <div className="absolute inset-0 px-3 pt-2 pb-2">
                                <GitDiffStack tabs={tabs} activeId={splitTab.id} />
                              </div>
                            )}
                          </div>
                        </ResizablePanel>
                      </ResizablePanelGroup>
                    ) : (
                      workspaceSurface
                    )}
                  </div>

                  {keysLoaded ? (
                    <motion.div
                      data-ai-input-bar
                      initial={false}
                      animate={{
                        height: panelOpen ? "auto" : 0,
                        opacity: panelOpen ? 1 : 0,
                      }}
                      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                      className="overflow-hidden"
                      aria-hidden={!panelOpen}
                      ref={inputBarRef}
                    >
                      {hasComposer ? (
                        <AiErrorBoundary label="input-bar">
                          <AiInputBar />
                        </AiErrorBoundary>
                      ) : (
                        <AiErrorBoundary label="input-bar-connect">
                          <AiInputBarConnect
                            onAdd={() => void openSettingsWindow("models")}
                          />
                        </AiErrorBoundary>
                      )}
                    </motion.div>
                  ) : null}
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </main>
          </div>
          </div>

          <StatusBar
            cwd={activeCwd}
            filePath={activeFilePath}
            home={home}
            onCd={sendCd}
            onWorkspaceChange={switchWorkspace}
            hasComposer={hasComposer}
            privateActive={
              activeTab?.kind === "terminal" && activeTab.private === true
            }
          />

          {hasComposer ? (
            <AgentRunBridgeGate
              openAiDiffTab={openAiDiffTab}
              closeAiDiffTab={closeAiDiffTab}
            />
          ) : null}

          <AnimatePresence>
            <ActiveSurfaces
              hasComposer={hasComposer}
              miniOpen={miniOpen}
              stackSurface={stackSurface}
              panelOpen={panelOpen}
            />
            {contextMenu ? (
              <CustomContextMenu
                key="custom-context-menu"
                x={contextMenu.x}
                y={contextMenu.y}
                selectionText={contextMenu.selectionText}
                isTerminal={contextMenu.isTerminal}
                editorFormat={
                  contextMenu.editorPath
                    ? {
                        path: contextMenu.editorPath,
                        formattable: isFormattable(contextMenu.editorPath),
                        formatterName: formatterLabelFor(contextMenu.editorPath),
                        onFormat: (selectionOnly) => {
                          const editor = editorRefs.current.get(activeId);
                          if (!editor) return;
                          editor
                            .format(selectionOnly)
                            .catch((err: unknown) => {
                              setFormatMenuError(
                                err instanceof Error ? err.message : String(err),
                              );
                            });
                        },
                      }
                    : undefined
                }
                error={formatMenuError}
                onCopy={handleCopy}
                onPaste={handlePaste}
                onSelectAll={handleSelectAll}
                onClearTerminal={handleClearTerminal}
                onSplitRight={handleSplitRight}
                onSplitDown={handleSplitDown}
                onAskKai={askFromSelection}
                onQuote={
                  contextMenu.quote
                    ? () =>
                        quoteFromTranscript(
                          contextMenu.quote!.text,
                          contextMenu.quote!.author,
                          contextMenu.quote!.groupId ?? undefined,
                        )
                    : undefined
                }
                onDismiss={() => setContextMenu(null)}
              />
            ) : null}
          </AnimatePresence>

          <ShortcutsDialog
            open={shortcutsOpen}
            onOpenChange={setShortcutsOpen}
          />

          <NewEditorDialog
            open={newEditorOpen}
            onOpenChange={setNewEditorOpen}
            rootPath={explorerRoot ?? home}
            onCreated={(path) => openFileTab(path)}
          />

          <UpdaterDialog />

          <AlertDialog
            open={pendingCloseTab !== null}
            onOpenChange={(open) => !open && cancelClose()}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
                <AlertDialogDescription>
                  {tabs.find((t) => t.id === pendingCloseTab)?.title
                    ? `"${
                        tabs.find((t) => t.id === pendingCloseTab)?.title
                      }" has unsaved changes. Close anyway?`
                    : "This file has unsaved changes. Close anyway?"}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={cancelClose}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction onClick={confirmClose}>
                  Close Anyway
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog
            open={pendingCloseOthers !== null}
            onOpenChange={(open) => !open && cancelCloseOthers()}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingCloseOthers?.dirtyIds.length === 1
                    ? `"${
                        tabs.find((t) => t.id === pendingCloseOthers.dirtyIds[0])
                          ?.title ?? "This file"
                      }" has unsaved changes. Close others anyway?`
                    : `${pendingCloseOthers?.dirtyIds.length ?? 0} files have unsaved changes. Close others anyway?`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={cancelCloseOthers}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction onClick={confirmCloseOthers}>
                  Close Others Anyway
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog
            open={pendingProjectOpen !== null}
            onOpenChange={(open) => !open && cancelProjectOpen()}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingProjectOpen?.dirtyIds.length === 1
                    ? `"${
                        tabs.find((t) => t.id === pendingProjectOpen.dirtyIds[0])
                          ?.title ?? "This file"
                      }" has unsaved changes. Open the new project anyway?`
                    : `${pendingProjectOpen?.dirtyIds.length ?? 0} files have unsaved changes. Open the new project anyway?`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={cancelProjectOpen}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction onClick={confirmProjectOpen}>
                  Open Project Anyway
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog
            open={pendingDeleteTabs !== null}
            onOpenChange={(open) => !open && cancelDeleteClose()}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingDeleteTabs?.length === 1
                    ? (() => {
                        const title = tabs.find(
                          (t) => t.id === pendingDeleteTabs[0],
                        )?.title;
                        return title
                          ? `"${title}" has unsaved changes. The file has been deleted. Close anyway?`
                          : "This file has unsaved changes. The file has been deleted. Close anyway?";
                      })()
                    : `${pendingDeleteTabs?.length ?? 0} files have unsaved changes. They have been deleted. Close all anyway?`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={cancelDeleteClose}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction onClick={confirmDeleteClose}>
                  Close Anyway
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        </FileMenuTriggerProvider>
      </TooltipProvider>
    </ThemeProvider>
  );

  return <AiComposerProvider>{shell}</AiComposerProvider>;
});
