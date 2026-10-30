"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  ArrowRight01Icon,
  CheckListIcon,
  EyeIcon,
  File01Icon,
  FileEditIcon,
  FilePlusIcon,
  Folder01Icon,
  FolderAddIcon,
  FolderOpenIcon,
  GlobalSearchIcon,
  RobotIcon,
  SparklesIcon,
  TerminalIcon,
  StopIcon,
  ToolsIcon,
  VideoIcon,
} from "@hugeicons/core-free-icons";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { stopCommand } from "@/modules/ai/tools/shell";
import { extractRedactionNotices, unfenceDeep } from "@/modules/ai/lib/fence";
import { presentationFor } from "@/modules/ai/lib/toolPresentations";
import { getEffectStatus } from "@/modules/ai/lib/effectStatus";
import { stripInternalMeta } from "@/modules/ai/lib/toolFencing";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, memo, useMemo, useState } from "react";


export type ToolPart = ToolUIPart | DynamicToolUIPart;

// Icons only. Header LABELS live in the toolPresentations registry (single
// source of truth shared with the status line + approval card); this table
// just maps tool → glyph, which the registry cannot express (it is UI-layer).
const TOOL_ICON: Record<string, typeof File01Icon> = {
  read_file: File01Icon,
  list_directory: FolderOpenIcon,
  write_file: FilePlusIcon,
  create_directory: FolderAddIcon,
  edit: FileEditIcon,
  bash_run: TerminalIcon,
  bash_background: TerminalIcon,
  bash_logs: TerminalIcon,
  bash_list: TerminalIcon,
  bash_kill: TerminalIcon,
  grep: GlobalSearchIcon,
  glob: Folder01Icon,
  suggest_command: SparklesIcon,
  open_preview: EyeIcon,
  run_subagent: RobotIcon,
  display_image: EyeIcon,
  display_video: VideoIcon,
  todo_write: CheckListIcon,
};

const STATUS_DOT: Record<ToolPart["state"], string> = {
  "approval-requested": "bg-amber-500",
  "approval-responded": "bg-sky-500",
  "input-streaming": "bg-muted-foreground/40",
  "input-available": "bg-amber-500",
  // Same geometry as every other state (a border would add 2px and visibly
  // shift the row when the dot settles). Hollow = done, via ring inset.
  "output-available": "bg-transparent ring-1 ring-inset ring-muted-foreground/40",
  "output-denied": "bg-orange-500",
  "output-error": "bg-destructive",
};

const STATUS_LABEL: Record<ToolPart["state"], string> = {
  "approval-requested": "awaiting approval",
  "approval-responded": "responded",
  "input-streaming": "preparing",
  "input-available": "running",
  "output-available": "done",
  "output-denied": "denied",
  "output-error": "error",
};

function deriveSummary(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const fn = presentationFor(toolName).summary;
  return fn ? fn(input as Record<string, unknown>) : null;
}

