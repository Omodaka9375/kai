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
  ArrowDown01Icon
} from "@hugeicons/core-free-icons";

export type CustomContextMenuProps = {
  x: number;
  y: number;
  selectionText: string | null;
  isTerminal: boolean;
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
  const menuWidth = 180;
  
  // Adjust position so it doesn't overflow screen boundaries
  const left = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - (hasSelection ? 100 : 200) - 8));

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
