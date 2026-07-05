import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  ApiIcon,
  Cancel01Icon,
  Clock01Icon,
  ComputerTerminal02Icon,
  GitCompareIcon,
  Globe02Icon,
  IncognitoIcon,
  PencilEdit02Icon,
  PlusSignIcon,
  SplitIcon,
  TableColumnsSplitIcon,
  TableRowsSplitIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorTab, Tab } from "./lib/useTabs";

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
  /** Pin (promote) a preview tab to persistent on double-click. */
  onPin: (id: number) => void;
  /** Reorder: move tab dragId to the position of tab hoverId. */
  onMove: (dragId: number, hoverId: number) => void;
  /** Toggle workspace split view for a tab. */
  onSplitTab: (id: number) => void;
  /** Currently split tab id, if any. */
  splitTabId: number | null;
  /** Split active terminal pane (terminals only). */
  onSplitPane: (dir: "row" | "col") => void;
  compact?: boolean;
};

export function TabBar({
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
  onMove,
  onSplitTab,
  splitTabId,
  onSplitPane,
  compact,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);

  // Horizontal wheel scroll without holding shift.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the active tab visible after selection / open.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`);
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  // --- Drag-to-reorder via pointer events ---
  // We store drag state in refs to avoid re-renders during the drag, and only
  // use useState for the draggingId so we can apply visual feedback.

  const dragIdRef = useRef<number | null>(null);

  const tabIdFromPoint = useCallback((x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y);
    const trigger = el?.closest<HTMLElement>("[data-tab-id]");
    const raw = trigger?.dataset.tabId;
    return raw !== undefined ? Number(raw) : null;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, tabId: number) => {
      // Only primary button; let close-button clicks pass through.
      if (e.button !== 0) return;
      const closeBtn = (e.target as Element).closest("[aria-label='Close tab']");
      if (closeBtn) return;

      dragIdRef.current = tabId;
      setDraggingId(tabId);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      e.preventDefault(); // prevent text selection during drag
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (dragIdRef.current === null) return;
      const hoverId = tabIdFromPoint(e.clientX, e.clientY);
      if (hoverId !== null && hoverId !== dragIdRef.current) {
        onMove(dragIdRef.current, hoverId);
        dragIdRef.current = hoverId; // track new position
      }
    },
    [onMove, tabIdFromPoint],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (dragIdRef.current === null) return;
      dragIdRef.current = null;
      setDraggingId(null);
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    },
    [],
  );

  return (
    <div
      ref={scrollRef}
      data-tauri-drag-region
      className="min-w-0 shrink overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="flex w-max items-center gap-0.5">
        <Tabs
          value={String(activeId)}
          onValueChange={(v) => onSelect(Number(v))}
        >
          <TabsList className="h-7 w-max gap-0.5 bg-transparent p-0">
            {tabs.map((t) => {
              const isPreview = t.kind === "editor" && (t as EditorTab).preview;
              const isDragging = t.id === draggingId;
              const isSplit = t.id === splitTabId;
              return (
                <ContextMenu key={t.id}>
                  <ContextMenuTrigger asChild>
                    <TabsTrigger
                      value={String(t.id)}
                      data-tab-id={t.id}
                      onDoubleClick={() => isPreview && onPin(t.id)}
                      onPointerDown={(e) => onPointerDown(e, t.id)}
                      onPointerMove={onPointerMove}
                      onPointerUp={onPointerUp}
                      className={cn(
                        "group h-7 shrink-0 gap-1.5 rounded-md border-0 shadow-none ring-0 text-xs text-muted-foreground transition-colors data-[state=active]:bg-accent data-[state=active]:text-foreground hover:text-foreground/80 justify-between select-none",
                        compact
                          ? "px-1.5!"
                          : tabs.length === 1
                            ? "px-2!"
                            : "ps-2! pe-1!",
                        isSplit && "ring-1 ring-inset ring-foreground/20",
                        isDragging && "cursor-grabbing opacity-50",
                        !isDragging && draggingId !== null && "cursor-grabbing",
                        draggingId === null && "cursor-grab active:cursor-grabbing",
                      )}
                    >
                      <span
                        className={cn(
                          "flex items-center gap-1.5 truncate",
                          compact ? "max-w-48" : "max-w-80",
                        )}
                      >
                        <TabIcon tab={t} />
                        {/* Preview tabs use italic to signal the transient state,
                            matching the visual convention from VSCode. */}
                        <span className={cn("truncate", isPreview && "italic")}>
                          {labelFor(t)}
                        </span>
                        {t.kind === "editor" && t.dirty ? (
                          <span
                            aria-label="Unsaved changes"
                            className="size-1.5 shrink-0 rounded-full bg-foreground/70"
                          />
                        ) : null}
                      </span>
                      {tabs.length > 1 && (
                        <span
                          role="button"
                          aria-label="Close tab"
                          onClick={(e) => {
                            e.stopPropagation();
                            onClose(t.id);
                          }}
                          className="rounded p-0.5 opacity-0 transition-opacity hover:bg-accent hover:opacity-100 group-hover:opacity-60"
                        >
                          <HugeiconsIcon
                            icon={Cancel01Icon}
                            size={11}
                            strokeWidth={2}
                          />
                        </span>
                      )}
                    </TabsTrigger>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="min-w-40 text-[12px]">
                    <ContextMenuItem
                      className="gap-2 text-[12px]"
                      onSelect={() => onSplitTab(t.id)}
                    >
                      <HugeiconsIcon icon={SplitIcon} size={13} strokeWidth={1.75} />
                      {isSplit ? "Close split" : "Split right"}
                    </ContextMenuItem>
                    {t.kind === "terminal" && (
                      <>
                        <ContextMenuItem
                          className="gap-2 text-[12px]"
                          onSelect={() => { onSelect(t.id); onSplitPane("row"); }}
                        >
                          <HugeiconsIcon icon={TableColumnsSplitIcon} size={13} strokeWidth={1.75} />
                          Split pane right
                        </ContextMenuItem>
                        <ContextMenuItem
                          className="gap-2 text-[12px]"
                          onSelect={() => { onSelect(t.id); onSplitPane("col"); }}
                        >
                          <HugeiconsIcon icon={TableRowsSplitIcon} size={13} strokeWidth={1.75} />
                          Split pane down
                        </ContextMenuItem>
                      </>
                    )}
                    {tabs.length > 1 && (
                      <>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          className="gap-2 text-[12px]"
                          variant="destructive"
                          onSelect={() => onClose(t.id)}
                        >
                          <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.75} />
                          Close tab
                        </ContextMenuItem>
                      </>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </TabsList>
        </Tabs>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              title="New tab"
            >
              <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={2} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuItem onSelect={() => onNew()}>
              <HugeiconsIcon
                icon={ComputerTerminal02Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Terminal</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "T")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewPrivate()}>
              <HugeiconsIcon
                icon={IncognitoIcon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Privacy</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "R")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewEditor()}>
              <HugeiconsIcon
                icon={PencilEdit02Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Editor</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "E")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewPreview()}>
              <HugeiconsIcon icon={Globe02Icon} size={14} strokeWidth={1.75} />
              <span className="flex-1">Browse</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "P")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewApiTester()}>
              <HugeiconsIcon icon={ApiIcon} size={14} strokeWidth={1.75} />
              <span className="flex-1">API Tester</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function TabIcon({ tab }: { tab: Tab }) {
  if (tab.kind === "editor") {
    const url = fileIconUrl(tab.title);
    return url ? <img src={url} alt="" className="size-3.5 shrink-0" /> : null;
  }
  if (tab.kind === "preview") {
    return (
      <HugeiconsIcon
        icon={Globe02Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "ai-diff") {
    return (
      <HugeiconsIcon
        icon={GitCompareIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0 text-yellow-600 dark:text-yellow-400"
      />
    );
  }
  if (tab.kind === "terminal" && tab.private) {
    return (
      <HugeiconsIcon
        icon={IncognitoIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0 text-amber-600 dark:text-amber-400"
      />
    );
  }
  if (tab.kind === "git-diff" || tab.kind === "git-commit-file") {
    return (
      <HugeiconsIcon
        icon={GitCompareIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0 text-emerald-600 dark:text-emerald-400"
      />
    );
  }
  if (tab.kind === "git-history") {
    return (
      <HugeiconsIcon
        icon={Clock01Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0 text-sky-600 dark:text-sky-400"
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={ComputerTerminal02Icon}
      size={14}
      strokeWidth={2}
      className="shrink-0"
    />
  );
}

function labelFor(t: Tab): string {
  if (t.kind === "editor") return t.title;
  if (t.kind === "preview") return t.title;
  if (t.kind === "ai-diff") return t.title;
  if (t.kind === "git-diff") return t.title;
  if (t.kind === "git-history") return t.title;
  if (t.kind === "git-commit-file") return t.title;
  if (t.kind === "md-preview") return t.title;
  if (t.kind === "api-tester") return t.title;
  if (!t.cwd) return t.title;
  const parts = t.cwd.split(/[\\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "/";
}