export type ToolProps = ComponentProps<typeof Collapsible> & {
  toolName: string;
  state: ToolPart["state"];
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

// Tools whose `input` carries large/streaming content (file bodies, sub-
// agent prompts, todo lists). The AI diff tab is the canonical place to
// view file changes; for the rest, the header summary + final output is
// enough. Re-rendering streamed input on every token both stalls the UI
// and duplicates information.
const HEAVY_CONTENT_TOOLS = new Set([
  "write_file",
  "edit",
  "batch_edit",
  "todo_write",
  // run_subagent prompts carry the whole task context (files, excerpts) —
  // rendering the live stream re-lays out a huge text node per token and
  // freezes the window until the run finishes. Skip the body while
  // streaming; the final prompt renders once, capped.
  "run_subagent",
]);

/** Pretty display name for tool-call card headers. MCP tools arrive as
 *  `<server>__<name>` (dots sanitized to underscores — providers reject them),
 *  e.g. `ugnas__files_find`. KAI's own tools read like "Read"/"Run"; the raw
 *  MCP key would too, so render it as `ugnas: files find`. Wire names are
 *  untouched — this is display-only. */
function prettyToolName(toolName: string): string {
  const sep = toolName.indexOf("__");
  if (sep > 0) {
    const server = toolName.slice(0, sep);
    const rest = toolName
      .slice(sep + 2)
      .replace(/_/g, " ")
      .trim();
    if (rest) return `${server}: ${rest}`;
  }
  return toolName;
}

const ToolImpl = ({
  className,
  toolName,
  state,
  input,
  output,
  errorText,
  defaultOpen,
  ...props
}: ToolProps) => {
  const meta = TOOL_ICON[toolName];
  const Icon = meta ?? ToolsIcon;
  const label = presentationFor(toolName).label ?? prettyToolName(toolName);
  const summary = deriveSummary(toolName, input);
  const isError = state === "output-error";
  // Outcome badge: _effect now persists into the transcript (stripped from
  // the model copy), so a card replayed days later still shows that a
  // PARTIAL edit landed 3/5 hunks or a ROLLED_BACK batch did nothing.
  // COMMITTED/NONE are the expected outcomes of a successful call — badge
  // only the anomalies worth a second look.
  const effect =
    state === "output-available" ? getEffectStatus(output) : null;
  const effectBadge =
    effect === "ROLLED_BACK" || effect === "PARTIAL" || effect === "UNKNOWN"
      ? effect === "ROLLED_BACK"
        ? "no changes applied"
        : effect === "PARTIAL"
          ? "partially applied"
          : "outcome unknown"
      : null;
  const open = defaultOpen ?? isError;
  const [stopState, setStopState] = useState<"idle" | "stopping" | "error">("idle");
  const canStop = toolName === "bash_run" && state === "input-available";
  const onStop = () => {
    const sessionId = useChatStore.getState().activeSessionId;
    if (!sessionId || stopState === "stopping") return;
    setStopState("stopping");
    void stopCommand(sessionId).catch((error) => {
      console.error("Failed to stop command:", error);
      setStopState("error");
    });
  };
  const isHeavy = HEAVY_CONTENT_TOOLS.has(toolName);
  // For heavy tools, only show details on error — never the streamed input
  // body, which is huge and re-renders per token.
  const showInputBody = !isHeavy && Boolean(input);
  const showOutputBody = !isHeavy && output !== undefined;
  // Fence markers are a model-facing prompt-injection defense — the UI shows
  // clean output. This is display-only; the persisted message stays fenced.
  // _effect/_outputWarning* are internal (kept on the part for the outcome
  // badge + replay) so the body renderer strips them too.
  const displayOutput = showOutputBody
    ? unfenceDeep(stripInternalMeta(output))
    : undefined;
  // Visible redaction: when the sanitizer stripped/forged-neutralized content,
  // a `[kai: …]` notice rides inside the fence. Surface it at the card HEADER
  // so the user sees the page tried something without expanding the body.
  const redactions = useMemo(
    () => (showOutputBody ? extractRedactionNotices(output) : []),
    [showOutputBody, output],
  );
  const hasDetails =
    showInputBody || showOutputBody || Boolean(errorText);

  return (
    <Collapsible
      defaultOpen={open}
      className={cn("group/tool not-prose w-full", className)}
      {...props}
    >
      <CollapsibleTrigger
        disabled={!hasDetails}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
          "text-[12px] transition-colors",
          "hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <span
          className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[state])}
          aria-label={STATUS_LABEL[state]}
        />
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">{label}</span>
        {summary ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {redactions.length > 0 && (
          <span
            title={redactions.join(" · ")}
            className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
          >
            {redactions.length === 1
              ? "redacted"
              : `${redactions.length} redactions`}
          </span>
        )}
        {effectBadge && (
          <span
            title={`Tool effect status: ${effect}`}
            className="shrink-0 rounded bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-medium text-orange-600 dark:text-orange-400"
          >
            {effectBadge}
          </span>
        )}
        {isError && (
          <span className="shrink-0 text-[10px] font-medium text-destructive">
            failed
          </span>
        )}
      </CollapsibleTrigger>

      {canStop ? (
        <button
          type="button"
          onClick={onStop}
          disabled={stopState === "stopping"}
          title="Stop this command"
          className="mr-2 flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-70"
        >
          <HugeiconsIcon icon={StopIcon} size={10} strokeWidth={2} />
          {stopState === "stopping" ? "Stopping…" : stopState === "error" ? "Stop failed" : "Stop"}
        </button>
      ) : null}

      {hasDetails && (
        <CollapsibleContent
          className={cn("Kai-collapsible-content")}
        >
          <div className="ml-3 mt-1 space-y-2 border-l border-border/60 pl-3 pb-1">
            {showInputBody ? (
              <ToolInput toolName={toolName} input={input} />
            ) : null}
            {showOutputBody || errorText ? (
              <ToolOutput
                toolName={toolName}
                output={displayOutput}
                errorText={errorText}
              />
            ) : null}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
};

// For heavy tools, the only thing that should trigger a re-render is a
// state transition or the path summary changing — NOT every input-content
// token. We compare the cheap derived summary instead of the input ref.
export const Tool = memo(ToolImpl, (a, b) => {
  if (a.toolName !== b.toolName || a.state !== b.state) return false;
  if (a.errorText !== b.errorText) return false;
  if (a.output !== b.output) return false;
  if (a.className !== b.className) return false;
  if (HEAVY_CONTENT_TOOLS.has(a.toolName)) {
    return deriveSummary(a.toolName, a.input) ===
      deriveSummary(b.toolName, b.input);
  }
  return a.input === b.input;
});

function ToolInput({ toolName, input }: { toolName: string; input: unknown }) {
  if (input == null) return null;
  const preview = renderInputPreview(toolName, input);
  if (preview) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] font-medium text-muted-foreground">
          Input
        </div>
        {preview}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium text-muted-foreground">Input</div>
      <CodeBlockMini
        code={
          typeof input === "string" ? input : JSON.stringify(input, null, 2)
        }
        language="json"
      />
    </div>
  );
}

function renderInputPreview(
  toolName: string,
  input: unknown,
): ReactNode | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const str = (k: string) =>
    typeof i[k] === "string" ? (i[k] as string) : null;

  if (toolName === "bash_run" || toolName === "bash_background") {
    const cmd = str("command");
    const cwd = str("cwd");
    if (!cmd) return null;
    return (
      <div className="space-y-1">
        {cwd ? (
          <div className="font-mono text-[10px] text-muted-foreground">
            {cwd}
          </div>
        ) : null}
        <pre className="overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {cmd}
        </pre>
      </div>
    );
  }
  if (
    toolName === "read_file" ||
    toolName === "list_directory" ||
    toolName === "create_directory" ||
    toolName === "open_preview"
  ) {
    const path = str("path") ?? str("url");
    if (!path) return null;
    return (
      <div className="font-mono text-[11px] text-muted-foreground">{path}</div>
    );
  }
  if (toolName === "grep") {
    const pat = str("pattern") ?? str("query");
    const path = str("path") ?? str("root");
    if (!pat) return null;
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-foreground">{pat}</div>
        {path ? <div className="text-muted-foreground">{path}</div> : null}
      </div>
    );
  }
  if (toolName === "display_image") {
    // NEVER stringify the base64 payload into the card — a screenshot can
    // be megabytes, and rendering it freezes the transcript.
    const name = str("name") ?? "image";
    const data = str("base64_data");
    const kb = data ? Math.ceil((data.length * 3) / 4 / 1024) : null;
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-foreground">{name}</span>
        {kb != null ? (
          <span className="text-muted-foreground">
            · {kb} KB{kb >= 1024 ? ` (${(kb / 1024).toFixed(1)} MB)` : ""}
          </span>
        ) : null}
      </div>
    );
  }
  if (toolName === "look_at_screen") {
    const display = str("display");
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-foreground">{display ?? "primary"}</span>
        {str("focus") ? (
          <span className="truncate text-muted-foreground">
            · {str("focus")}
          </span>
        ) : null}
      </div>
    );
  }
  if (toolName === "run_subagent") {
    const prompt = str("prompt");
    return (
      <div className="space-y-1">
        {str("type") ? (
          <div className="font-mono text-[10.5px] text-muted-foreground">
            {str("type")}
          </div>
        ) : null}
        {prompt ? (
          <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/90">
            {prompt}
          </div>
        ) : null}
      </div>
    );
  }
  return null;
}

