import type { Tab } from "@/modules/tabs";
import type { SearchAddon } from "@xterm/addon-search";
import { useEffect, useMemo, useRef } from "react";
import { useWorkspaceActive } from "@/modules/workspace";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { useProjectChatGridStore } from "@/modules/ai/store/projectChatGrid";
import { PaneTreeView } from "./PaneTreeView";
import type { TerminalPaneHandle } from "./TerminalPane";
import { leafIds } from "./lib/panes";

type Props = {
  tabs: Tab[];
  activeId: number;
  /** DEPRECATED (2026-11-02): activation moved to WorkspaceActiveContext.
   *  NO DEFAULT: a `= true` default made `projectVisible ?? workspaceActive`
   *  dead code, so background workspaces kept inline visibility:visible +
   *  pointerEvents:auto on their active panes - which OVERRODE the
   *  AppShell wrapper's invisible/pointer-events-none (ghost paint + click
   *  capture). Only the split-pane caller passes an explicit value. */
  projectVisible?: boolean;
  /** Register/unregister handle by leaf id (not tab id). */
  registerHandle: (leafId: number, handle: TerminalPaneHandle | null) => void;
  onSearchReady: (leafId: number, addon: SearchAddon) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
  onFocusLeaf: (tabId: number, leafId: number) => void;
  onCloseLeaf?: (leafId: number) => void;
};

type Bundle = {
  setRef: (h: TerminalPaneHandle | null) => void;
  onSearch: (addon: SearchAddon) => void;
  onCwd: (cwd: string) => void;
  onExit: (code: number) => void;
};

export function TerminalStack({
  tabs,
  activeId,
  projectVisible,
  registerHandle,
  onSearchReady,
  onCwd,
  onExit,
  onFocusLeaf,
  onCloseLeaf,
}: Props) {
  // ACTIVATION SUBSCRIPTION (2026-11-02 switch-lag round 2): the stack
  // itself is tiny (a map over tab wrappers) but its children hold every
  // xterm pane — subscribing HERE keeps a project switch from reconciling
  // the whole workspace while still flipping the visibility classes.
  const workspaceActive = useWorkspaceActive();
  const projectActive = projectVisible ?? workspaceActive;

  // FULL-WORKSPACE OVERLAY OCCLUSION (2026-11-22 report: "When AI window is
  // expanded or I'm in Workspaces I can see terminal text leaking from
  // behind — only when terminal tabs are open"):
  //   1. Workspaces grid: covers the entire post-header area, but left the
  //      foreground project's active terminal visibility:visible underneath,
  //      so xterm text bled through the 8px outer margin, 8px card gaps,
  //      translucent borders, and bg-background/95 card bodies.
  //   2. Expanded AI window / expanded group panel: positioned at
  //      left: calc(--kai-workspace-left + 8px), top: 2.85rem (45.6px) over a
  //      40px header, right-2 — while TerminalStack starts at px-1 pt-1
  //      (4px/4px). That leaves a 4px left strip, ~5.6px top strip, and 8px
  //      right strip where the live terminal sits completely outside the
  //      expanded window and its AiWindowBackdrop.
  // Folding these three full-workspace overlay states into `tabVisible`
  // flips the active terminal pane to visibility:hidden while fully covered
  // (PTY keeps streaming via useTerminalSession; nothing is unmounted).
  // Docked (non-expanded) mini window is unaffected — the terminal alongside
  // it stays visible.
  const gridOpen = useProjectChatGridStore((s) => s.open);
  const aiOverlayExpanded = useChatStore((s) =>
    s.stackRail.surface === "group"
      ? s.groupPanelExpanded
      : s.mini.open && s.mini.expanded,
  );
  const occludedByOverlay = gridOpen || aiOverlayExpanded;

  const terminals = useMemo(
    () => tabs.filter((t) => t.kind === "terminal"),
    [tabs],
  );

  const registerRef = useRef(registerHandle);
  const searchReadyRef = useRef(onSearchReady);
  const cwdRef = useRef(onCwd);
  const exitRef = useRef(onExit);
  useEffect(() => {
    registerRef.current = registerHandle;
  }, [registerHandle]);
  useEffect(() => {
    searchReadyRef.current = onSearchReady;
  }, [onSearchReady]);
  useEffect(() => {
    cwdRef.current = onCwd;
  }, [onCwd]);
  useEffect(() => {
    exitRef.current = onExit;
  }, [onExit]);

  const bundles = useRef(new Map<number, Bundle>());
  const getBundle = (leafId: number): Bundle => {
    let b = bundles.current.get(leafId);
    if (!b) {
      b = {
        setRef: (h) => registerRef.current(leafId, h),
        onSearch: (addon) => searchReadyRef.current(leafId, addon),
        onCwd: (cwd) => cwdRef.current(leafId, cwd),
        onExit: (code) => exitRef.current(leafId, code),
      };
      bundles.current.set(leafId, b);
    }
    return b;
  };

  useEffect(() => {
    const live = new Set<number>();
    for (const t of terminals) for (const id of leafIds(t.paneTree)) live.add(id);
    for (const id of bundles.current.keys()) {
      if (!live.has(id)) bundles.current.delete(id);
    }
  }, [terminals]);

  return (
    <div className="relative h-full w-full">
      {terminals.map((t) => {
        const tabVisible =
          projectActive && !occludedByOverlay && t.id === activeId;
        return (
          <div
            key={t.id}
            className="absolute inset-0"
            style={{
              visibility: tabVisible ? "visible" : "hidden",
              pointerEvents: tabVisible ? "auto" : "none",
            }}
            aria-hidden={!tabVisible}
          >
            <PaneTreeView
              node={t.paneTree}
              tabVisible={tabVisible}
              activeLeafId={t.activeLeafId}
              totalLeaves={leafIds(t.paneTree).length}
              onFocusLeaf={(leafId) => onFocusLeaf(t.id, leafId)}
              onCloseLeaf={(leafId) => onCloseLeaf?.(leafId)}
              getBundle={getBundle}
            />
          </div>
        );
      })}
    </div>
  );
}
