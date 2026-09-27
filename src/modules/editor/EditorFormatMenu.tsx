import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { MagicWand01Icon, UserWarning01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Spinner } from "@/components/ui/spinner";

export type EditorFormatMenuProps = {
  x: number;
  y: number;
  path: string;
  /** False when no formatter exists — menu shows a disabled explainer row. */
  formattable: boolean;
  /** e.g. "prettier" or "black" — tells the user how the file gets formatted. */
  formatterName: string | null;
  hasSelection: boolean;
  busy: boolean;
  error: string | null;
  onFormat: (selectionOnly: boolean) => void;
  onDismiss: () => void;
};

/** Right-click menu for the code editor: format document / selection. */
export function EditorFormatMenu({
  x,
  y,
  path,
  formattable,
  formatterName,
  hasSelection,
  busy,
  error,
  onFormat,
  onDismiss,
}: EditorFormatMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);

  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const w = 230;
  const rows =
    2 + (hasSelection && formattable ? 1 : 0) + (busy ? 1 : 0) + (error ? 1 : 0);
  const h = rows * 30 + 12;
  const left = Math.max(4, Math.min(x, window.innerWidth - w - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - h - 4));

  return (
    <motion.div
      ref={menuRef}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.1, ease: "easeOut" }}
      style={{ top, left, width: w }}
      className="fixed z-50 flex flex-col gap-0.5 rounded-lg border border-border/70 bg-card/95 p-1 shadow-xl backdrop-blur-md"
    >
      <button
        type="button"
        disabled={busy || !formattable}
        title={
          formattable
            ? `Formats with ${formatterName ?? "prettier"}`
            : `No formatter available for .${ext} files`
        }
        onClick={(e) => {
          e.stopPropagation();
          onFormat(false);
        }}
        className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[11.5px] text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
      >
        <HugeiconsIcon
          icon={MagicWand01Icon}
          size={13}
          strokeWidth={1.8}
          className="text-muted-foreground"
        />
        <span className="flex-1 text-left">
          {formattable ? "Format Document" : `No formatter for .${ext}`}
          {formattable && (
            <span className="ml-1.5 text-[10px] text-muted-foreground">
              {formatterName}
            </span>
          )}
        </span>
      </button>
      {hasSelection && formattable && (
        <button
          type="button"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            onFormat(true);
          }}
          className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[11.5px] text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
        >
          <HugeiconsIcon
            icon={MagicWand01Icon}
            size={13}
            strokeWidth={1.8}
            className="text-muted-foreground"
          />
          <span className="flex-1 text-left">Format Selection</span>
        </button>
      )}
      {busy && (
        <div className="flex h-6 items-center gap-2 px-2 text-[10.5px] text-muted-foreground">
          <Spinner className="size-3" />
          Formatting…
        </div>
      )}
      {error && (
        <div className="flex items-start gap-1.5 px-2 py-1.5 text-[10.5px] text-amber-600 dark:text-amber-400">
          <HugeiconsIcon
            icon={UserWarning01Icon}
            size={12}
            strokeWidth={2}
            className="mt-0.5 shrink-0"
          />
          <span className="flex-1 break-words">{error}</span>
          <button
            type="button"
            title="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            className="shrink-0 rounded p-0.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
          </button>
        </div>
      )}
    </motion.div>
  );
}
