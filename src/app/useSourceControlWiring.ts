import { useCallback, useEffect, useRef } from "react";
import { useSourceControl } from "@/modules/source-control";
import type { SidebarViewId } from "@/modules/sidebar";
import { native } from "@/modules/ai/lib/native";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { findLeafCwd } from "@/modules/terminal";
import type { Tab } from "@/modules/tabs";

/**
 * useSourceControlWiring — App.tsx's source-control cluster, extracted
 * 2026-11-10 (god-file cleanup; KAI.md keeps App.tsx a coordinator, so
 * self-contained clusters move out). Everything the panel + rail need:
 * context-path derivation, the explicit-refresh machinery, and the
 * user-action handlers.
 *
 * The panel-blink and context-settle contracts are pinned by
 * src/modules/source-control/useSourceControl.test.ts — the
 * "Explicit refresh triggers" comment is its slice anchor; keep it above
 * the handler block.
 */

function dirname(path: string): string {
  const norm = path.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx > 0 ? norm.slice(0, idx) : norm;
}

export function useSourceControlWiring(args: {
  activeTab: Tab | undefined;
  explorerRoot: string | null;
  launchCwd: string | null;
  launchCwdResolved: boolean;
  home: string | null;
  cycleSidebarView: (view: SidebarViewId) => void;
  openCommitHistoryTab: (t: {
    repoRoot: string;
    branch: string;
  }) => void;
}) {
  const {
    activeTab,
    explorerRoot,
    launchCwd,
    launchCwdResolved,
    home,
    cycleSidebarView,
    openCommitHistoryTab,
  } = args;

  const activeTerminalLeafCwd =
    activeTab?.kind === "terminal"
      ? (findLeafCwd(activeTab.paneTree, activeTab.activeLeafId) ??
        activeTab.cwd ??
        null)
      : null;

  const activeFilePath = (() => {
    if (activeTab?.kind === "editor") return activeTab.path;
    if (activeTab?.kind === "git-diff") {
      if (/^([A-Za-z]:|\/|\\)/.test(activeTab.path)) return activeTab.path;
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    if (activeTab?.kind === "git-commit-file") {
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    return null;
  })();

  const workspaceFallbackPath = launchCwdResolved
    ? (launchCwd ?? home ?? null)
    : null;

  const sourceControlContextPath = (() => {
    // For git-related tabs, always use the repo root directly.
    if (activeTab?.kind === "git-diff") return activeTab.repoRoot;
    if (activeTab?.kind === "git-commit-file") return activeTab.repoRoot;
    if (activeTab?.kind === "git-history") return activeTab.repoRoot;
    // For editor tabs, use the file's directory.
    if (activeTab?.kind === "editor") return dirname(activeTab.path);
    // For terminal tabs, prefer the leaf's tracked cwd, then the tab's
    // initial cwd, then the explorer root (workspace). workspaceFallbackPath
    // (home dir) is last resort - it's usually not inside a repo.
    if (activeTab?.kind === "terminal") {
      return activeTerminalLeafCwd ?? activeTab.cwd ?? explorerRoot ?? workspaceFallbackPath;
    }
    // No active tab: use explorer root (which tracks the workspace).
    return explorerRoot ?? workspaceFallbackPath;
  })();

  // The rail badge and the panel must read the SAME git context. Resolving
  // the badge against a pinned launch dir while the panel follows the active
  // tab's live context made the icon count diverge from what the panel showed
  // when opened (e.g. badge counted the launch repo while the terminal had
  // `cd`'d into a different, clean repo). Resolve the active context once and
  // share it between both surfaces.
  const sourceControlPath = sourceControlContextPath;

  // Automatically authorize standard workspaces/folders in the Rust registry
  // when the user explicitly navigates to them (via terminal cd, active file tab, etc.)
  useEffect(() => {
    if (sourceControlPath) {
      void native.workspaceAuthorize(sourceControlPath).catch((err) => {
        console.error("Auto-authorizing source control path failed:", err);
      });
    }
  }, [sourceControlPath]);

  const sourceControl = useSourceControl(sourceControlPath, true);

  // == Explicit refresh triggers (user request: no background blinking) ==
  // The panel used to refresh on mount, on every window FOCUS, and on every
  // editor save / finished terminal command - a wall of background git calls
  // that visibly blinked the panel ("trying to refresh and check state").
  // Now it refreshes ONLY when the user asks for it:
  //   1. the panel is clicked into (focus / any pointerdown inside it),
  //   2. the Source Control rail icon is clicked (even when the panel is
  //      already open), or
  //   3. the panel's Refresh icon is clicked.
  // Plus the one automatic refresh that must survive: a change of the git
  // CONTEXT (terminal `cd` into another repo / switching projects) must
  // re-resolve, or the panel would show the old repo forever. That refresh is
  // local-only (remote: "never" - no network), so it cannot blink a sync.
  // The boot-time first load also runs once (idle-scheduled) so the rail
  // badge is populated on startup.
  const manualScRefreshRef = useRef(sourceControl.refresh);
  manualScRefreshRef.current = sourceControl.refresh;
  const scheduleScRefresh = useCallback(() => {
    // Debounced (not per-event): a save+command burst fires ONE refresh.
    let timer = 0;
    return () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        void manualScRefreshRef.current({ remote: "never" });
      }, 250);
    };
  }, []);
  const scheduleScRefreshRef = useRef(scheduleScRefresh());
  scheduleScRefreshRef.current = scheduleScRefresh();

  // Rail icon click = switch to (or collapse) the Source Control view AND
  // an explicit refresh request - the user is asking to look at git state.
  const handleSourceControlIconClick = useCallback(
    (view: SidebarViewId) => {
      cycleSidebarView(view);
      if (view === "source-control") {
        void manualScRefreshRef.current({ remote: "auto" });
      }
    },
    [cycleSidebarView],
  );

  // Context-switch refreshes: re-resolve the repo when the git context
  // (active tab cwd / project) changes - local-only, no network fetch, so
  // it cannot produce the syncing blink. Keyed on the settled path.
  useEffect(() => {
    if (sourceControl.repo) return; // already resolved for this context
    void manualScRefreshRef.current({ remote: "never" });
  }, [sourceControl.repo, sourceControlPath]);

  const toggleSourceControl = useCallback(() => {
    cycleSidebarView("source-control");
  }, [cycleSidebarView]);

  const openGitGraphFromContext = useCallback(async () => {
    // Resolve the repo from the CURRENT project root on every click. We
    // intentionally do NOT read `sourceControl.repo` here: that cache tracks
    // the active tab's live context (a terminal `cd` re-keys it), which is
    // not necessarily the project the user means by "Git Graph". Resolve from
    // the pinned root so the graph always opens the current project, never a
    // transient terminal cwd.
    //
    // Project root is stable: explorerRoot is pinned at launch / on
    // File > Open Project and does NOT follow terminal cd. So we resolve
    // from the pinned root, never from the terminal's live cwd (the user may
    // have cd'd into a subdir or elsewhere - the project is still the root).
    const contextPath = explorerRoot ?? sourceControlContextPath;
    if (!contextPath) return;
    try {
      const repo = await native.gitResolveRepo(contextPath);
      if (!repo) return;
      // Same visibility rule as handleOpenFile (App.tsx): an expanded AI
      // window or group panel covers the whole workspace, so the newly
      // opened Git Graph tab would be invisible behind it. Shrink
      // whichever surface is expanded before opening the tab.
      const s = useChatStore.getState();
      if (s.mini.expanded) s.collapseMini();
      if (s.groupPanelExpanded) s.setGroupPanelExpanded(false);
      openCommitHistoryTab({ repoRoot: repo.repoRoot, branch: repo.branch });
    } catch {
      /* noop */
    }
  }, [
    openCommitHistoryTab,
    explorerRoot,
    sourceControlContextPath,
  ]);

  return {
    sourceControl,
    sourceControlPath,
    activeTerminalLeafCwd,
    activeFilePath,
    workspaceFallbackPath,
    scheduleScRefreshRef,
    handleSourceControlIconClick,
    toggleSourceControl,
    openGitGraphFromContext,
  };
}
