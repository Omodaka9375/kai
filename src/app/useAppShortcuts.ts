import { useCallback, useMemo, useState, type RefObject } from "react";
import {
  useGlobalShortcuts,
  type ShortcutHandlers,
} from "@/modules/shortcuts";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import type { SearchInlineHandle } from "@/modules/header";
import type { Tab } from "@/modules/tabs";

/**
 * Wires the global keymap to App-level actions. Lives in `src/app/` (not
 * the shortcuts module) because every handler closes over App state —
 * moving it into `modules/shortcuts` would create a cross-module cycle.
 */
export type AppShortcutDeps = {
  tabsRef: RefObject<Tab[]>;
  activeId: number;
  // Tabs
  openNewTab: () => void;
  openNewPrivateTab: () => void;
  openPreviewTab: (url: string) => void;
  closeTabOrPane: () => void;
  cycleTab: (delta: 1 | -1) => void;
  selectByIndex: (index: number) => void;
  toggleSplitTab: (tabId: number) => void;
  // Panes
  splitActivePane: (tabId: number, dir: "row" | "col") => void;
  focusNextPaneInTab: (tabId: number, delta: 1 | -1) => void;
  closeActivePane: (tabId: number) => void;
  handleClose: (tabId: number) => void;
  // Panels / UI
  toggleSourceControl: () => void;
  togglePanelAndFocus: () => void;
  askFromSelection: () => void;
  handleSaveAll: () => void;
  toggleSidebar: () => void;
  toggleExplorerFocus: () => void;
  searchInlineRef: RefObject<SearchInlineHandle | null>;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
};

export function useAppShortcuts(deps: AppShortcutDeps): {
  shortcutsOpen: boolean;
  setShortcutsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  newEditorOpen: boolean;
  setNewEditorOpen: React.Dispatch<React.SetStateAction<boolean>>;
} {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [newEditorOpen, setNewEditorOpen] = useState(false);

  const {
    tabsRef,
    activeId,
    openNewTab,
    openNewPrivateTab,
    openPreviewTab,
    closeTabOrPane,
    cycleTab,
    selectByIndex,
    toggleSplitTab,
    splitActivePane,
    focusNextPaneInTab,
    toggleSourceControl,
    togglePanelAndFocus,
    askFromSelection,
    handleSaveAll,
    toggleSidebar,
    toggleExplorerFocus,
    searchInlineRef,
    zoomIn,
    zoomOut,
    zoomReset,
  } = deps;

  const splitActivePaneInActiveTab = useCallback(
    (dir: "row" | "col") => {
      const t = tabsRef.current.find((x) => x.id === activeId);
      if (!t || t.kind !== "terminal") return;
      splitActivePane(activeId, dir);
    },
    [tabsRef, activeId, splitActivePane],
  );

  const handlers = useMemo<ShortcutHandlers>(
    () => ({
      "tab.new": openNewTab,
      "tab.newPrivate": openNewPrivateTab,
      "tab.newPreview": () => openPreviewTab(""),
      "tab.newEditor": () => setNewEditorOpen(true),
      "tab.close": closeTabOrPane,
      "tab.next": () => cycleTab(1),
      "tab.prev": () => cycleTab(-1),
      "tab.selectByIndex": (e) => selectByIndex(parseInt(e.key, 10) - 1),
      "pane.splitRight": () => {
        const t = tabsRef.current.find((x) => x.id === activeId);
        if (t?.kind === "terminal") {
          splitActivePaneInActiveTab("row");
        } else if (t) {
          // Non-terminal: open as workspace split
          toggleSplitTab(t.id);
        }
      },
      "pane.splitDown": () => splitActivePaneInActiveTab("col"),
      "pane.focusNext": () => focusNextPaneInTab(activeId, 1),
      "pane.focusPrev": () => focusNextPaneInTab(activeId, -1),
      "pane.source": toggleSourceControl,
      "search.focus": () => searchInlineRef.current?.focus(),
      "search.replace": () => searchInlineRef.current?.focusReplace(),
      "ai.toggle": togglePanelAndFocus,
      "ai.askSelection": askFromSelection,
      "editor.saveAll": handleSaveAll,
      "shortcuts.open": () => setShortcutsOpen((v) => !v),
      "settings.open": () => void openSettingsWindow(),
      "sidebar.toggle": toggleSidebar,
      "explorer.focus": toggleExplorerFocus,
      "view.zoomIn": zoomIn,
      "view.zoomOut": zoomOut,
      "view.zoomReset": zoomReset,
    }),
    [
      activeId,
      tabsRef,
      openNewTab,
      openNewPrivateTab,
      openPreviewTab,
      closeTabOrPane,
      cycleTab,
      selectByIndex,
      toggleSplitTab,
      splitActivePaneInActiveTab,
      focusNextPaneInTab,
      toggleSourceControl,
      togglePanelAndFocus,
      askFromSelection,
      handleSaveAll,
      toggleSidebar,
      toggleExplorerFocus,
      searchInlineRef,
      zoomIn,
      zoomOut,
      zoomReset,
    ],
  );

  useGlobalShortcuts(handlers);

  return { shortcutsOpen, setShortcutsOpen, newEditorOpen, setNewEditorOpen };
}
