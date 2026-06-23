import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { invoke } from "@tauri-apps/api/core";
import { WindowControls } from "@/components/WindowControls";
import { IS_MAC, KEY_SEP, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  getBindingTokens,
  SHORTCUTS,
  type ShortcutId,
} from "@/modules/shortcuts/shortcuts";
import type { Tab } from "@/modules/tabs";
import { TabBar } from "@/modules/tabs";
import {
  FloppyDiskIcon,
  GridViewIcon,
  KeyboardIcon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  SearchInline,
  type SearchInlineHandle,
  type SearchTarget,
} from "./SearchInline";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
  onNew: () => void;
  onNewPrivate: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onNewApiTester: () => void;
  onClose: (id: number) => void;
  /** Promote a preview (transient) tab to persistent. */
  onPin: (id: number) => void;
  onToggleSidebar: () => void;
  onSplit: (dir: "row" | "col") => void;
  /** Active tab is a terminal and below the per-tab pane cap. */
  canSplit: boolean;
  onOpenShortcuts: () => void;
  searchTarget: SearchTarget;
  searchRef: RefObject<SearchInlineHandle | null>;
  onOpenProject: (path: string) => void;
  onSave: () => void;
  onSaveAll: () => void;
  /** Number of editor tabs with unsaved changes. */
  dirtyCount: number;
};

const COMPACT_WIDTH = 720;