function ToolOutput({
  toolName,
  output,
  errorText,
}: {
  toolName: string;
  output: unknown;
  errorText?: string;
}) {
  if (errorText) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] font-medium text-destructive">Error</div>
        <div className="rounded bg-destructive/10 px-2 py-1.5 font-mono text-[11px] text-destructive whitespace-pre-wrap">
          {errorText}
        </div>
      </div>
    );
  }
  if (output === undefined || output === null) return null;

  const custom = renderToolOutput(toolName, output);
  if (custom) return custom;

  let body: ReactNode;
  if (typeof output === "string") {
    // MCP tool results arrive as a STRING whose body is JSON (that exact
    // escaped text is also what the model sees). If it parses, show it
    // pretty-printed instead of the raw one-line \"escaped\" form.
    let parsed: unknown | undefined;
    try {
      parsed = JSON.parse(output);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && typeof parsed === "object") {
      const f = formatToolOutput(parsed);
      body = <CodeBlockMini code={f.code} language={f.language} />;
    } else {
      body = <CodeBlockMini code={output} language="text" />;
    }
  } else if (typeof output === "object" && !isValidElement(output)) {
    const f = formatToolOutput(output);
    body = <CodeBlockMini code={f.code} language={f.language} />;
  } else {
    body = <div className="text-[12px]">{output as ReactNode}</div>;
  }

  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium text-muted-foreground">
        Output
      </div>
      {body}
    </div>
  );
}

