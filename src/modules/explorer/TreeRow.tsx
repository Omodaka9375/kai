import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useRef, useState } from "react";
import { InlineInput } from "./InlineInput";
import {
  copyToClipboard,
  relativePath,
  revealInFinder,
} from "./lib/contextActions";
import { fileIconUrl, folderIconUrl } from "./lib/iconResolver";
import { COMPACT_CONTENT, COMPACT_ITEM } from "./lib/menuItemClass";
import type { useFileTree } from "./lib/useFileTree";
import { native } from "@/modules/ai/lib/native";

type Tree = ReturnType<typeof useFileTree>;

export type EntryRowProps = {
  path: string;
  name: string;
  isDir: boolean;
  isExpanded: boolean;
  depth: number;
  rootPath: string;
  tree: Tree;
  isSelected: boolean;
  isRenaming: boolean;
  selectedPaths: string[];
  onOpenFile: (path: string, pin?: boolean) => void;
  onSelectPath: (path: string) => void;
  onToggleSelect: (path: string) => void;
  onRangeSelect: (path: string) => void;
  onContextMenuSelect: (path: string) => void;
  onDeletePaths: (paths: string[]) => void;
  onRevealInTerminal?: (path: string) => void;
  onAttachToAgent?: (path: string) => void;
  onPreviewMarkdown?: (path: string) => void;
  onOpenPreview?: (url: string) => void;
};