export function Header({
  tabs,
  activeId,
  onSelect,
  onNew,
  onNewPrivate,
  onNewPreview,
  onNewEditor,
  onNewApiTester,
  onClose,
  onPin,
  onToggleSidebar,
  onSplit,
  canSplit,
  onOpenShortcuts,
  searchTarget,
  searchRef,
  onOpenProject,
  onSave,
  onSaveAll,
  dirtyCount,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);
  const recentProjects = usePreferencesStore((s) => s.recentProjects) || [];
  const activeTab = tabs.find((t) => t.id === activeId);

  const handleOpenProject = async () => {
    try {
      const selected = await invoke<string | null>("pick_project_folder");
      if (selected) {
        onOpenProject(selected);
      }
    } catch (e) {
      console.error("Open project failed:", e);
    }
  };

  const handleNewProject = async () => {
    try {
      const parentDir = await invoke<string | null>("pick_project_folder");
      if (!parentDir) return;

      const name = window.prompt("Enter new Project / Folder Name:");
      if (!name || !name.trim()) return;

      const cleanName = name.trim();
      const nextPath = parentDir.endsWith("/")
        ? `${parentDir}${cleanName}`
        : `${parentDir}/${cleanName}`;

      await invoke("fs_create_dir", { path: nextPath });
      onOpenProject(nextPath);
    } catch (e) {
      window.alert(`Failed to create project: ${String(e)}`);
    }
  };

  const tokensFor = (id: ShortcutId): string => {
    const s = SHORTCUTS.find((s) => s.id === id);
    if (!s) return "";
    const bindings = userShortcuts[id] || s.defaultBindings;
    if (!bindings || bindings.length === 0) return "";
    return getBindingTokens(bindings[0]).join(KEY_SEP);
  };

  const shortcutLabel = useMemo(() => {
    const tokens = tokensFor("shortcuts.open");
    return tokens ? `Keyboard shortcuts (${tokens})` : "Keyboard shortcuts";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userShortcuts]);

  const splitRightTokens = tokensFor("pane.splitRight");
  const splitDownTokens = tokensFor("pane.splitDown");

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setCompact(w < COMPACT_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shortcutsButton = (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={onOpenShortcuts}
      title={shortcutLabel}
    >
      <HugeiconsIcon icon={KeyboardIcon} size={16} strokeWidth={1.75} />
    </Button>
  );


  return (
    <div
      ref={rootRef}
      data-tauri-drag-region
      className={`flex h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-card select-none ${
        IS_MAC ? "pr-2 pl-20" : "pr-0 pl-2"
      }`}
    >
      <div className="flex shrink-0 items-center gap-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-0 focus-visible:border-transparent focus:outline-none"
              title="File"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
              </svg>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-52">
            <DropdownMenuItem onSelect={handleNewProject} className="gap-2 text-xs">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/80">
                <path d="M1.5 3.5a1.5 1.5 0 011.5-1.5h3.5l2 2h6a1.5 1.5 0 011.5 1.5v7a1.5 1.5 0 01-1.5 1.5h-11a1.5 1.5 0 01-1.5-1.5v-9z" />
                <path d="M8 7v4M6 9h4" />
              </svg>
              <span className="flex-1 font-medium">New Project</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleOpenProject} className="gap-2 text-xs">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/80">
                <path d="M1.5 3.5a1.5 1.5 0 011.5-1.5h3.5l2 2h6a1.5 1.5 0 011.5 1.5v7a1.5 1.5 0 01-1.5 1.5h-11a1.5 1.5 0 01-1.5-1.5v-9z" />
              </svg>
              <span className="flex-1 font-medium">Open Project</span>
            </DropdownMenuItem>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="gap-2 text-xs">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/80">
                  <circle cx="8" cy="8" r="6.5" />
                  <path d="M8 4.5V8l2.5 2" />
                </svg>
                <span className="flex-1 font-medium">Recent</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-64 max-w-sm">
                {recentProjects.length > 0 ? (
                  recentProjects.map((path) => (
                    <DropdownMenuItem
                      key={path}
                      onSelect={() => onOpenProject(path)}
                      className="text-xs truncate font-mono"
                      title={path}
                    >
                      {path.split("/").pop() || path}
                      <span className="ml-2 text-[10px] text-muted-foreground/50 truncate">
                        {path}
                      </span>
                    </DropdownMenuItem>
                  ))
                ) : (
                  <DropdownMenuItem disabled className="text-xs text-muted-foreground/70">
                    No Recent Projects
                  </DropdownMenuItem>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!activeTab || activeTab.kind !== "editor" || !activeTab.dirty}
              onSelect={onSave}
              className="gap-2 text-xs"
            >
              <HugeiconsIcon icon={FloppyDiskIcon} size={13} strokeWidth={1.75} className="text-muted-foreground/80" />
              <span className="flex-1">Save</span>
              <span className="text-[10px] text-muted-foreground/60 font-mono">
                {IS_MAC ? "⌘S" : "Ctrl+S"}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={dirtyCount < 2}
              onSelect={onSaveAll}
              className="gap-2 text-xs"
            >
              <HugeiconsIcon icon={FloppyDiskIcon} size={13} strokeWidth={1.75} className="text-muted-foreground/80" />
              <span className="flex-1">Save All</span>
              <span className="text-[10px] text-muted-foreground/60 font-mono">
                {IS_MAC ? "⌘⇧S" : "Ctrl+Shift+S"}
              </span>
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void openSettingsWindow("models&isolate=true")} className="gap-2 text-xs">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/80">
                <path d="M8 1.5c-3 0-5.5 2-5.5 5s2 4.5 2 4.5l.5.5h6l.5-.5s2-1.5 2-4.5-2.5-5-5.5-5z" />
                <path d="M5.5 14h5M6.5 11.5v2.5M9.5 11.5v2.5" />
              </svg>
              <span className="flex-1">Models</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void openSettingsWindow("agents&isolate=true")} className="gap-2 text-xs">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/80">
                <rect x="3.5" y="3.5" width="9" height="9" rx="2" />
                <path d="M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2" />
              </svg>
              <span className="flex-1">Agents</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void openSettingsWindow("snippets&isolate=true")} className="gap-2 text-xs">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/80">
                <path d="M4 2.5l8 5.5-8 5.5z" />
              </svg>
              <span className="flex-1">Snippets</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void openSettingsWindow("mcp&isolate=true")} className="gap-2 text-xs">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/80">
                <path d="M10 1a2 2 0 00-2 2v1h-.5a1.5 1.5 0 00-1.5 1.5V6H4v-.5a1.5 1.5 0 00-3 0V7a1.5 1.5 0 001.5 1.5H4v1.5a1.5 1.5 0 001.5 1.5h1.5l2 2h3a2 2 0 002-2v-1.5h1.5a1.5 1.5 0 000-3H14V5.5A1.5 1.5 0 0012.5 4H12V3a2 2 0 00-2-2z" />
              </svg>
              <span className="flex-1">MCP Servers</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void openSettingsWindow("shortcuts&isolate=true")} className="gap-2 text-xs">
              <HugeiconsIcon icon={KeyboardIcon} size={13} strokeWidth={1.75} className="text-muted-foreground/80" />
              <span className="flex-1">Shortcuts</span>
              <span className="text-[10px] text-muted-foreground/60 font-mono">
                {IS_MAC ? "⌘/" : "Ctrl+/"}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void openSettingsWindow("general&isolate=true")} className="gap-2 text-xs">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/80">
                <circle cx="8" cy="8" r="3.5" />
                <path d="M8 1.5v1M8 13.5v1M1.5 8h1M13.5 8h1M3.4 3.4l.7.7M12.6 12.6l.7.7M3.4 12.6l.7-.7M12.6 3.4l.7-.7" />
              </svg>
              <span className="flex-1">Appearance</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void openSettingsWindow("about&isolate=true")} className="gap-2 text-xs">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/80">
                <circle cx="8" cy="8" r="6.5" />
                <path d="M8 11V8M8 5h.01" />
              </svg>
              <span className="flex-1">About</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="h-4 w-px shrink-0 bg-border/60 mx-0.5" />

        <Button
          onClick={onToggleSidebar}
          title="Toggle sidebar"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={SidebarLeftIcon} size={18} strokeWidth={1.75} />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50 focus-visible:ring-0 focus-visible:border-transparent focus:outline-none"
              title="Split terminal"
              disabled={!canSplit}
            >
              <HugeiconsIcon icon={GridViewIcon} size={16} strokeWidth={1.75} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuItem onSelect={() => onSplit("row")}>
              <HugeiconsIcon
                icon={LayoutTwoColumnIcon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Split right</span>
              {splitRightTokens && (
                <span className="text-xs text-muted-foreground">
                  {splitRightTokens}
                </span>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onSplit("col")}>
              <HugeiconsIcon
                icon={LayoutTwoRowIcon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Split down</span>
              {splitDownTokens && (
                <span className="text-xs text-muted-foreground">
                  {splitDownTokens}
                </span>
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

      </div>

      {!IS_MAC && <span className="mx-1 h-5 w-px shrink-0 bg-border" />}

      {IS_MAC && <span className="mr-1 h-full w-px shrink-0 bg-border" />}

      <div
        className="flex min-w-0 flex-1 items-center gap-2"
        data-tauri-drag-region
      >
        <TabBar
          tabs={tabs}
          activeId={activeId}
          onSelect={onSelect}
          onNew={onNew}
          onNewPrivate={onNewPrivate}
          onNewPreview={onNewPreview}
          onNewEditor={onNewEditor}
          onNewApiTester={onNewApiTester}
          onClose={onClose}
          onPin={onPin}
          compact={compact}
        />
        <div data-tauri-drag-region className="h-full min-w-2 flex-1" />
      </div>

      <SearchInline ref={searchRef} target={searchTarget} compact={compact} />

      {shortcutsButton}

      {USE_CUSTOM_WINDOW_CONTROLS && (
        <>
          <span className="ml-1 h-5 w-px shrink-0 bg-border" />
          <WindowControls />
        </>
      )}
    </div>
  );
}