/** A string long enough (or containing newlines) that dumping it through
 *  JSON.stringify collapses a multi-paragraph body onto one escaped line. */
const BIG_TEXT_MIN = 300;

/**
 * Render a tool-output object readably.
 *
 * The old default — JSON.stringify(obj, null, 2) — pretty-prints the OUTER
 * object but keeps every string VALUE a JSON literal, so a big multi-line
 * field (web_browse's `content`, any tool's `stdout`/`text`/`message`) renders
 * as a single ~kilobyte line full of `\n` escapes: technically correct JSON,
 * useless to read. Here, when the object carries such a field we split it
 * out: the remaining (small/structured) keys form a compact JSON header and
 * each big string prints VERBATIM — real newlines — under a labelled rule.
 * Purely structured results with no big text keep the old pretty JSON, so
 * small `{ok, path, size}` shapes look exactly as before. Display-only: the
 * model still receives the raw output; this changes nothing it sees.
 */
function formatToolOutput(o: unknown): { code: string; language: string } {
  if (Array.isArray(o) || o === null || typeof o !== "object")
    return { code: JSON.stringify(o, null, 2), language: "json" };
  const big: Array<[string, string]> = [];
  const header: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (typeof v === "string" && (v.includes("\n") || v.length > BIG_TEXT_MIN))
      big.push([k, v]);
    else header[k] = v;
  }
  if (big.length === 0)
    return { code: JSON.stringify(o, null, 2), language: "json" };
  let out = Object.keys(header).length > 0 ? JSON.stringify(header, null, 2) : "";
  for (const [k, v] of big) {
    out += `${out ? "\n" : ""}\n\u2500\u2500\u2500 ${k} (${v.length.toLocaleString()} chars) \u2500\u2500\u2500\n${v}`;
  }
  return { code: out, language: "text" };
}

