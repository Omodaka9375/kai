import { useTheme } from "@/modules/theme";
import type { SearchAddon } from "@xterm/addon-search";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { sanitizeDroppedText } from "./lib/dropText";
import { useTerminalSession } from "./lib/useTerminalSession";

export type TerminalPaneHandle = {
  write: (data: string) => void;
  focus: () => void;
  getBuffer: (maxLines?: number) => string | null;
  getSelection: () => string | null;
};

type Props = {
  /** Stable identifier for this leaf (passed back through callbacks). */
  leafId: number;
  /** Tab containing this pane is on screen. */
  visible: boolean;
  /** This leaf is the active pane within its tab — receives auto-focus. */
  focused?: boolean;
  initialCwd?: string;
  onSearchReady?: (leafId: number, addon: SearchAddon) => void;
  onExit?: (leafId: number, code: number) => void;
  onCwd?: (leafId: number, cwd: string) => void;
};

export const TerminalPane = forwardRef<TerminalPaneHandle, Props>(
  function TerminalPane(
    {
      leafId,
      visible,
      focused = true,
      initialCwd,
      onSearchReady,
      onExit,
      onCwd,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const { resolvedTheme } = useTheme();

    const session = useTerminalSession({
      leafId,
      container: containerRef,
      visible,
      focused,
      initialCwd,
      onSearchReady: (a) => onSearchReady?.(leafId, a),
      onExit: (c) => onExit?.(leafId, c),
      onCwd: (c) => onCwd?.(leafId, c),
    });

    // Drop-target highlight: dragover fires continuously while a payload
    // hovers; a clear-timer after the last one avoids dragenter/dragleave
    // counting across xterm's nested DOM (and the stuck-ring case when the
    // drag exits the window without a final dragleave).
    const [isDragOver, setIsDragOver] = useState(false);
    const dragClear = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
      () => () => {
        if (dragClear.current) clearTimeout(dragClear.current);
      },
      [],
    );

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
      // Allow dropping file paths onto the terminal. We accept any drag that
      // carries a text payload (our explorer drags use text/plain).
      if (!e.dataTransfer.types.includes("text/plain")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setIsDragOver(true);
      if (dragClear.current) clearTimeout(dragClear.current);
      dragClear.current = setTimeout(() => setIsDragOver(false), 300);
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
      // Unconditional: dragover already accepted the drag, so the browser
      // default (treat dropped text as URL/navigation) must not run.
      e.preventDefault();
      if (dragClear.current) clearTimeout(dragClear.current);
      setIsDragOver(false);
      // External drags (browser tabs, other apps) can carry arbitrary text
      // — a newline would auto-execute at a bash/zsh prompt (LF == Enter)
      // and control bytes have no place at a prompt. Internal explorer
      // drags carry shell-quoted relative paths and pass through as-is.
      const text = sanitizeDroppedText(e.dataTransfer.getData("text/plain"));
      if (!text) return;
      // Insert the dragged path(s) as if typed at the prompt.
      session.write(text);
      session.focus();
    };

    useEffect(() => {
      // Defer one frame so CSS-variable token resolution sees the new class.
      const id = requestAnimationFrame(() => session.applyTheme());
      return () => cancelAnimationFrame(id);
    }, [resolvedTheme, session]);

    useImperativeHandle(
      ref,
      () => ({
        write: (data: string) => session.write(data),
        focus: () => session.focus(),
        getBuffer: (max?: number) => session.getBuffer(max),
        getSelection: () => session.getSelection(),
      }),
      [session],
    );

    return (
      <div
        ref={containerRef}
        className="zoom-exempt relative h-full w-full"
        style={{
          visibility: visible ? "visible" : "hidden",
          pointerEvents: visible ? "auto" : "none",
        }}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Drop-target ring. A ring on the container itself is box-shadow —
            it paints BEHIND xterm's canvas; an overlay div paints above. */}
        {isDragOver ? (
          <div className="pointer-events-none absolute inset-0 z-10 rounded-sm border-2 border-primary/50 bg-primary/5" />
        ) : null}
      </div>
    );
  },
);