function EntryRowImpl(props: EntryRowProps) {
  const {
    path,
    name,
    isDir,
    isExpanded,
    depth,
    rootPath,
    tree,
    isSelected,
    isRenaming,
    selectedPaths,
    onOpenFile,
    onSelectPath,
    onToggleSelect,
    onRangeSelect,
    onContextMenuSelect,
    onDeletePaths,
    onRevealInTerminal,
    onAttachToAgent,
    onPreviewMarkdown,
    onOpenPreview,
  } = props;

  const [isConfirming, setIsConfirming] = useState(false);
  const [isConfirmingMulti, setIsConfirmingMulti] = useState(false);
  const isConfirmingRef = useRef(false);
  const isConfirmingMultiRef = useRef(false);
  const iconUrl = isDir ? folderIconUrl(name, isExpanded) : fileIconUrl(name);
  const createTarget = isDir ? path : path.slice(0, path.lastIndexOf("/")) || rootPath;
  const paddingLeft = 6 + depth * 12;
  const multi = selectedPaths.length > 1;

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (tree.renaming) return;
    if (e.shiftKey) {
      onRangeSelect(path);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      onToggleSelect(path);
      return;
    }
    onSelectPath(path);
    if (isDir) tree.toggle(path);
    else onOpenFile(path);
  };

  const handleContextMenu = () => {
    if (tree.renaming) return;
    onContextMenuSelect(path);
  };

  return (
    <ContextMenu onOpenChange={(open) => { if (!open) { isConfirmingRef.current = false; setIsConfirming(false); isConfirmingMultiRef.current = false; setIsConfirmingMulti(false); } }}>
      <ContextMenuTrigger asChild>
        {isRenaming ? (
          <div
            className="flex h-6 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
            style={{ paddingLeft }}
          >
            <span className="size-3.5 shrink-0" />
            {iconUrl ? (
              <img src={iconUrl} alt="" className="size-4 shrink-0" />
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <InlineInput
              initial={name}
              onCommit={tree.commitRename}
              onCancel={tree.cancelRename}
            />
          </div>
        ) : (
          <button
            type="button"
            data-fs-path={path}
            onClick={handleClick}
            onContextMenu={handleContextMenu}
            onDoubleClick={() => !isDir && tree.beginRename(path)}
            className={cn(
              "group flex h-6 w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1.5 text-left text-[13px] text-foreground/85 transition-colors hover:bg-accent/70",
              isSelected && "bg-accent text-foreground",
            )}
            style={{ paddingLeft }}
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
              {isDir ? (
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  size={12}
                  strokeWidth={2.25}
                  className={cn(
                    "transition-transform",
                    isExpanded && "rotate-90",
                  )}
                />
              ) : null}
            </span>
            {iconUrl ? (
              <img src={iconUrl} alt="" className="size-4 shrink-0" />
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{name}</span>
          </button>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent
        className={COMPACT_CONTENT}
        onCloseAutoFocus={(e) => {
          if (tree.renaming || tree.pendingCreate) e.preventDefault();
        }}
      >
        {multi ? (
          <>
            <ContextMenuItem
              className={COMPACT_ITEM}
              onSelect={() => void copyToClipboard(selectedPaths.join("\n"))}
            >
              Copy Paths
            </ContextMenuItem>
            <ContextMenuItem
              className={COMPACT_ITEM}
              onSelect={() =>
                void copyToClipboard(
                  selectedPaths.map((p) => relativePath(rootPath, p)).join("\n"),
                )
              }
            >
              Copy Relative Paths
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              className={COMPACT_ITEM}
              variant="destructive"
              onSelect={(e) => {
                if (isConfirmingMultiRef.current) {
                  onDeletePaths(selectedPaths);
                } else {
                  e.preventDefault();
                  isConfirmingMultiRef.current = true;
                  setIsConfirmingMulti(true);
                }
              }}
            >
              {isConfirmingMulti
                ? "Click again to confirm"
                : `Delete ${selectedPaths.length} items`}
            </ContextMenuItem>
          </>
        ) : (
          <>
            {!isDir && (
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => onOpenFile(path, true)}
              >
                Open
              </ContextMenuItem>
            )}
            {!isDir && /\.(html|htm)$/i.test(name) && onOpenPreview && (
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={async () => {
                  const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
                  const parentDir = lastSep > 0 ? path.slice(0, lastSep) : path;
                  const command = `npx --yes http-server "${parentDir}" --port 5500`;
                  try {
                    await native.shellBgSpawn(command, parentDir);
                    onOpenPreview(`http://localhost:5500/${name}`);
                  } catch (e) {
                    console.error("Live preview launch failed:", e);
                  }
                }}
              >
                Open in Live Preview
              </ContextMenuItem>
            )}
            {!isDir && /\.md$/i.test(name) && onPreviewMarkdown && (
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => onPreviewMarkdown(path)}
              >
                Preview
              </ContextMenuItem>
            )}
            {isDir && onRevealInTerminal && (
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => onRevealInTerminal(path)}
              >
                Open in Terminal
              </ContextMenuItem>
            )}
            <ContextMenuItem
              className={COMPACT_ITEM}
              onSelect={() => void revealInFinder(path)}
            >
              Reveal in Finder
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              className={COMPACT_ITEM}
              onSelect={() => tree.beginCreate(createTarget, "file")}
            >
              New File
            </ContextMenuItem>
            <ContextMenuItem
              className={COMPACT_ITEM}
              onSelect={() => tree.beginCreate(createTarget, "dir")}
            >
              New Folder
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              className={COMPACT_ITEM}
              onSelect={() => void copyToClipboard(path)}
            >
              Copy Path
            </ContextMenuItem>
            <ContextMenuItem
              className={COMPACT_ITEM}
              onSelect={() => void copyToClipboard(relativePath(rootPath, path))}
            >
              Copy Relative Path
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              className={COMPACT_ITEM}
              onSelect={() => onAttachToAgent?.(path)}
            >
              Attach to Agent
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              className={COMPACT_ITEM}
              variant="destructive"
              onSelect={(e) => {
                if (isConfirmingRef.current) {
                  onDeletePaths([path]);
                } else {
                  e.preventDefault();
                  isConfirmingRef.current = true;
                  setIsConfirming(true);
                }
              }}
            >
              {isConfirming ? "Click again to confirm" : "Delete"}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export const EntryRow = memo(EntryRowImpl);

export type PendingRowProps = {
  depth: number;
  kind: "file" | "dir";
  onCommit: (name: string) => void | Promise<void>;
  onCancel: () => void;
};

export function PendingRow({ depth, kind, onCommit, onCancel }: PendingRowProps) {
  return (
    <div
      className="flex h-6 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
      style={{ paddingLeft: 6 + depth * 12 }}
    >
      <span className="size-3.5 shrink-0" />
      <img
        src={kind === "dir" ? folderIconUrl("", false) : fileIconUrl("untitled")}
        alt=""
        className="size-4 shrink-0 opacity-70"
      />
      <InlineInput
        initial=""
        placeholder={kind === "dir" ? "New folder" : "New file"}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  );
}

export function StatusRow({
  depth,
  message,
  tone,
}: {
  depth: number;
  message: string;
  tone: "muted" | "error";
}) {
  return (
    <div
      className={cn(
        "h-6 truncate px-2 text-[11px] leading-6",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
      style={{ paddingLeft: 6 + depth * 12 + 18 }}
    >
      {message}
    </div>
  );
}
