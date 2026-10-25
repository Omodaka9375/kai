import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  FileAddIcon,
  Folder01Icon,
  FolderAddIcon,
  Refresh01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ExplorerSearch, type ExplorerSearchHandle } from "./ExplorerSearch";
import { EntryRow, PendingRow, StatusRow } from "./TreeRow";
import { InlineInput } from "./InlineInput";
import { copyToClipboard, revealInFinder } from "./lib/contextActions";
import { fileIconUrl, folderIconUrl } from "./lib/iconResolver";
import { COMPACT_CONTENT, COMPACT_ITEM } from "./lib/menuItemClass";
import { useFileTree, joinPath } from "./lib/useFileTree";
import {
  canonPath,
  isDrivePath,
  pathWithinRoot,
  relativeSegments,
} from "./lib/revealPath";
import { useGlobalShortcuts } from "@/modules/shortcuts";
import { cn } from "@/lib/utils";

export type FileExplorerHandle = {
  focus: () => void;
  isFocused: () => boolean;
  /** Expand + select + scroll the row for `path`, VSCode auto-reveal style.
   *  No-op if `path` is outside the current tree root. */
  revealFile: (path: string) => void;
};

type Props = {
  rootPath: string | null;
  onOpenFile: (path: string, pin?: boolean, line?: number) => void;
  onPathRenamed?: (from: string, to: string) => void;
  onPathDeleted?: (path: string) => void;
  onRevealInTerminal?: (path: string) => void;
  onAttachToAgent?: (path: string) => void;
  onPreviewMarkdown?: (path: string) => void;
  onOpenPreview?: (url: string) => void;
};

type Row =
  | {
      kind: "entry";
      key: string;
      path: string;
      name: string;
      isDir: boolean;
      isExpanded: boolean;
      depth: number;
    }
  | { kind: "rename"; key: string; path: string; name: string; isDir: boolean; depth: number }
  | { kind: "pending"; key: string; depth: number; pendingKind: "file" | "dir" }
  | { kind: "status"; key: string; depth: number; tone: "muted" | "error"; message: string };

