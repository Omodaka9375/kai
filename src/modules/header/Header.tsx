import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { FloppyDiskIcon, KeyboardIcon, SidebarLeftIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
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
  onNewEditor: () => void;
  onNewApiTester: () => void;
  onNewPrivate: () => void;
  onClose: (id: number) => void;
  onCloseOthers: (id: number) => void;
  onPin: (id: number) => void;
  onMove: (dragId: number, hoverId: number) => void;
  onSplitTab: (id: number) => void;
  splitTabId: number | null;
  onToggleSidebar: () => void;
  onSplit: (dir: "row" | "col") => void;
  onOpenShortcuts: () => void;
  searchTarget: SearchTarget;
  searchRef: RefObject<SearchInlineHandle | null>;
  projectName: string | null;
};

type FileMenuProps = {
  onSave: () => void;
  onSaveAll: () => void;
  dirtyCount: number;
  activeTab?: Tab;
  children: ReactNode;
};

const COMPACT_WIDTH = 720;

/** The rail supplies the trigger; the active project supplies these actions. */
export function FileMenu({
  onSave,
  onSaveAll,
  dirtyCount,
  activeTab,
  children,
}: FileMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuItem disabled={!activeTab || activeTab.kind !== "editor" || !activeTab.dirty} onSelect={onSave} className="text-xs">
          <HugeiconsIcon icon={FloppyDiskIcon} size={13} strokeWidth={1.75} />
          Save <span className="ml-auto text-[10px] text-muted-foreground/60">{IS_MAC ? "⌘S" : "Ctrl+S"}</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={dirtyCount < 2} onSelect={onSaveAll} className="text-xs">
          <HugeiconsIcon icon={FloppyDiskIcon} size={13} strokeWidth={1.75} />
          Save All <span className="ml-auto text-[10px] text-muted-foreground/60">{IS_MAC ? "⌘⇧S" : "Ctrl+Shift+S"}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void openSettingsWindow("general")} className="text-xs">General</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void openSettingsWindow("models")} className="text-xs">Models</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void openSettingsWindow("agents")} className="text-xs">Agents</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void openSettingsWindow("snippets")} className="text-xs">Snippets</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void openSettingsWindow("mcp")} className="text-xs">MCP Servers</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void openSettingsWindow("sandbox")} className="text-xs">Sandbox</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void openSettingsWindow("security")} className="text-xs">Security</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void openSettingsWindow("voice")} className="text-xs">Voice</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void openSettingsWindow("assistant")} className="text-xs">Assistant</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void openSettingsWindow("shortcuts")} className="text-xs">Shortcuts</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void openSettingsWindow("about")} className="text-xs">About</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Header({
  tabs,
  activeId,
  onSelect,
  onNew,
  onNewEditor,
  onNewApiTester,
  onNewPrivate,
  onClose,
  onCloseOthers,
  onPin,
  onMove,
  onSplitTab,
  splitTabId,
  onToggleSidebar,
  onSplit,
  onOpenShortcuts,
  searchTarget,
  searchRef,
  projectName,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);

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

  return (
    <div
      ref={rootRef}
      data-tauri-drag-region
      className={`flex h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-card select-none ${
        IS_MAC ? "pr-2 pl-20" : "pr-0 pl-2"
      }`}
    >
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          onClick={onToggleSidebar}
          title="Toggle sidebar"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={SidebarLeftIcon} size={18} strokeWidth={1.75} />
        </Button>
        {projectName && !compact && (
          <span className="ml-1 max-w-[180px] truncate text-xs font-medium text-muted-foreground" title={projectName}>
            {projectName}
          </span>
        )}
      </div>
      {!IS_MAC && <span className="mx-1 h-5 w-px shrink-0 bg-border" />}
      {IS_MAC && <span className="mr-1 h-full w-px shrink-0 bg-border" />}
      <div className="flex min-w-0 flex-1 items-center gap-2" data-tauri-drag-region>
        <TabBar
          tabs={tabs}
          activeId={activeId}
          onSelect={onSelect}
          onNew={onNew}
          onNewEditor={onNewEditor}
          onNewApiTester={onNewApiTester}
          onNewPrivate={onNewPrivate}
          onClose={onClose}
          onCloseOthers={onCloseOthers}
          onPin={onPin}
          onMove={onMove}
          onSplitTab={onSplitTab}
          splitTabId={splitTabId}
          onSplitPane={onSplit}
          compact={compact}
        />
        <div data-tauri-drag-region className="h-full min-w-2 flex-1" />
      </div>
      <SearchInline ref={searchRef} target={searchTarget} compact={compact} />
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={onOpenShortcuts}
        title={shortcutLabel}
      >
        <HugeiconsIcon icon={KeyboardIcon} size={16} strokeWidth={1.75} />
      </Button>
      {USE_CUSTOM_WINDOW_CONTROLS && (
        <>
          <span className="ml-1 h-5 w-px shrink-0 bg-border" />
          <WindowControls />
        </>
      )}
    </div>
  );
}
