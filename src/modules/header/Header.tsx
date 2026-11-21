import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WindowControls } from "@/components/WindowControls";
import { cn } from "@/lib/utils";
import { IS_MAC, KEY_SEP, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { RadioMarquee } from "@/modules/radio";
import {
  getBindingTokens,
  SHORTCUTS,
  type ShortcutId,
} from "@/modules/shortcuts/shortcuts";
import type { Tab } from "@/modules/tabs";
import { TabBar } from "@/modules/tabs";
import AiScanIcon from "@hugeicons/core-free-icons/AiScanIcon";
import FloppyDiskIcon from "@hugeicons/core-free-icons/FloppyDiskIcon";
import GlobeIcon from "@hugeicons/core-free-icons/GlobeIcon";
import InformationCircleIcon from "@hugeicons/core-free-icons/InformationCircleIcon";
import KeyboardIcon from "@hugeicons/core-free-icons/KeyboardIcon";
import LockKeyIcon from "@hugeicons/core-free-icons/LockKeyIcon";
import Mic01Icon from "@hugeicons/core-free-icons/Mic01Icon";
import PuzzleIcon from "@hugeicons/core-free-icons/PuzzleIcon";
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon";
import Shield01Icon from "@hugeicons/core-free-icons/Shield01Icon";
import SidebarLeftIcon from "@hugeicons/core-free-icons/SidebarLeftIcon";
import DashboardSquare01Icon from "@hugeicons/core-free-icons/DashboardSquare01Icon";
import SparklesIcon from "@hugeicons/core-free-icons/SparklesIcon";
import UserGroupIcon from "@hugeicons/core-free-icons/UserGroupIcon";
import UserMultiple02Icon from "@hugeicons/core-free-icons/UserMultiple02Icon";
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
  onToggleChatGrid: () => void;
  chatGridOpen: boolean;
  /** Hamburger app menu trigger node (App supplies it so it shares the
   *  rail's FileMenu handlers); rendered right of the Workspaces toggle. */
  fileMenuSlot?: ReactNode;
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

/** Launcher tile: icon + label on top row, optional description beneath.
 *  textValue keeps Radix typeahead keyed to the label, not the combined
 *  text content (label + desc would make typeahead matches ambiguous). */
function MenuTile({
  icon: Icon,
  label,
  desc,
  shortcut,
  disabled,
  onSelect,
}: {
  icon: typeof Settings01Icon;
  label: string;
  desc?: string;
  shortcut?: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      textValue={label}
      disabled={disabled}
      onSelect={onSelect}
      className="flex flex-col items-start gap-0.5 rounded-xl px-2.5 py-2"
    >
      {/* Row 1: icon + label ONLY. Never the shortcut: at ~150px per tile,
          label + "Ctrl+Shift+S" overflows, the span wraps, and the Save
          tiles' rows break alignment entirely. */}
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <HugeiconsIcon icon={Icon} size={13} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-xs font-medium">{label}</span>
      </span>
      {/* Row 2: optional desc left, shortcut right — both short enough to
          never wrap. With no desc (Save tiles) the shortcut left-aligns. */}
      <span className="flex w-full min-w-0 items-center gap-1.5">
        {desc ? <span className="min-w-0 truncate text-[10px] leading-3 font-normal text-muted-foreground/70">{desc}</span> : null}
        {shortcut ? <span className={`${desc ? "ml-auto " : ""}shrink-0 text-[10px] leading-3 font-normal text-muted-foreground/60`}>{shortcut}</span> : null}
      </span>
    </DropdownMenuItem>
  );
}

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
      <DropdownMenuContent align="start" className="w-80 rounded-2xl p-2">
        <DropdownMenuLabel className="px-2.5 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
          File
        </DropdownMenuLabel>
        <div className="grid grid-cols-2 gap-1">
          <MenuTile
            icon={FloppyDiskIcon}
            label="Save"
            shortcut={IS_MAC ? "⌘S" : "Ctrl+S"}
            disabled={!activeTab || activeTab.kind !== "editor" || !activeTab.dirty}
            onSelect={onSave}
          />
          <MenuTile
            icon={FloppyDiskIcon}
            label="Save All"
            shortcut={IS_MAC ? "⌘⇧S" : "Ctrl+Shift+S"}
            disabled={dirtyCount < 2}
            onSelect={onSaveAll}
          />
        </div>
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuLabel className="px-2.5 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
          Settings
        </DropdownMenuLabel>
        <div className="grid grid-cols-2 gap-1">
          <MenuTile icon={Settings01Icon} label="General" desc="Theme, behavior, startup" onSelect={() => void openSettingsWindow("general")} />
          <MenuTile icon={KeyboardIcon} label="Shortcuts" desc="Key bindings" onSelect={() => void openSettingsWindow("shortcuts")} />
          <MenuTile icon={AiScanIcon} label="API Keys" desc="Providers & models" onSelect={() => void openSettingsWindow("models")} />
          <MenuTile icon={UserMultiple02Icon} label="Agents" desc="Sub-agent registry" onSelect={() => void openSettingsWindow("agents")} />
          <MenuTile icon={SparklesIcon} label="Skills" desc="Reusable agent skills" onSelect={() => void openSettingsWindow("snippets")} />
          <MenuTile icon={PuzzleIcon} label="MCP Servers" desc="External tool servers" onSelect={() => void openSettingsWindow("mcp")} />
          <MenuTile icon={Shield01Icon} label="Sandbox" desc="Shadow mode" onSelect={() => void openSettingsWindow("sandbox")} />
          <MenuTile icon={LockKeyIcon} label="Security" desc="Approvals & audit" onSelect={() => void openSettingsWindow("security")} />
          <MenuTile icon={UserGroupIcon} label="Staff" desc="Agents, skills & journals" onSelect={() => void openSettingsWindow("staff")} />
          <MenuTile icon={Mic01Icon} label="Voice" desc="Speech & TTS" onSelect={() => void openSettingsWindow("voice")} />
          <MenuTile icon={UserMultiple02Icon} label="Social" desc="Gmail & X access" onSelect={() => void openSettingsWindow("social")} />
          <MenuTile icon={GlobeIcon} label="Assistant" desc="Telegram channels" onSelect={() => void openSettingsWindow("assistant")} />
        </div>
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuItem
          textValue="About"
          onSelect={() => void openSettingsWindow("about")}
          className="flex items-center gap-2 rounded-xl px-2.5 py-1.5"
        >
          <HugeiconsIcon icon={InformationCircleIcon} size={13} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium">About</span>
        </DropdownMenuItem>
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
  onToggleChatGrid,
  chatGridOpen,
  fileMenuSlot,
  onSplit,
  onOpenShortcuts,
  searchTarget,
  searchRef,
  projectName,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);
  const radioEnabled = usePreferencesStore((s) => s.radioEnabled);

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
        {/* Sidebar toggle: hidden while Workspaces is open — the sidebar is
            collapsed in that mode, so its toggle is meaningless chrome. */}
        {!chatGridOpen && (
          <Button
            onClick={onToggleSidebar}
            title="Toggle sidebar"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={SidebarLeftIcon} size={18} strokeWidth={1.75} />
          </Button>
        )}
        <Button
          onClick={onToggleChatGrid}
          title={chatGridOpen ? "Close Workspaces (Esc)" : "Workspaces — all project chats"}
          aria-pressed={chatGridOpen}
          variant="ghost"
          size="icon-sm"
          className={cn(
            "shrink-0 rounded-md transition-colors hover:bg-accent hover:text-foreground",
            chatGridOpen ? "text-foreground bg-accent" : "text-muted-foreground",
          )}
        >
          <HugeiconsIcon icon={DashboardSquare01Icon} size={18} strokeWidth={1.75} />
        </Button>
        {/* Hamburger app menu (2026-11-20): right of the Workspaces toggle.
            App supplies the FileMenu-wrapped trigger (same handlers as the
            rail's hamburger) — while Workspaces is open the rail is
            collapsed, so this is the only reachable path to Settings. */}
        {fileMenuSlot}
        {/* Current-project name: hidden in Workspaces mode — the mode is not
            tied to any project; the cards carry their own names. */}
        {projectName && !compact && !chatGridOpen && (
          <span className="ml-1 max-w-[180px] truncate text-xs font-medium text-muted-foreground" title={projectName}>
            {projectName}
          </span>
        )}
        {/* Radio re-home (2026-11-19): the marquee lives in the status bar's
            center column; while Workspaces hides that bar, it surfaces here
            so playback controls stay reachable in grid mode. */}
        {chatGridOpen && radioEnabled && (
          <span className="ml-2 flex min-w-0 items-center">
            <RadioMarquee />
          </span>
        )}
      </div>
      {!IS_MAC && <span className="mx-1 h-5 w-px shrink-0 bg-border" />}
      {IS_MAC && <span className="mr-1 h-full w-px shrink-0 bg-border" />}
      <div className="flex min-w-0 flex-1 items-center gap-2" data-tauri-drag-region>
        {/* FILE TABS HIDDEN IN WORKSPACES (2026-11-21): Workspaces is a
            multi-CHAT surface, not file work - the tab strip (and its +
            launcher) is meaningless chrome there and the drag-region
            spacer below fills the freed width. */}
        {!chatGridOpen && (
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
        )}
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
