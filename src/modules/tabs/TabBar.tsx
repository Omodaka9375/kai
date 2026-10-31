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
  Delete02Icon,
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
  onNewEditor: () => void;
  onNewApiTester: () => void;
  onNewPrivate: () => void;
  onClose: (id: number) => void;
  /** Close every other tab, keeping this one. */
  onCloseOthers: (id: number) => void;
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
  onNewEditor,
  onNewApiTester,
  onNewPrivate,
  onClose,
  onCloseOthers,
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

  // --- Drag-to-reorder (VS Code model) ---
  // Geometry-driven preview + commit-once-at-drop:
  //  - The dragged tab FOLLOWS the cursor via translateX, clamped to the bar.
  //  - Neighbors PREVIEW their shift with a CSS transition once the dragged
  //    tab's center crosses theirs - the array is NOT mutated mid-drag, so
  //    there are no App-level re-renders and no oscillation on small
  //    back-and-forth wiggles across a tab edge.
  //  - The reorder commits ONCE on pointerup through the same onMove.
  //  - A 4px threshold separates click from drag: plain clicks never flash
  //    the drag visual.
  const dragIdRef = useRef<number | null>(null);
  const dragStartXRef = useRef(0);
  const lastDxRef = useRef(0);
  const lastPointerXRef = useRef(0);
  const dragStartedRef = useRef(false);
  const dragIdxRef = useRef(0);
  /** Content-relative tab centers + widths, snapshotted once at drag start. */
  const centersRef = useRef<Array<{ id: number; center: number; width: number }>>([]);
  const minDxRef = useRef(0);
  const maxDxRef = useRef(0);
  const edgeScrollRafRef = useRef<number | null>(null);
  // True between a real drag's pointerup and the click that follows it -
  // suppresses Radix's tab activation so reordering a background tab never
  // steals focus (VS Code behavior).
  const dragJustEndedRef = useRef(false);

  /** Local-only preview state - re-renders TabBar alone, never the App. */
  const [dragPreview, setDragPreview] = useState<{
    dx: number;
    shifts: Map<number, number>;
  }>({ dx: 0, shifts: new Map() });

  const DRAG_THRESHOLD_PX = 4;
  const EDGE_ZONE_PX = 40;
  const EDGE_SPEED_PX = 10;

  const stopEdgeScroll = useCallback(() => {
    if (edgeScrollRafRef.current != null) {
      cancelAnimationFrame(edgeScrollRafRef.current);
      edgeScrollRafRef.current = null;
    }
  }, []);

  /** rAF ticker: auto-scroll the bar while the pointer parks at an edge. */
  const startEdgeScroll = useCallback(() => {
    if (edgeScrollRafRef.current != null) return;
    const tick = () => {
      edgeScrollRafRef.current = null;
      const el = scrollRef.current;
      if (!el || dragIdRef.current === null || !dragStartedRef.current) return;
      const rect = el.getBoundingClientRect();
      const x = lastPointerXRef.current;
      if (x < rect.left + EDGE_ZONE_PX) el.scrollLeft -= EDGE_SPEED_PX;
      else if (x > rect.right - EDGE_ZONE_PX) el.scrollLeft += EDGE_SPEED_PX;
      else return; // left the zone - the next pointermove re-arms the ticker
      edgeScrollRafRef.current = requestAnimationFrame(tick);
    };
    edgeScrollRafRef.current = requestAnimationFrame(tick);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, tabId: number) => {
      if (e.button !== 0) return;
      const closeBtn = (e.target as Element).closest("[aria-label='Close tab']");
      if (closeBtn) return;

      dragIdRef.current = tabId;
      dragStartXRef.current = e.clientX;
      lastPointerXRef.current = e.clientX;
      lastDxRef.current = 0;
      dragStartedRef.current = false;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const dragId = dragIdRef.current;
      if (dragId === null) return;
      lastPointerXRef.current = e.clientX;
      const rawDx = e.clientX - dragStartXRef.current;

      if (!dragStartedRef.current) {
        if (Math.abs(rawDx) < DRAG_THRESHOLD_PX) return;
        // Drag start: snapshot content-relative geometry once. Content-
        // relative (viewport offset + scrollLeft folded in) so auto-scroll
        // never invalidates the math.
        const el = scrollRef.current;
        const list = el?.querySelector<HTMLElement>('[role="tablist"]');
        if (!el || !list) return;
        const scrollRect = el.getBoundingClientRect();
        const triggers = Array.from(
          list.querySelectorAll<HTMLElement>("[data-tab-id]"),
        );
        centersRef.current = triggers.map((tEl) => {
          const r = tEl.getBoundingClientRect();
          return {
            id: Number(tEl.dataset.tabId),
            center: r.left + r.width / 2 - scrollRect.left + el.scrollLeft,
            width: r.width,
          };
        });
        const mine = centersRef.current.find((c) => c.id === dragId);
        const first = centersRef.current[0];
        const last = centersRef.current[centersRef.current.length - 1];
        if (!mine || !first || !last) return;
        dragIdxRef.current = centersRef.current.findIndex((c) => c.id === dragId);
        minDxRef.current = first.center - mine.center;
        maxDxRef.current = last.center - mine.center;
        dragStartedRef.current = true;
        setDraggingId(dragId);
      }

      // Clamp so the dragged tab stays within the bar's content bounds.
      const dx = Math.min(maxDxRef.current, Math.max(minDxRef.current, rawDx));

      // Same dx ⇒ same preview (shifts derive purely from dx + the start
      // snapshot): skip the state update entirely while the cursor is
      // parked beyond a clamp edge.
      if (dx !== lastDxRef.current) {
        lastDxRef.current = dx;

        // Neighbor shift preview: a tab whose center the dragged tab has
        // passed slides over by exactly one slot.
        const centers = centersRef.current;
        const mine = centers.find((c) => c.id === dragId);
        const shifts = new Map<number, number>();
        if (mine) {
          const centerNow = mine.center + dx;
          for (let i = 0; i < centers.length; i++) {
            const c = centers[i]!;
            if (c.id === dragId) continue;
            if (i < dragIdxRef.current && centerNow < c.center) {
              shifts.set(c.id, mine.width); // slides right into the freed slot
            } else if (i > dragIdxRef.current && centerNow > c.center) {
              shifts.set(c.id, -mine.width); // slides left into the freed slot
            }
          }
        }
        setDragPreview({ dx, shifts });
      }

      // Auto-scroll while parked at the bar's edges.
      const el = scrollRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        if (e.clientX < rect.left + EDGE_ZONE_PX || e.clientX > rect.right - EDGE_ZONE_PX) {
          startEdgeScroll();
        }
      }
    },
    [startEdgeScroll],
  );

  const endDrag = useCallback(
    (commit: boolean) => {
      const dragId = dragIdRef.current;
      const started = dragStartedRef.current;
      stopEdgeScroll();
      dragIdRef.current = null;
      dragStartedRef.current = false;
      if (started) {
        // Suppress the click Radix fires right after a real drag.
        dragJustEndedRef.current = true;
        setTimeout(() => {
          dragJustEndedRef.current = false;
        }, 0);
        if (commit && dragId !== null) {
          const centers = centersRef.current;
          const mine = centers.find((c) => c.id === dragId);
          if (mine) {
            const centerNow = mine.center + lastDxRef.current;
            const insertIdx = centers.filter(
              (o) => o.id !== dragId && o.center < centerNow,
            ).length;
            // insertIdx is the dragged tab's FINAL index; the tab currently
            // OCCUPYING that slot is the move target (moveTab's splice
            // semantics land the item exactly there, both directions).
            const hoverId = tabs[insertIdx]?.id;
            if (hoverId !== undefined && hoverId !== dragId) {
              onMove(dragId, hoverId);
            }
          }
        }
      }
      setDraggingId(null);
      setDragPreview({ dx: 0, shifts: new Map() });
    },
    [tabs, onMove, stopEdgeScroll],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (dragIdRef.current === null) return;
      endDrag(true);
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // Capture already released - nothing to do.
      }
    },
    [endDrag],
  );

  const onPointerCancel = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (dragIdRef.current === null) return;
      endDrag(false);
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // Same as above.
      }
    },
    [endDrag],
  );

  // Lostpointercapture covers teardown mid-drag (unmount, capture stolen):
  // reset without committing. The normal pointerup path nulls dragIdRef
  // BEFORE releasing capture, so this is a no-op there.
  const onLostPointerCapture = useCallback(() => {
    if (dragIdRef.current !== null) endDrag(false);
  }, [endDrag]);

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
          // Manual activation = VS Code semantics: focus (pointerdown) does
          // NOT activate. Without this, automatic mode activates a background
          // tab the instant you press on it to drag - which then triggers the
          // keep-active-visible scroll MID-DRAG and reorders feel like they
          // fight the cursor.
          activationMode="manual"
        >
          <TabsList className="h-7 w-max gap-0.5 bg-transparent p-0">
            {tabs.map((t) => {
              const isPreview = t.kind === "editor" && (t as EditorTab).preview;
              const isDragging = t.id === draggingId;
              const isSplit = t.id === splitTabId;
              const shift = dragPreview.shifts.get(t.id) ?? 0;
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
                      onPointerCancel={onPointerCancel}
                      onLostPointerCapture={onLostPointerCapture}
                      // Radix activates tabs on click, and a click follows
                      // every pointerup - including the end of a real drag.
                      // Swallow it so dropping a background tab never
                      // selects it.
                      onClickCapture={(e) => {
                        if (dragJustEndedRef.current) {
                          e.preventDefault();
                          e.stopPropagation();
                        }
                      }}
                      style={
                        isDragging || shift !== 0
                          ? {
                              transform: `translateX(${isDragging ? dragPreview.dx : shift}px)`,
                              zIndex: isDragging ? 20 : undefined,
                            }
                          : undefined
                      }
                      className={cn(
                        "group h-7 shrink-0 gap-1.5 rounded-md border-0 shadow-none ring-0 text-xs text-muted-foreground data-[state=active]:bg-accent data-[state=active]:text-foreground hover:text-foreground/80 justify-between select-none [touch-action:none]",
                        compact
                          ? "px-1.5!"
                          : "ps-2! pe-1!",
                        isSplit && "ring-1 ring-inset ring-foreground/20",
                        // Neighbors glide when their preview shift changes;
                        // the dragged tab tracks the cursor 1:1 (no scale -
                        // scaling distorts the tab and its hit box).
                        isDragging
                          ? "transition-none cursor-grabbing shadow-md"
                          : "transition-[color,background-color,transform,box-shadow] duration-150 ease-out",
                        draggingId !== null && !isDragging && "cursor-grabbing",
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
                      {/* Closing the last tab is legal — the StartPage takes
                          over the zero-tab state, so the X is always shown. */}
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
                    <ContextMenuSeparator />
                    {tabs.length > 1 && (
                      <ContextMenuItem
                        className="gap-2 text-[12px]"
                        onSelect={() => onCloseOthers(t.id)}
                      >
                        <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.75} />
                        Close others
                      </ContextMenuItem>
                    )}
                    <ContextMenuItem
                      className="gap-2 text-[12px]"
                      variant="destructive"
                      onSelect={() => onClose(t.id)}
                    >
                      <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.75} />
                      Close tab
                    </ContextMenuItem>
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
            <DropdownMenuItem onSelect={() => onNewPrivate()}>
              <HugeiconsIcon icon={IncognitoIcon} size={14} strokeWidth={1.75} />
              <span className="flex-1">Private Terminal</span>
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
  // Terminal tabs label by what they ARE, not by the cwd basename — the
  // project folder name belongs to the window title / header label, and
  // every terminal in a project would otherwise read identically anyway.
  // `private` keeps its distinct title so private tabs stay recognizable.
  if (t.kind === "terminal") return t.title === "private" ? "private" : "terminal";
  return (t as { title?: string }).title ?? "";
}
