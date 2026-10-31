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
  AiScanIcon,
  FloppyDiskIcon,
  GlobeIcon,
  InformationCircleIcon,
  KeyboardIcon,
  LockKeyIcon,
  Mic01Icon,
  PuzzleIcon,
  Settings01Icon,
  Shield01Icon,
  SidebarLeftIcon,
  SparklesIcon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
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
          <MenuTile icon={Settings01Icon} label="General" desc="Theme, behavior, Gmail" onSelect={() => void openSettingsWindow("general")} />
          <MenuTile icon={KeyboardIcon} label="Shortcuts" desc="Key bindings" onSelect={() => void openSettingsWindow("shortcuts")} />
          <MenuTile icon={AiScanIcon} label="Models" desc="Providers & API keys" onSelect={() => void openSettingsWindow("models")} />
          <MenuTile icon={UserMultiple02Icon} label="Agents" desc="Sub-agent registry" onSelect={() => void openSettingsWindow("agents")} />
          <MenuTile icon={SparklesIcon} label="Snippets" desc="Prompts & skills" onSelect={() => void openSettingsWindow("snippets")} />
          <MenuTile icon={PuzzleIcon} label="MCP Servers" desc="External tool servers" onSelect={() => void openSettingsWindow("mcp")} />
          <MenuTile icon={Shield01Icon} label="Sandbox" desc="Shadow mode" onSelect={() => void openSettingsWindow("sandbox")} />
          <MenuTile icon={LockKeyIcon} label="Security" desc="Approvals & audit" onSelect={() => void openSettingsWindow("security")} />
          <MenuTile icon={Mic01Icon} label="Voice" desc="Speech & TTS" onSelect={() => void openSettingsWindow("voice")} />
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