function renderToolOutput(toolName: string, output: unknown): ReactNode | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;

  // MCP result shape: { content: [{type:"text", text:"…"}], structuredContent?, isError }.
  // The `text` payloads arrive JSON-stringified, so a raw dump renders as one
  // escaped one-liner (`{\n  "path": …`). Render the real content instead:
  // prefer structuredContent (already an object), else parse each text part.
  if (Array.isArray(o.content) && o.content.length > 0) {
    const structured = o.structuredContent;
    if (structured && typeof structured === "object") {
      const f = formatToolOutput(structured);
      return <CodeBlockMini code={f.code} language={f.language} />;
    }
    const texts = (o.content as unknown[])
      .map((c) =>
        c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
          ? (c as { text: string }).text
          : null,
      )
      .filter((t): t is string => t != null);
    if (texts.length > 0) {
      const joined = texts.join("\n\n");
      let parsed: unknown | undefined;
      try {
        parsed = JSON.parse(joined);
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined && typeof parsed === "object") {
        const f = formatToolOutput(parsed);
        return <CodeBlockMini code={f.code} language={f.language} />;
      }
      return <CodeBlockMini code={joined} language="text" />;
    }
  }

  if (toolName === "run_subagent") {
    const summary = typeof o.summary === "string" ? o.summary : null;
    const steps = typeof o.stepCount === "number" ? o.stepCount : null;
    const ms = typeof o.durationMs === "number" ? o.durationMs : null;
    const kind = typeof o.type === "string" ? o.type : null;
    if (!summary) return null;
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10.5px] text-muted-foreground">
          {kind ? <span>{kind}</span> : null}
          {steps != null ? <span>· {steps} steps</span> : null}
          {ms != null ? <span>· {(ms / 1000).toFixed(1)}s</span> : null}
        </div>
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/90">
          {summary}
        </div>
      </div>
    );
  }

  if (toolName === "read_file") {
    const path = typeof o.path === "string" ? o.path : "";
    const size = typeof o.size === "number" ? o.size : null;
    const content = typeof o.content === "string" ? o.content : "";
    const lines = content ? content.split("\n").length : null;
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">read</span>
        {path ? <span className="text-muted-foreground">· {path}</span> : null}
        {lines != null ? (
          <span className="text-muted-foreground">
            ({lines} line{lines === 1 ? "" : "s"}
            {size != null ? `, ${formatBytes(size)}` : ""})
          </span>
        ) : null}
      </div>
    );
  }

  if (toolName === "display_image") {
    // Success: { ok, displayed_in, size_bytes } — a one-line confirmation,
    // never the payload. Failure: { error }.
    if (typeof o.error === "string") {
      return (
        <div className="font-mono text-[11px] text-destructive">{o.error}</div>
      );
    }
    const size = typeof o.size_bytes === "number" ? o.size_bytes : null;
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">displayed in terminal</span>
        {size != null ? (
          <span className="text-muted-foreground">({formatBytes(size)})</span>
        ) : null}
      </div>
    );
  }

  if (toolName === "display_video") {
    // Success: { ok, displayed_in, label, source }; ffmpeg-missing: { ok:false, note }.
    if (typeof o.error === "string") {
      return (
        <div className="font-mono text-[11px] text-destructive">{o.error}</div>
      );
    }
    const label = typeof o.label === "string" ? o.label : null;
    const source = typeof o.source === "string" ? o.source : null;
    const note = typeof o.note === "string" ? o.note : null;
    if (note) {
      return (
        <div className="font-mono text-[11px] text-amber-600 dark:text-amber-400">
          {note}
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">video poster in terminal</span>
        {label ? <span className="text-muted-foreground">· {label}</span> : null}
        {source ? (
          <span className="truncate text-muted-foreground">({source})</span>
        ) : null}
      </div>
    );
  }

  if (toolName === "look_at_screen") {
    // The dataUrl is for THIS card only — the model received the image as a
    // tool-result part, and compaction elides it from later re-sends.
    const dataUrl =
      typeof o.image === "object" && o.image !== null
        ? String((o.image as { dataUrl?: unknown }).dataUrl ?? "")
        : "";
    const monitor =
      typeof o.monitor === "object" && o.monitor !== null
        ? (o.monitor as { name?: string; resolution?: string })
        : null;
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 font-mono text-[11px]">
          <span className="text-emerald-600 dark:text-emerald-400">✓</span>
          <span className="text-foreground">
            {monitor?.name ?? "monitor"}
          </span>
          {monitor?.resolution ? (
            <span className="text-muted-foreground">
              · {monitor.resolution}
            </span>
          ) : null}
        </div>
        {dataUrl ? (
          <img
            src={dataUrl}
            alt="screen capture"
            className="max-h-56 rounded-md border border-border/60"
          />
        ) : null}
      </div>
    );
  }

  if (toolName === "list_directory") {
    const entries = Array.isArray(o.entries)
      ? (o.entries as Array<{ name: string; kind: string }>)
      : [];
    if (entries.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">empty</div>
      );
    }
    const dirs = entries.filter(
      (e) => e.kind === "directory" || e.kind === "dir",
    );
    const files = entries.filter(
      (e) => !(e.kind === "directory" || e.kind === "dir"),
    );
    return (
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px]">
        {dirs.map((e) => (
          <div
            key={`d-${e.name}`}
            className="flex items-center gap-1.5 truncate"
          >
            <HugeiconsIcon
              icon={FolderOpenIcon}
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate text-foreground">{e.name}/</span>
          </div>
        ))}
        {files.map((e) => (
          <div
            key={`f-${e.name}`}
            className="flex items-center gap-1.5 truncate"
          >
            <HugeiconsIcon
              icon={File01Icon}
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate text-muted-foreground">{e.name}</span>
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "bash_run") {
    return <BashRunOutput data={o} />;
  }

  if (toolName === "suggest_command") {
    const cmd = typeof o.command === "string" ? o.command : null;
    const explanation =
      typeof o.explanation === "string" ? o.explanation : null;
    if (!cmd) return null;
    return <SuggestCommandCard command={cmd} explanation={explanation} />;
  }

  if (toolName === "grep") {
    const hits = Array.isArray(o.hits)
      ? (o.hits as Array<{
          rel?: string;
          path?: string;
          line: number;
          text: string;
        }>)
      : [];
    const pattern = typeof o.pattern === "string" ? o.pattern : null;
    const truncated = Boolean(o.truncated);
    const filesScanned =
      typeof o.files_scanned === "number" ? o.files_scanned : null;

    if (hits.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">
          no matches
          {filesScanned != null ? ` · ${filesScanned} files scanned` : ""}
        </div>
      );
    }

    return (
      <div className="space-y-1">
        <div className="max-h-72 overflow-auto rounded bg-muted/30 font-mono text-[11px]">
          {hits.slice(0, 200).map((h, idx) => (
            <div
              key={`${h.rel ?? h.path}-${h.line}-${idx}`}
              className="flex gap-2 border-b border-border/30 px-2 py-1 last:border-b-0 hover:bg-muted/60"
            >
              <span className="shrink-0 text-muted-foreground">
                {h.rel ?? h.path}:{h.line}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">
                {pattern ? highlightMatch(h.text, pattern) : h.text}
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            {hits.length} hit{hits.length === 1 ? "" : "s"}
            {filesScanned != null ? ` · ${filesScanned} files` : ""}
          </span>
          {truncated ? (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-400">
              truncated
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  if (toolName === "glob") {
    const matches = Array.isArray(o.matches)
      ? (o.matches as string[])
      : Array.isArray(o.paths)
        ? (o.paths as string[])
        : [];
    if (matches.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">
          no matches
        </div>
      );
    }
    return (
      <div className="max-h-60 overflow-auto rounded bg-muted/30 px-2 py-1 font-mono text-[11px]">
        {matches.slice(0, 300).map((p) => (
          <div key={p} className="truncate text-muted-foreground">
            {p}
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "edit") {
    const ok = o.ok === true || typeof o.replacements === "number";
    if (ok) {
      const reps = typeof o.replacements === "number" ? o.replacements : null;
      const path = typeof o.path === "string" ? o.path : "";
      return (
        <div className="flex items-center gap-1.5 font-mono text-[11px]">
          <span className="text-emerald-600 dark:text-emerald-400">✓</span>
          {reps != null ? (
            <span className="text-foreground">
              {reps} replacement{reps === 1 ? "" : "s"}
            </span>
          ) : null}
          {path ? (
            <span className="text-muted-foreground">· {path}</span>
          ) : null}
        </div>
      );
    }
  }
  if (toolName === "batch_edit") {
    const ok = o.ok === true || typeof o.files === "number";
    if (ok) {
      const files = typeof o.files === "number" ? o.files : null;
      const reps = typeof o.replacements === "number" ? o.replacements : null;
      return (
        <div className="flex items-center gap-1.5 font-mono text-[11px]">
          <span className="text-emerald-600 dark:text-emerald-400">✓</span>
          <span className="text-foreground">
            {reps != null ? `${reps} edit${reps === 1 ? "" : "s"}` : "applied"}
          </span>
          {files != null ? (
            <span className="text-muted-foreground">
              · {files} file{files === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
      );
    }
  }

  if (toolName === "write_file" || toolName === "create_directory") {
    const path = typeof o.path === "string" ? o.path : "";
    const bytes = typeof o.bytesWritten === "number" ? o.bytesWritten : null;
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">
          {toolName === "create_directory" ? "created" : "wrote"}
        </span>
        {path ? <span className="text-muted-foreground">· {path}</span> : null}
        {bytes != null ? (
          <span className="text-muted-foreground">({formatBytes(bytes)})</span>
        ) : null}
      </div>
    );
  }

  if (toolName === "bash_background") {
    const handle = typeof o.handle === "string" ? o.handle : null;
    const cmd = typeof o.command === "string" ? o.command : "";
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
          {handle ? <span className="text-foreground">{handle}</span> : null}
          <span className="text-muted-foreground">running</span>
        </div>
        {cmd ? (
          <div className="truncate text-muted-foreground">{cmd}</div>
        ) : null}
      </div>
    );
  }

  return null;
}

function BashRunOutput({ data }: { data: Record<string, unknown> }) {
  const stdout = typeof data.stdout === "string" ? data.stdout : "";
  const stderr = typeof data.stderr === "string" ? data.stderr : "";
  const exit = typeof data.exit_code === "number" ? data.exit_code : null;
  const cwdAfter = typeof data.cwd_after === "string" ? data.cwd_after : null;
  const truncated = Boolean(data.truncated);
  const timedOut = Boolean(data.timed_out);

  const hasStdout = stdout.length > 0;
  const hasStderr = stderr.length > 0;
  const initial = hasStdout ? "stdout" : hasStderr ? "stderr" : "stdout";
  const [tab, setTab] = useState<"stdout" | "stderr">(initial);

  const tabs: Array<{
    key: "stdout" | "stderr";
    label: string;
    count: number;
  }> = [
    { key: "stdout", label: "stdout", count: stdout.length },
    { key: "stderr", label: "stderr", count: stderr.length },
  ];

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors",
              tab === t.key
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:text-foreground",
              t.count === 0 && "opacity-40",
            )}
            disabled={t.count === 0}
          >
            {t.label}
            {t.count > 0 ? (
              <span className="ml-1 text-muted-foreground">{t.count}</span>
            ) : null}
          </button>
        ))}
        <span className="flex-1" />
        {exit != null ? (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px]",
              exit === 0
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                : "bg-destructive/15 text-destructive",
            )}
          >
            exit {exit}
          </span>
        ) : null}
        {timedOut ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            timed out
          </span>
        ) : null}
        {truncated ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            truncated
          </span>
        ) : null}
      </div>
      <pre className="max-h-72 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {tab === "stdout" ? stdout || " " : stderr || " "}
      </pre>
      {cwdAfter ? (
        <div className="font-mono text-[10px] text-muted-foreground">
          cwd → {cwdAfter}
        </div>
      ) : null}
    </div>
  );
}