const ROW_HEIGHT = 24;
const OVERSCAN = 8;

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function buildRows(
  rootPath: string,
  tree: ReturnType<typeof useFileTree>,
): { rows: Row[]; entryIndexByPath: Map<string, number> } {
  const rows: Row[] = [];
  const entryIndexByPath = new Map<string, number>();

  const walk = (parent: string, depth: number) => {
    const node = tree.nodes[parent];
    if (!node || node.status !== "loaded") return;
    for (const entry of node.entries) {
      const path = tree.joinPath(parent, entry.name);
      const isDir = entry.kind === "dir";
      const expanded = isDir && tree.expanded.has(path);
      const isRenaming = tree.renaming === path;
      if (isRenaming) {
        rows.push({
          kind: "rename",
          key: `rename:${path}`,
          path,
          name: entry.name,
          isDir,
          depth,
        });
      } else {
        entryIndexByPath.set(path, rows.length);
        rows.push({
          kind: "entry",
          key: path,
          path,
          name: entry.name,
          isDir,
          isExpanded: expanded,
          depth,
        });
      }
      if (isDir && expanded) {
        const child = tree.nodes[path];
        if (tree.pendingCreate?.parentPath === path) {
          rows.push({
            kind: "pending",
            key: `pending:${path}`,
            depth: depth + 1,
            pendingKind: tree.pendingCreate.kind,
          });
        }
        if (child?.status === "loading") {
          rows.push({
            kind: "status",
            key: `loading:${path}`,
            depth: depth + 1,
            tone: "muted",
            message: "Loading…",
          });
        } else if (child?.status === "error") {
          rows.push({
            kind: "status",
            key: `error:${path}`,
            depth: depth + 1,
            tone: "error",
            message: child.message,
          });
        } else if (child?.status === "loaded") {
          walk(path, depth + 1);
        }
      }
    }
  };

  walk(rootPath, 0);
  return { rows, entryIndexByPath };
}

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(
  function FileExplorer(
    {
      rootPath,
      onOpenFile,
      onPathRenamed,
      onPathDeleted,
      onRevealInTerminal,
      onAttachToAgent,
      onPreviewMarkdown,
      onOpenPreview,
    },
    ref,
  ) {
    const tree = useFileTree(rootPath, { onPathRenamed, onPathDeleted });
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    // VSCode-style auto-reveal: when an editor tab becomes active, App calls
    // revealFile(path). We stash the target and let two effects converge on
    // it — one expands every ancestor directory (triggering async fetches),
    // the other walks the loaded nodes to confirm the row now exists, then
    // selects + scrolls it into view. Cleared once revealed, or abandoned if
    // the path is outside the root / no longer on disk (deleted / renamed).
    const [revealTarget, setRevealTarget] = useState<string | null>(null);
    const [selection, setSelection] = useState<Set<string>>(new Set());
    const anchorRef = useRef<string | null>(null);
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [isSearchActive, setIsSearchActive] = useState(false);
    const searchRef = useRef<ExplorerSearchHandle>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    const { rows, entryIndexByPath } = useMemo(() => {
      if (!rootPath) return { rows: [] as Row[], entryIndexByPath: new Map<string, number>() };
      return buildRows(rootPath, tree);
    }, [rootPath, tree.nodes, tree.expanded, tree.renaming, tree.pendingCreate, tree]);

    const entryPaths = useMemo<string[]>(() => {
      const out: string[] = [];
      for (const row of rows) if (row.kind === "entry") out.push(row.path);
      return out;
    }, [rows]);

    const selectOnly = useCallback((path: string) => {
      setSelectedPath(path);
      setSelection(new Set([path]));
      anchorRef.current = path;
    }, []);

    const toggleSelect = useCallback((path: string) => {
      setSelectedPath(path);
      anchorRef.current = path;
      setSelection((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    }, []);

    const rangeSelect = useCallback((path: string) => {
      const anchor = anchorRef.current;
      if (!anchor || !entryIndexByPath.has(anchor)) {
        selectOnly(path);
        return;
      }
      const from = entryPaths.indexOf(anchor);
      const to = entryPaths.indexOf(path);
      if (from === -1 || to === -1) {
        selectOnly(path);
        return;
      }
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      const next = new Set<string>();
      for (let i = lo; i <= hi; i++) next.add(entryPaths[i]);
      setSelection(next);
      setSelectedPath(path);
    }, [entryPaths, entryIndexByPath, selectOnly]);

    const handleRowContextMenu = useCallback((path: string) => {
      setSelectedPath(path);
      anchorRef.current = path;
      setSelection((prev) => (prev.has(path) ? prev : new Set([path])));
    }, []);

    const selectedPaths = useMemo(() => {
      const out: string[] = [];
      for (const row of rows)
        if (row.kind === "entry" && selection.has(row.path)) out.push(row.path);
      return out;
    }, [rows, selection]);

    const deleteSelectedPaths = useCallback((paths: string[]) => {
      void tree.deletePaths(paths);
      setSelection(new Set());
      setSelectedPath(null);
      anchorRef.current = null;
    }, [tree]);

    useEffect(() => {
      if (selectedPath && !entryIndexByPath.has(selectedPath)) {
        setSelectedPath(null);
      }
    }, [entryIndexByPath, selectedPath]);

    useEffect(() => {
      if (selection.size === 0) return;
      let changed = false;
      const next = new Set(selection);
      for (const p of selection) {
        if (!entryIndexByPath.has(p)) {
          next.delete(p);
          changed = true;
        }
      }
      if (changed) setSelection(next);
    }, [entryIndexByPath, selection]);

    // Auto-refresh when the AI agent creates/writes files.
    useEffect(() => {
      const handler = (e: Event) => {
        const path = (e as CustomEvent<string>).detail;
        if (!path || !rootPath) return;
        // Refresh every ancestor that's already loaded in the tree so
        // newly-created intermediate directories appear in their parent's
        // entry list. Walk up from the immediate parent to rootPath.
        let cursor = path;
        while (cursor.length > (rootPath?.length ?? 1)) {
          const sep = cursor.lastIndexOf("/");
          if (sep <= 0) break;
          cursor = cursor.slice(0, sep);
          // Only refresh if this ancestor is already loaded — don't
          // fetch paths the tree hasn't expanded yet.
          if (tree.nodes[cursor]?.status === "loaded") {
            tree.refresh(cursor);
          }
        }
        // Always refresh rootPath so a top-level create shows up.
        tree.refresh(rootPath);
      };
      window.addEventListener("Kai:fs-changed", handler);
      return () => window.removeEventListener("Kai:fs-changed", handler);
    }, [rootPath, tree]);

    const virtualizer = useVirtualizer({
      count: rows.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => ROW_HEIGHT,
      overscan: OVERSCAN,
      getItemKey: (index) => rows[index]?.key ?? index,
    });

    const scrollEntryIntoView = useCallback(
      (path: string) => {
        const index = entryIndexByPath.get(path);
        if (index === undefined) return;
        virtualizer.scrollToIndex(index, { align: "auto" });
      },
      [entryIndexByPath, virtualizer],
    );

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          containerRef.current?.focus();
          if (!selectedPath && entryPaths.length > 0) {
            const first = entryPaths[0];
            selectOnly(first);
            requestAnimationFrame(() => scrollEntryIntoView(first));
          }
        },
        revealFile: (path: string) => {
          if (!rootPath) return;
          // A path outside the explorer root can't be revealed; VSCode
          // silently does nothing (rather than switching roots) here too.
          if (!pathWithinRoot(path, rootPath)) return;
          setRevealTarget(canonPath(path));
        },
        isFocused: () => {
          const c = containerRef.current;
          if (!c) return false;
          const active = document.activeElement;
          return active instanceof Node && c.contains(active);
        },
      }),
      [entryPaths, scrollEntryIntoView, selectedPath, selectOnly, rootPath],
    );

    // Reveal state machine (drives revealFile). Descends from the root using
    // REAL entry names read from loaded directory nodes, expanding each
    // ancestor (which fires its async fetch) and re-running as nodes land,
    // until the target's row exists — then selects + scrolls to it. Matching
    // segments against disk names (case-insensitively on drive-letter roots)
    // means a tab path with drifted casing or an agent-supplied lowercase
    // path still lands on the right row; a segment missing from a loaded dir
    // means the file was deleted/renamed/hidden, so the reveal is abandoned
    // rather than leaving a stale highlight.
    const expandDir = tree.expand;
    const treeNodes = tree.nodes;
    const treeExpanded = tree.expanded;
    useEffect(() => {
      if (!revealTarget || !rootPath) return;
      const segs = relativeSegments(revealTarget, rootPath);
      if (segs.length === 0) {
        setRevealTarget(null);
        return;
      }
      const drive = isDrivePath(rootPath);
      let curDir = rootPath;
      for (let i = 0; i < segs.length; i++) {
        const want = segs[i];
        const node = treeNodes[curDir];
        if (!node || node.status !== "loaded") {
          // Load this dir; the effect re-runs when its entries arrive.
          expandDir(curDir);
          return;
        }
        const match = node.entries.find((e) =>
          drive
            ? e.name.toLowerCase() === want.toLowerCase()
            : e.name === want,
        );
        if (!match) {
          setRevealTarget(null);
          return;
        }
        const realChild = joinPath(curDir, match.name);
        if (i === segs.length - 1) {
          // `match` is the target itself: its parent must be expanded (root
          // is always listed) and the row present before we can select it.
          if (curDir !== rootPath && !treeExpanded.has(curDir)) {
            expandDir(curDir);
            return;
          }
          if (!entryIndexByPath.has(realChild)) {
            expandDir(curDir);
            return;
          }
          selectOnly(realChild);
          requestAnimationFrame(() => scrollEntryIntoView(realChild));
          setRevealTarget(null);
          return;
        }
        // Intermediate directory: expand it (loads children) and descend.
        if (!treeExpanded.has(realChild)) {
          expandDir(realChild);
        }
        curDir = realChild;
      }
    }, [
      revealTarget,
      rootPath,
      treeNodes,
      treeExpanded,
      expandDir,
      entryIndexByPath,
      selectOnly,
      scrollEntryIntoView,
    ]);

    useGlobalShortcuts({
      "explorer.search": () => {
        if (searchRef.current?.isFocused()) {
          setIsSearchOpen(false);
          return;
        }
        setIsSearchOpen(true);
        searchRef.current?.focus();
      },
    });

    if (!rootPath) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <HugeiconsIcon
            icon={Folder01Icon}
            size={24}
            strokeWidth={1.5}
            className="text-muted-foreground"
          />
          <div className="text-xs text-muted-foreground">
            No current directory
          </div>
        </div>
      );
    }

    const root = tree.nodes[rootPath];
    const pendingAtRoot =
      tree.pendingCreate?.parentPath === rootPath ? tree.pendingCreate : null;

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (tree.renaming || tree.pendingCreate || isSearchOpen) return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      )
        return;
      if (entryPaths.length === 0) return;

      const currentIdx = selectedPath ? entryPaths.indexOf(selectedPath) : -1;
      const move = (next: number) => {
        const clamped = Math.max(0, Math.min(entryPaths.length - 1, next));
        const path = entryPaths[clamped];
        selectOnly(path);
        requestAnimationFrame(() => scrollEntryIntoView(path));
      };

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          move(currentIdx < 0 ? 0 : currentIdx + 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          move(currentIdx < 0 ? entryPaths.length - 1 : currentIdx - 1);
          break;
        case "ArrowRight": {
          if (currentIdx < 0) return;
          e.preventDefault();
          const path = entryPaths[currentIdx];
          const idx = entryIndexByPath.get(path);
          if (idx === undefined) break;
          const row = rows[idx];
          if (row.kind !== "entry") break;
          if (row.isDir) {
            if (!row.isExpanded) tree.toggle(row.path);
            else move(currentIdx + 1);
          }
          break;
        }
        case "ArrowLeft": {
          if (currentIdx < 0) return;
          e.preventDefault();
          const path = entryPaths[currentIdx];
          const idx = entryIndexByPath.get(path);
          if (idx === undefined) break;
          const row = rows[idx];
          if (row.kind !== "entry") break;
          if (row.isDir && row.isExpanded) {
            tree.toggle(row.path);
          } else {
            const parent = row.path.slice(0, row.path.lastIndexOf("/"));
            if (parent && parent !== rootPath) setSelectedPath(parent);
          }
          break;
        }
        case "Enter": {
          if (currentIdx < 0) return;
          e.preventDefault();
          const path = entryPaths[currentIdx];
          const idx = entryIndexByPath.get(path);
          if (idx === undefined) break;
          const row = rows[idx];
          if (row.kind !== "entry") break;
          if (row.isDir) tree.toggle(row.path);
          else onOpenFile(row.path);
          break;
        }
      }
    };

    const renderRow = (row: Row) => {
      switch (row.kind) {
        case "entry":
        case "rename": {
          return (
            <EntryRow
              path={row.path}
              name={row.name}
              isDir={row.isDir}
              isExpanded={row.kind === "entry" ? row.isExpanded : false}
              depth={row.depth}
              rootPath={rootPath}
              tree={tree}
              isSelected={selection.has(row.path)}
              isRenaming={row.kind === "rename"}
              selectedPaths={selectedPaths}
              onOpenFile={onOpenFile}
              onSelectPath={selectOnly}
              onToggleSelect={toggleSelect}
              onRangeSelect={rangeSelect}
              onContextMenuSelect={handleRowContextMenu}
              onDeletePaths={deleteSelectedPaths}
              onRevealInTerminal={onRevealInTerminal}
              onAttachToAgent={onAttachToAgent}
              onPreviewMarkdown={onPreviewMarkdown}
              onOpenPreview={onOpenPreview}
            />
          );
        }
        case "pending":
          return (
            <PendingRow
              depth={row.depth}
              kind={row.pendingKind}
              onCommit={tree.commitCreate}
              onCancel={tree.cancelCreate}
            />
          );
        case "status":
          return (
            <StatusRow depth={row.depth} message={row.message} tone={row.tone} />
          );
      }
    };

    return (
      <div
        ref={containerRef}
        className="flex h-full flex-col outline-none"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2">
          <span
            className="flex flex-1 items-center truncate text-xs font-medium text-foreground/80"
            title={rootPath}
          >
            <img
              src={folderIconUrl(basename(rootPath), false)}
              alt=""
              height={15}
              width={15}
              className="mx-1.5"
            />
            {basename(rootPath)}
          </span>

          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => setIsSearchOpen((v) => !v)}
            title="Search files"
            aria-label="Search files"
          >
            <HugeiconsIcon icon={Search01Icon} size={13} strokeWidth={2} />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => tree.beginCreate(rootPath, "file")}
            title="New file"
          >
            <HugeiconsIcon icon={FileAddIcon} size={13} strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => tree.beginCreate(rootPath, "dir")}
            title="New folder"
          >
            <HugeiconsIcon icon={FolderAddIcon} size={13} strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => tree.refresh(rootPath)}
            title="Refresh"
          >
            <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={2} />
          </Button>
        </div>

        <div className={cn("flex flex-col", isSearchActive ? "min-h-0 flex-1 overflow-hidden" : "shrink-0")}>
          <ExplorerSearch
            ref={searchRef}
            rootPath={rootPath}
            onOpenFile={onOpenFile}
            open={isSearchOpen}
            onRequestClose={() => setIsSearchOpen(false)}
            onActiveChange={setIsSearchActive}
            onRevealInTerminal={onRevealInTerminal}
            onAttachToAgent={onAttachToAgent}
          />
        </div>

        {!isSearchActive ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                ref={scrollRef}
                className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
              >
                {pendingAtRoot ? (
                  <div
                    className="flex h-6 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
                    style={{ paddingLeft: 6 }}
                  >
                    <span className="size-3.5 shrink-0" />
                    <img
                      src={
                        pendingAtRoot.kind === "dir"
                          ? folderIconUrl("", false)
                          : fileIconUrl("untitled")
                      }
                      alt=""
                      className="size-4 shrink-0 opacity-70"
                    />
                    <InlineInput
                      initial=""
                      placeholder={
                        pendingAtRoot.kind === "dir" ? "New folder" : "New file"
                      }
                      onCommit={tree.commitCreate}
                      onCancel={tree.cancelCreate}
                    />
                  </div>
                ) : null}
                {root?.status === "loading" && (
                  <div className="px-3 py-2 text-[11px] text-muted-foreground">
                    Loading…
                  </div>
                )}
                {root?.status === "error" && (
                  <div className="px-3 py-2 text-[11px] text-destructive">
                    {root.message}
                  </div>
                )}
                {root?.status === "loaded" ? (
                  <div
                    style={{
                      height: virtualizer.getTotalSize(),
                      position: "relative",
                      width: "100%",
                    }}
                  >
                    {virtualizer.getVirtualItems().map((virtualRow) => {
                      const row = rows[virtualRow.index];
                      if (!row) return null;
                      return (
                        <div
                          key={virtualRow.key}
                          data-virtual-row-index={virtualRow.index}
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            height: virtualRow.size,
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                        >
                          {renderRow(row)}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent
              className={COMPACT_CONTENT}
              onCloseAutoFocus={(e) => {
                if (tree.renaming || tree.pendingCreate) e.preventDefault();
              }}
            >
              {onRevealInTerminal && (
                <ContextMenuItem
                  className={COMPACT_ITEM}
                  onSelect={() => onRevealInTerminal(rootPath)}
                >
                  Open in Terminal
                </ContextMenuItem>
              )}
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => void revealInFinder(rootPath)}
              >
                Reveal in Finder
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => tree.beginCreate(rootPath, "file")}
              >
                New File
              </ContextMenuItem>
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => tree.beginCreate(rootPath, "dir")}
              >
                New Folder
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => void copyToClipboard(rootPath)}
              >
                Copy Path
              </ContextMenuItem>
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => tree.refresh(rootPath)}
              >
                Refresh
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ) : null}
      </div>
    );
  },
);
