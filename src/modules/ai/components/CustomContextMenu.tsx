import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { fmtShortcut, MOD_KEY, IS_MAC } from "@/lib/platform";
import { motion } from "motion/react";
import { useEffect, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiContentGenerator02Icon,
  Copy01Icon,
  ClipboardIcon,
  Delete02Icon,
  GridIcon,
  ArrowRight01Icon,
  ArrowDown01Icon,
  MagicWand01Icon,
  UserWarning01Icon
} from "@hugeicons/core-free-icons";

export type CustomContextMenuProps = {
  x: number;
  y: number;
  selectionText: string | null;
  isTerminal: boolean;
  /** Editor-only: format entries. Set when the menu targets a code editor. */
  editorFormat?: {
    path: string;
    formattable: boolean;
    formatterName: string | null;
    onFormat: (selectionOnly: boolean) => void;
  };
  /** Inline error row (e.g. formatter failures). Keeps the menu open so the
   *  message stays visible until dismissed. */
  error?: string | null;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onClearTerminal?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onAskKai: () => void;
  onDismiss: () => void;
};

export function CustomContextMenu({
  x,
  y,
  selectionText,
  isTerminal,
  editorFormat,
  error,
  onCopy,
  onPaste,
  onSelectAll,
  onClearTerminal,
  onSplitRight,
  onSplitDown,
  onAskKai,
  onDismiss,
}: CustomContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };

    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onDismiss]);

  const hasSelection = selectionText && selectionText.trim().length > 0;
  const fmt = editorFormat;
  // Height estimate for viewport clamping — format entries add rows.
  const extraRows =
    fmt ? (fmt.formattable ? (hasSelection ? 3 : 2) : 1) + 1 : 0; // +1 separator
  const menuHeight =
    (fmt ? 250 : 0) + (hasSelection ? 100 : 200) + extraRows * 30;
  const menuWidth = 180;

  // Adjust position so it doesn't overflow screen boundaries
  const left = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8));

  /** Shared format rows for the editor variant of this menu. */
  const formatEntries = fmt && (
    <>
      <div className="my-1 border-t border-border/40" />
      <button
        type="button"
        disabled={!fmt.formattable}
        title={
          fmt.formattable
            ? `Formats with ${fmt.formatterName ?? "prettier"}`
            : `No formatter available for this file`
        }
        onClick={(e) => {
          e.stopPropagation();
          fmt.onFormat(false);
          onDismiss();
        }}
        className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[11.5px] text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
      >
        <HugeiconsIcon
          icon={MagicWand01Icon}
          size={12}
          strokeWidth={1.8}
          className="text-muted-foreground"
        />
        <span className="flex-1 text-left">
          {fmt.formattable ? "Format Document" : "No formatter"}
          {fmt.formattable && fmt.formatterName && (
            <span className="ml-1.5 text-[10px] text-muted-foreground">
              {fmt.formatterName}
            </span>
          )}
        </span>
      </button>
      {fmt.formattable && hasSelection && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            fmt.onFormat(true);
            onDismiss();
          }}
          className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[11.5px] text-foreground hover:bg-accent"
        >
          <HugeiconsIcon
            icon={MagicWand01Icon}
            size={12}
            strokeWidth={1.8}
            className="text-muted-foreground"
          />
          <span className="flex-1 text-left">Format Selection</span>
        </button>
      )}
    </>
  );

  return (
    <motion.div
      ref={menuRef}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.1, ease: "easeOut" }}
      style={{ top, left, width: menuWidth }}
      className="fixed z-50 flex flex-col gap-0.5 rounded-lg border border-border/70 bg-card/95 p-1 shadow-xl backdrop-blur-md"
    >
      {hasSelection ? (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAskKai();
              onDismiss();
            }}
            className="flex h-7 w-full cursor-pointer items-center justify-between rounded-md px-2 text-[11.5px] hover:bg-accent text-foreground font-medium"
          >
            <span className="flex items-center gap-2">
              <HugeiconsIcon icon={AiContentGenerator02Icon} size={12} strokeWidth={1.8} className="text-primary" />
              <span>Ask Kai</span>
            </span>
            <KbdGroup>
              <Kbd className="h-4 min-w-4 px-1 text-[9px]">{fmtShortcut(MOD_KEY, "L")}</Kbd>
            </KbdGroup>
          </button>
          {error && (
            <div className="flex items-start gap-1.5 px-2 py-1.5 text-[10.5px] text-amber-600 dark:text-amber-400">
              <HugeiconsIcon
                icon={UserWarning01Icon}
                size={12}
                strokeWidth={2}
                className="mt-0.5 shrink-0"
              />
              <span className="flex-1 break-words">{error}</span>
            </div>
          )}
          
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCopy();
              onDismiss();
            }}
            className="flex h-7 w-full cursor-pointer items-center justify-between rounded-md px-2 text-[11.5px] hover:bg-accent text-foreground"
          >
            <span className="flex items-center gap-2">
              <HugeiconsIcon icon={Copy01Icon} size={12} strokeWidth={1.8} className="text-muted-foreground" />
              <span>Copy</span>
            </span>
            <KbdGroup>
              <Kbd className="h-4 min-w-4 px-1 text-[9px]">{IS_MAC ? "⌘C" : "Ctrl+C"}</Kbd>
            </KbdGroup>
          </button>
          {formatEntries}
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPaste();
              onDismiss();
            }}
            className="flex h-7 w-full cursor-pointer items-center justify-between rounded-md px-2 text-[11.5px] hover:bg-accent text-foreground"
          >
            <span className="flex items-center gap-2">
              <HugeiconsIcon icon={ClipboardIcon} size={12} strokeWidth={1.8} className="text-muted-foreground" />
              <span>Paste</span>
            </span>
            <KbdGroup>
              <Kbd className="h-4 min-w-4 px-1 text-[9px]">{IS_MAC ? "⌘V" : "Ctrl+V"}</Kbd>
            </KbdGroup>
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelectAll();
              onDismiss();
            }}
            className="flex h-7 w-full cursor-pointer items-center justify-between rounded-md px-2 text-[11.5px] hover:bg-accent text-foreground"
          >
            <span className="flex items-center gap-2">
              <HugeiconsIcon icon={GridIcon} size={12} strokeWidth={1.8} className="text-muted-foreground" />
              <span>Select All</span>
            </span>
            <KbdGroup>
              <Kbd className="h-4 min-w-4 px-1 text-[9px]">{IS_MAC ? "⌘A" : "Ctrl+A"}</Kbd>
            </KbdGroup>
          </button>

          {formatEntries}

          {isTerminal && (
            <>
              <div className="my-1 border-t border-border/40" />
              
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClearTerminal?.();
                  onDismiss();
                }}
                className="flex h-7 w-full cursor-pointer items-center justify-between rounded-md px-2 text-[11.5px] hover:bg-accent text-foreground"
              >
                <span className="flex items-center gap-2">
                  <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.8} className="text-muted-foreground" />
                  <span>Clear Terminal</span>
                </span>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSplitRight?.();
                  onDismiss();
                }}
                className="flex h-7 w-full cursor-pointer items-center justify-between rounded-md px-2 text-[11.5px] hover:bg-accent text-foreground"
              >
                <span className="flex items-center gap-2">
                  <HugeiconsIcon icon={ArrowRight01Icon} size={12} strokeWidth={1.8} className="text-muted-foreground" />
                  <span>Split Right</span>
                </span>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSplitDown?.();
                  onDismiss();
                }}
                className="flex h-7 w-full cursor-pointer items-center justify-between rounded-md px-2 text-[11.5px] hover:bg-accent text-foreground"
              >
                <span className="flex items-center gap-2">
                  <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={1.8} className="text-muted-foreground" />
                  <span>Split Down</span>
                </span>
              </button>
            </>
          )}
        </>
      )}
    </motion.div>
  );
}