function highlightMatch(text: string, pattern: string): ReactNode {
  if (!pattern) return text;
  let re: RegExp;
  try {
    re = new RegExp(
      `(${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
      "gi",
    );
  } catch {
    return text;
  }
  const parts = text.split(re);
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded bg-amber-500/30 px-0.5 text-foreground">
        {p}
      </mark>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function CodeBlockMini({ code }: { code: string; language: string }) {
  // Tool input/output is debug-grade detail — JSON arrives pre-formatted and
  // file content is shown in the editor diff tab. Highlighting here is not
  // worth the parser hop.
  return (
    <pre className="max-h-60 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap">
      {code}
    </pre>
  );
}

function SuggestCommandCard({
  command,
  explanation,
}: {
  command: string;
  explanation: string | null;
}) {
  const [inserted, setInserted] = useState(false);
  const onInsert = () => {
    const ok = useChatStore
      .getState()
      .live.injectIntoActivePty(command);
    if (ok) setInserted(true);
  };
  return (
    <div className="space-y-1.5">
      {explanation ? (
        <div className="text-[11px] text-muted-foreground">{explanation}</div>
      ) : null}
      <div className="flex items-stretch gap-1.5 rounded bg-muted/40 overflow-hidden">
        <pre className="flex-1 overflow-auto p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {command}
        </pre>
        <button
          type="button"
          onClick={onInsert}
          disabled={inserted}
          className={cn(
            "shrink-0 flex items-center gap-1 px-2.5 text-[11px] font-medium",
            "border-l border-border/60",
            "hover:bg-muted/80 active:bg-muted",
            "disabled:opacity-60 disabled:cursor-default disabled:hover:bg-transparent",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
          aria-label="Insert into active terminal"
        >
          <HugeiconsIcon
            icon={inserted ? TerminalIcon : ArrowRight01Icon}
            size={12}
            strokeWidth={1.75}
          />
          <span>{inserted ? "Inserted" : "Insert"}</span>
        </button>
      </div>
    </div>
  );
}

// Compatibility re-exports — the previous API exposed these subcomponents,
// but the new compact <Tool /> takes everything via props. Kept as no-ops
// to avoid breaking accidental imports.
export const ToolHeader = () => null;
export const ToolContent = ({ children }: { children?: ReactNode }) => (
  <>{children}</>
);
export { ToolInput, ToolOutput };
