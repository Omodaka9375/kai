"use client";

import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  CheckmarkCircle01Icon,
  CopyIcon,
  DownloadIcon,
  Maximize01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { HTMLAttributes, ReactNode } from "react";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  extractTableDataFromElement,
  tableDataToCSV,
  tableDataToMarkdown,
  tableDataToTSV,
  StreamdownContext,
} from "streamdown";

// ── Column-aligned plain-text table formatter ───────────────────────────

type TableData = { headers: string[]; rows: string[][] };

function tableDataToPlain(data: TableData): string {
  if (data.headers.length === 0) return "";
  const colWidths = data.headers.map((h, ci) =>
    Math.max(
      h.length,
      ...data.rows.map((r) => (r[ci] ?? "").length),
    ),
  );
  const pad = (s: string, w: number) => s.padEnd(w);
  const header = data.headers.map((h, i) => pad(h, colWidths[i])).join(" | ");
  const sep = colWidths.map((w) => "-".repeat(w)).join("-+-");
  const rows = data.rows
    .map((r) => r.map((c, i) => pad(c, colWidths[i])).join(" | "))
    .join("\n");
  return rows ? `${header}\n${sep}\n${rows}` : header;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function W(filename: string, body: string, mime: string) {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Context for controls config ────────────────────────────────────────

const ControlsCtx = createContext<{
  showCopy: boolean;
  showDownload: boolean;
  showFullscreen: boolean;
}>({ showCopy: true, showDownload: true, showFullscreen: true });

function resolveControl(
  controls: unknown,
  key: string,
): boolean {
  if (typeof controls === "boolean") return controls;
  if (controls && typeof controls === "object") {
    const c = (controls as Record<string, unknown>).table;
    if (c === false) return false;
    if (c === true || c === undefined) return true;
    if (typeof c === "object") {
      const v = (c as Record<string, unknown>)[key];
      return v !== false;
    }
  }
  return true;
}

// ── Copy dropdown (Markdown, CSV, TSV, Plain) ──────────────────────────

function TableCopyDropdown({
  className,
  timeout = 2000,
}: {
  className?: string;
  timeout?: number;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const btnRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef(0);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (btnRef.current && !btnRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.clearTimeout(timerRef.current);
    };
  }, []);

  const copyAs = async (format: "md" | "csv" | "tsv" | "plain") => {
    const wrapper = btnRef.current?.closest(
      '[data-streamdown="table-wrapper"]',
    ) as HTMLElement | null;
    const table = wrapper?.querySelector("table");
    if (!table) return;
    const data = extractTableDataFromElement(table);
    let text = "";
    switch (format) {
      case "md":
        text = tableDataToMarkdown(data);
        break;
      case "csv":
        text = tableDataToCSV(data);
        break;
      case "tsv":
        text = tableDataToTSV(data);
        break;
      case "plain":
        text = tableDataToPlain(data);
        break;
    }
    if (typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([table.outerHTML], { type: "text/html" }),
        }),
      ]);
    } else {
      await navigator.clipboard.writeText(text);
    }
    setCopied(true);
    setOpen(false);
    timerRef.current = window.setTimeout(() => setCopied(false), timeout);
  };

  const Icon = copied ? CheckmarkCircle01Icon : CopyIcon;

  return (
    <div className={cn("relative", className)} ref={btnRef}>
      <button
        type="button"
        className="cursor-pointer rounded p-1 text-muted-foreground transition-all hover:text-foreground"
        onClick={() => setOpen(!open)}
        title="Copy table"
      >
        <HugeiconsIcon icon={Icon} size={14} />
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-20 mt-1 min-w-[140px] overflow-hidden rounded-md border border-border bg-background shadow-lg">
          {(["md", "csv", "tsv", "plain"] as const).map((format) => (
            <button
              key={format}
              type="button"
              className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40"
              onClick={() => { void copyAs(format); }}
            >
              {format === "md"
                ? "Markdown"
                : format === "csv"
                  ? "CSV"
                  : format === "tsv"
                    ? "TSV"
                    : "Plain Text"}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Download dropdown ──────────────────────────────────────────────────

function TableDownloadDropdown({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (btnRef.current && !btnRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const download = (format: "csv" | "markdown") => {
    const wrapper = btnRef.current?.closest(
      '[data-streamdown="table-wrapper"]',
    ) as HTMLElement | null;
    const table = wrapper?.querySelector("table");
    if (!table) return;
    const data = extractTableDataFromElement(table);
    const text =
      format === "csv" ? tableDataToCSV(data) : tableDataToMarkdown(data);
    const mime = format === "csv" ? "text/csv" : "text/markdown";
    const ext = format === "csv" ? "csv" : "md";
    W(`table.${ext}`, text, mime);
    setOpen(false);
  };

  return (
    <div className={cn("relative", className)} ref={btnRef}>
      <button
        type="button"
        className="cursor-pointer rounded p-1 text-muted-foreground transition-all hover:text-foreground"
        onClick={() => setOpen(!open)}
        title="Download table"
      >
        <HugeiconsIcon icon={DownloadIcon} size={14} />
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-20 mt-1 min-w-[120px] overflow-hidden rounded-md border border-border bg-background shadow-lg">
          <button
            type="button"
            className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40"
            onClick={() => download("csv")}
          >
            CSV
          </button>
          <button
            type="button"
            className="w-full px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40"
            onClick={() => download("markdown")}
          >
            Markdown
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ── Fullscreen button ──────────────────────────────────────────────────

function TableFullscreenButton({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const [fs, setFs] = useState(false);

  useEffect(() => {
    if (fs) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setFs(false);
      };
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("keydown", onKey);
        document.body.style.overflow = prev;
      };
    }
  }, [fs]);

  const ctx = useContext(ControlsCtx);

  return (
    <>
      <button
        type="button"
        className={cn(
          "cursor-pointer rounded p-1 text-muted-foreground transition-all hover:text-foreground",
          className,
        )}
        onClick={() => setFs(true)}
        title="View fullscreen"
      >
        <HugeiconsIcon icon={Maximize01Icon} size={14} />
      </button>
      {fs
        ? createPortal(
            <div
              aria-label="View fullscreen"
              aria-modal="true"
              className="fixed inset-0 z-50 flex flex-col bg-background"
              data-streamdown="table-fullscreen"
              onClick={() => setFs(false)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setFs(false);
              }}
              role="dialog"
            >
              <div
                className="flex h-full flex-col"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                role="presentation"
              >
                <div className="flex items-center justify-end gap-1 p-4">
                  {ctx.showCopy ? <TableCopyDropdown /> : null}
                  {ctx.showDownload ? <TableDownloadDropdown /> : null}
                  <button
                    type="button"
                    className="rounded-md p-1 text-muted-foreground transition-all hover:bg-muted hover:text-foreground"
                    onClick={() => setFs(false)}
                    title="Exit fullscreen"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} size={20} />
                  </button>
                </div>
                <div className="flex-1 overflow-auto p-4 pt-0 [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10">
                  <table
                    className="w-full border-collapse border border-border"
                    data-streamdown="table"
                  >
                    {children}
                  </table>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// ── Main TableWrapper ──────────────────────────────────────────────────

export const ChatTable = memo(function ChatTable({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLTableElement> & { node?: unknown }) {
  const ctx = useContext(StreamdownContext) as {
    controls?: unknown;
  } | null;
  const showCopy = resolveControl(ctx?.controls, "copy");
  const showDownload = resolveControl(ctx?.controls, "download");
  const showFullscreen = resolveControl(ctx?.controls, "fullscreen");
  const hasToolbar = showCopy || showDownload || showFullscreen;

  return (
    <ControlsCtx.Provider value={{ showCopy, showDownload, showFullscreen }}>
      <div
        className="my-4 flex flex-col gap-2 rounded-lg border border-border bg-sidebar p-2"
        data-streamdown="table-wrapper"
      >
        {hasToolbar ? (
          <div className="flex items-center justify-end gap-1">
            {showCopy ? <TableCopyDropdown /> : null}
            {showDownload ? <TableDownloadDropdown /> : null}
            {showFullscreen ? (
              <TableFullscreenButton className="">
                {children}
              </TableFullscreenButton>
            ) : null}
          </div>
        ) : null}
        <div className="overflow-x-auto overflow-y-auto rounded-md border border-border bg-background">
          <table
            className={cn("w-full divide-y divide-border", className)}
            data-streamdown="table"
            {...rest}
          >
            {children}
          </table>
        </div>
      </div>
    </ControlsCtx.Provider>
  );
}, (a, b) => a.className === b.className && a.children === b.children);

ChatTable.displayName = "ChatTable";