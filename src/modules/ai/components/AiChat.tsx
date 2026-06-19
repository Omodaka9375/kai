import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Tool } from "@/components/ai-elements/tool";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  CodeIcon,
  File01Icon,
  HashtagIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { SLASH_COMMANDS, Kai_CMD_RE } from "../lib/slashCommands";
import { Spinner } from "@/components/ui/spinner";
import { useChatStore, sendMessage } from "../store/chatStore";
import type {
  ChatStatus,
  DynamicToolUIPart,
  ToolUIPart,
  UIMessage,
  UIMessagePart,
} from "ai";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { AiToolApproval } from "./AiToolApproval";
import { MediaMessage, isMediaOutput } from "./MediaMessage";

function ForkButton({ messageIndex }: { messageIndex: number }) {
  const forkSession = useChatStore((s) => s.forkSession);
  const [forking, setForking] = useState(false);
  const onClick = () => {
    if (forking) return;
    setForking(true);
    void forkSession(messageIndex).finally(() => setForking(false));
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={forking}
      title="Fork conversation from here"
      className="ml-1 rounded p-0.5 text-muted-foreground/0 transition-colors group-hover/msg:text-muted-foreground/60 hover:!text-foreground"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M5 3v4a2 2 0 002 2h2m0 0V5m0 4l-2-2m2 2l2-2" />
      </svg>
    </button>
  );
}

function CommandSnippet({ name }: { name: string }) {
  const meta = SLASH_COMMANDS[name];
  if (!meta) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-2 py-1 font-mono text-[11px]">
        /{name}
      </div>
    );
  }
  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-border/50 bg-muted/40 px-2 py-1">
      <HugeiconsIcon
        icon={meta.icon}
        size={12}
        strokeWidth={1.75}
        className="shrink-0 text-foreground"
      />
      <span className="font-mono text-[11px] text-foreground">
        {meta.invocation}
      </span>
      <span className="truncate text-[11px] text-muted-foreground">
        {meta.label}
      </span>
    </div>
  );
}

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

type ContextChip =
  | { kind: "selection"; source: "terminal" | "editor"; lines: number }
  | { kind: "file"; name: string; lines: number }
  | { kind: "snippet"; name: string };

const SELECTION_RE =
  /<selection\s+source="(terminal|editor)">\n?([\s\S]*?)\n?<\/selection>/g;
const FILE_RE =
  /<file\s+name="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/file>/g;
const SNIPPET_RE = /<snippet\s+name="([^"]+)">\n?[\s\S]*?\n?<\/snippet>/g;

function countLines(s: string): number {
  if (!s) return 0;
  const trimmed = s.replace(/\n+$/, "");
  if (!trimmed) return 0;
  return trimmed.split("\n").length;
}

function stripUserContextBlocks(text: string): {
  text: string;
  chips: ContextChip[];
} {
  const chips: ContextChip[] = [];
  let out = text;
  out = out.replace(SELECTION_RE, (_m, source: string, body: string) => {
    chips.push({
      kind: "selection",
      source: source === "editor" ? "editor" : "terminal",
      lines: countLines(body),
    });
    return "";
  });
  out = out.replace(FILE_RE, (_m, name: string, body: string) => {
    chips.push({ kind: "file", name, lines: countLines(body) });
    return "";
  });
  out = out.replace(SNIPPET_RE, (_m, name: string) => {
    chips.push({ kind: "snippet", name });
    return "";
  });
  return { text: out.trim(), chips };
}

const ContextChips = memo(function ContextChips({
  chips,
}: {
  chips: ContextChip[];
}) {
  return (
    <div className="mb-1 flex flex-wrap gap-1">
      {chips.map((c, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-card/60 px-1.5 py-0.5 text-[10.5px] text-muted-foreground"
        >
          {chipIcon(c)}
          <span className="font-medium text-foreground">{chipLabel(c)}</span>
          {"lines" in c && c.lines > 0 ? (
            <span className="opacity-70">· {c.lines}L</span>
          ) : null}
        </span>
      ))}
    </div>
  );
});

function chipIcon(c: ContextChip) {
  if (c.kind === "selection") {
    return (
      <HugeiconsIcon
        icon={c.source === "editor" ? CodeIcon : TerminalIcon}
        size={10}
        strokeWidth={1.75}
      />
    );
  }
  if (c.kind === "file") {
    return <HugeiconsIcon icon={File01Icon} size={10} strokeWidth={1.75} />;
  }
  return <HugeiconsIcon icon={HashtagIcon} size={10} strokeWidth={1.75} />;
}

function chipLabel(c: ContextChip): string {
  if (c.kind === "selection") {
    return c.source === "editor" ? "Editor selection" : "Terminal selection";
  }
  if (c.kind === "file") return c.name;
  return `#${c.name}`;
}
type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

/** Strip leaked model thinking/channel tokens and raw tool call syntax. */
function stripLeakedTokens(text: string): string {
  return text
    .replace(/<\|channel\|?>[\s\S]*?<\|?channel\|>/gi, "")
    .replace(/<\|(?:start|end)_of_thought\|>/gi, "")
    .replace(/<\|thinking\|>[\s\S]*?<\| \/thinking\|>/gi, "")
    .replace(/<\|thinking\|>[\s\S]*?<\|?\/thinking\|>/gi, "")
    .replace(/<\|im_(?:start|end)\\|>[^\n]*/g, "")
    // Raw tool call syntax leaked by Gemma 4 and similar models.
    .replace(/<\|?tool_call_?[a-z_]*\|?>/gi, "")
    .replace(/<\|?\/tool_call_?[a-z_]*\|?>/gi, "")
    .replace(/call:[a-z_]+\{[^}]*\}(?:<[^>]*>)*/gi, "")
    .replace(/<tool_call>/gi, "")
    .replace(/<\/tool_call>/gi, "")
    // Strip raw leaked JSON tool-call payloads containing <|"|> delimiters
    .replace(/(?:^|,)?\s*\{[\s\S]*?(?:new_string|old_string|path|proposedContent|proposed_content)\s*:\s*<\|"\|>[\s\S]*?\}(?:\s*,?)?/gi, "")
    .replace(/<\|"\|>/g, "")
    // Strip any trailing partial or incomplete tags/tokens at the very end of the text stream
    .replace(/(?:<\|?|\|)[a-z_0-9\-]*$/i, "")
    .replace(/<[a-z_0-9\-]*$/i, "")
    .trim();
}

type ApprovalArg = {
  id: string;
  approved: boolean;
  reason?: string;
};

type Props = {
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  clearError: () => void;
  addToolApprovalResponse: (arg: ApprovalArg) => void | PromiseLike<void>;
  stop: () => void | PromiseLike<void>;
};

export function AiChatView({
  messages,
  status,
  error,
  clearError,
  addToolApprovalResponse,
}: Props) {
  const isBusy = status === "submitted" || status === "streaming";
  const lastMessage = messages[messages.length - 1];
  const showSpinner = isBusy && lastMessage?.role === "user";
  const streamingMessageId =
    status === "streaming" && lastMessage?.role === "assistant"
      ? lastMessage.id
      : null;
  const hitStepCap = useChatStore((s) => s.agentMeta.hitStepCap);
  const compactionNotice = useChatStore((s) => s.agentMeta.compactionNotice);
  const summarizing = useChatStore((s) => s.agentMeta.summarizing);
  const summaryNotice = useChatStore((s) => s.agentMeta.summaryNotice);
  const patchAgentMeta = useChatStore((s) => s.patchAgentMeta);
  const showContinue =
    !isBusy && hitStepCap && lastMessage?.role === "assistant";
  // Show "Done" when the agent finishes and the last visible part is a tool
  // call (no trailing text), so the user knows it stopped.
  const showDone = (() => {
    if (isBusy || status === "error" || hitStepCap) return false;
    if (!lastMessage || lastMessage.role !== "assistant") return false;
    const parts = lastMessage.parts;
    if (parts.length === 0) return false;
    const lastPart = parts[parts.length - 1];
    const type = (lastPart as { type?: string }).type ?? "";
    // If the last part is text, the agent already said something visible.
    if (type === "text") return false;
    // If it ends with a tool call, the user has no visual cue it's done.
    return type.startsWith("tool-") || type === "dynamic-tool";
  })();

  const onApproval = useCallback(
    (id: string, approved: boolean) => addToolApprovalResponse({ id, approved }),
    [addToolApprovalResponse],
  );

  if (messages.length === 0) {
    return (
      <Conversation>
        <ConversationContent>
          <ConversationEmptyState
            title="Ask anything"
            description="Explain command output, fix errors, generate snippets, or run a task."
          />
        </ConversationContent>
      </Conversation>
    );
  }

  return (
    <Conversation>
      <ConversationContent className="gap-5 p-3">
        {messages.map((m, idx) => (
          <div key={m.id} className="group/msg relative">
            <RenderedMessage
              message={m}
              onApproval={onApproval}
              streaming={m.id === streamingMessageId}
            />
            {!isBusy && m.role === "user" && idx > 0 && (
              <div className="absolute -top-1 right-0">
                <ForkButton messageIndex={idx} />
              </div>
            )}
          </div>
        ))}
        {compactionNotice && compactionNotice.droppedCount >= 3 && (
          <CompactionNotice
            droppedCount={compactionNotice.droppedCount}
            onDismiss={() => patchAgentMeta({ compactionNotice: null })}
          />
        )}
        {summaryNotice && (
          <SummaryNotice
            onDismiss={() => patchAgentMeta({ summaryNotice: null })}
          />
        )}
        {summarizing && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner />
            <span>Compressing context…</span>
          </div>
        )}
        {showSpinner && (
          <div className="flex text-xs text-muted-foreground">
            <GameOfLifeSpinner />
          </div>
        )}
        {showDone && (
          <div className="flex items-center gap-1.5 px-1 text-[11px] text-emerald-600 dark:text-emerald-400">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            Stopped
          </div>
        )}
        {showContinue && (
          <ContinueRow
            onContinue={() => {
              patchAgentMeta({ hitStepCap: false });
              void sendMessage(
                "Continue from where you stopped. Don't recap — just keep going.",
              );
            }}
          />
        )}
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <div className="font-medium">Something went wrong.</div>
            <div className="mt-0.5 leading-relaxed opacity-90">
              {error.message}
            </div>
            <button
              type="button"
              onClick={clearError}
              className="mt-1 underline opacity-80 hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

const CompactionNotice = memo(function CompactionNotice({
  droppedCount,
  onDismiss,
}: {
  droppedCount: number;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <span className="size-1.5 shrink-0 rounded-full bg-amber-500/80" />
      <span className="flex-1 truncate">
        Context compacted — {droppedCount} older tool result
        {droppedCount === 1 ? "" : "s"} elided to save tokens.
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="text-[10.5px] underline opacity-70 hover:opacity-100"
      >
        Dismiss
      </button>
    </div>
  );
});

const SummaryNotice = memo(function SummaryNotice({
  onDismiss,
}: {
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <span className="size-1.5 shrink-0 rounded-full bg-blue-500/80" />
      <span className="flex-1 truncate">
        Context summarized — earlier messages compressed.
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="text-[10.5px] underline opacity-70 hover:opacity-100"
      >
        Dismiss
      </button>
    </div>
  );
});

const ContinueRow = memo(function ContinueRow({
  onContinue,
}: {
  onContinue: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/50 bg-card/60 px-2.5 py-1.5 text-[11px]">
      <span className="flex-1 text-muted-foreground">
        Hit the step limit. Continue to keep going.
      </span>
      <button
        type="button"
        onClick={onContinue}
        className="rounded-md border border-border/60 bg-background px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
      >
        Continue
      </button>
    </div>
  );
});

const RenderedMessage = memo(function RenderedMessage({
  message,
  onApproval,
  streaming,
}: {
  message: UIMessage;
  onApproval: (id: string, approved: boolean) => void;
  streaming: boolean;
}) {
  // Index of the trailing text part — only that one is "live" mid-stream.
  // Earlier text parts (separated by tool calls) are already finalized.
  let lastTextIdx = -1;
  for (let i = message.parts.length - 1; i >= 0; i -= 1) {
    if (message.parts[i]?.type === "text") {
      lastTextIdx = i;
      break;
    }
  }
  if (message.role === "user") {
    const rawText = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");

    const cmdMatch = rawText.match(Kai_CMD_RE);
    const commandName = cmdMatch?.[1] ?? null;
    const withoutCmd = cmdMatch ? rawText.slice(cmdMatch[0].length) : rawText;
    const stripped = stripUserContextBlocks(withoutCmd);

    return (
      <Message from="user">
        <MessageContent>
          {commandName ? <CommandSnippet name={commandName} /> : null}
          {stripped.chips.length > 0 ? (
            <ContextChips chips={stripped.chips} />
          ) : null}
          {stripped.text ? (
            <p className="whitespace-pre-wrap wrap-break-word">
              {stripped.text}
            </p>
          ) : null}
        </MessageContent>
      </Message>
    );
  }

  const groups = useMemo(() => buildPartGroups(message.parts as AnyPart[]), [
    message.parts,
  ]);

  return (
    <Message from={message.role}>
      <MessageContent>
        <div className="flex flex-col gap-3">
          {groups.map((g) => {
            if (g.kind === "reads") {
              return (
                <PartAppear key={`${message.id}-${g.key}`}>
                  <ReadGroup parts={g.parts} />
                </PartAppear>
              );
            }
            const isReadSingle =
              partType(g.part) === "tool-read_file" &&
              ((g.part as { state?: string }).state ?? "") !==
                "approval-requested";
            if (isReadSingle) {
              return (
                <PartAppear key={`${message.id}-${g.key}`}>
                  <ReadRow part={g.part} />
                </PartAppear>
              );
            }
            return (
              <PartAppear key={`${message.id}-${g.key}`}>
                <RenderedPart
                  part={g.part}
                  onApproval={onApproval}
                  streaming={streaming && g.idx === lastTextIdx}
                />
              </PartAppear>
            );
          })}
        </div>
      </MessageContent>
    </Message>
  );
});

type Group =
  | { kind: "single"; part: AnyPart; idx: number; key: string }
  | { kind: "reads"; parts: AnyPart[]; key: string };

function partType(p: AnyPart): string {
  return (p as { type?: string }).type ?? "";
}

function isReadFilePart(p: AnyPart): boolean {
  if (partType(p) !== "tool-read_file") return false;
  const state = (p as { state?: string }).state ?? "";
  return state !== "approval-requested";
}

function partKey(p: AnyPart, idx: number): string {
  const tc = (p as { toolCallId?: string }).toolCallId;
  if (tc) return tc;
  const id = (p as { approval?: { id?: string } }).approval?.id;
  if (id) return id;
  return `i-${idx}`;
}

function buildPartGroups(parts: AnyPart[]): Group[] {
  const out: Group[] = [];
  let run: { parts: AnyPart[]; startIdx: number } | null = null;
  const flushRun = () => {
    if (!run) return;
    if (run.parts.length >= 2) {
      out.push({
        kind: "reads",
        parts: run.parts,
        key: `reads-${partKey(run.parts[0], run.startIdx)}`,
      });
    } else {
      run.parts.forEach((p, k) => {
        const idx = run!.startIdx + k;
        out.push({ kind: "single", part: p, idx, key: partKey(p, idx) });
      });
    }
    run = null;
  };
  parts.forEach((p, i) => {
    if (isReadFilePart(p)) {
      if (!run) run = { parts: [], startIdx: i };
      run.parts.push(p);
      return;
    }
    flushRun();
    out.push({ kind: "single", part: p, idx: i, key: partKey(p, i) });
  });
  flushRun();
  return out;
}

const GOL_WIDTH = 24;
const GLIDER_PATTERN = [[0, 0], [1, 1], [2, 1], [0, 2], [1, 0]];

export function GameOfLifeSpinner() {
  const [row, setRow] = useState<number[]>(() => {
    const arr = Array(GOL_WIDTH).fill(0);
    const startX = Math.floor(Math.random() * (GOL_WIDTH - 4));
    for (const [dx] of GLIDER_PATTERN) {
      arr[(startX + dx) % GOL_WIDTH] = 1;
    }
    for (let i = 0; i < GOL_WIDTH / 6; i++) {
      arr[Math.floor(Math.random() * GOL_WIDTH)] = 1;
    }
    return arr;
  });

  useEffect(() => {
    const step = () => {
      setRow((prev) => {
        const next = Array(GOL_WIDTH).fill(0);
        const w = GOL_WIDTH;
        for (let x = 0; x < w; x++) {
          const n =
            prev[(x - 1 + w) % w] + prev[x] + prev[(x + 1) % w] +
            prev[(x - 1 + w) % w]           + prev[(x + 1) % w] +
            prev[(x - 1 + w) % w] + prev[x] + prev[(x + 1) % w];
          const cur = prev[x];
          next[x] = (cur && (n === 2 || n === 3)) || (!cur && n === 3) ? 1 : 0;
        }

        const sum = next.reduce((a, b) => a + b, 0);
        if (sum === 0 || next.every((v, i) => v === prev[i])) {
          const arr = Array(GOL_WIDTH).fill(0);
          const startX = Math.floor(Math.random() * (GOL_WIDTH - 4));
          for (const [dx] of GLIDER_PATTERN) {
            arr[(startX + dx) % GOL_WIDTH] = 1;
          }
          for (let i = 0; i < GOL_WIDTH / 6; i++) {
            arr[Math.floor(Math.random() * GOL_WIDTH)] = 1;
          }
          return arr;
        }
        return next;
      });
    };

    const interval = setInterval(step, 100);
    return () => clearInterval(interval);
  }, []);

  return (
    <span className="inline-flex items-center gap-[1px] font-mono text-[10px] text-muted-foreground/60 select-none tracking-normal">
      {row.map((val, idx) => (
        <span
          key={idx}
          className={cn(
            "transition-colors duration-100",
            val === 1 ? "text-primary" : "text-muted-foreground/35"
          )}
        >
          {val === 1 ? "█" : "·"}
        </span>
      ))}
    </span>
  );
}

function readPathFromPart(p: AnyPart): string | null {
  const input = (p as { input?: { path?: unknown } }).input;
  const path = input?.path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

const ReadGroup = memo(function ReadGroup({ parts }: { parts: AnyPart[] }) {
  const paths = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of parts) {
      const path = readPathFromPart(p);
      if (!path) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
    return out;
  }, [parts]);
  const count = paths.length || parts.length;
  const preview = paths.map(basename).join(", ");

  return (
    <Collapsible className="group/read overflow-hidden rounded-md border border-border/50 bg-card/50">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px]",
          "transition-colors hover:bg-muted/50",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={11}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            "group-data-[state=open]/read:rotate-90",
          )}
        />
        <HugeiconsIcon
          icon={File01Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">Read</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {count} file{count === 1 ? "" : "s"}
        </span>
        {paths.length > 0 ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/80 group-data-[state=open]/read:invisible">
            · {preview}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="Kai-collapsible-content border-t border-border/30">
        <ul className="flex flex-col gap-0.5 px-2 py-1.5">
          {paths.map((path) => (
            <li
              key={path}
              className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
            >
              <HugeiconsIcon
                icon={File01Icon}
                size={10}
                strokeWidth={1.75}
                className="shrink-0 opacity-60"
              />
              <span className="truncate text-foreground">
                {basename(path)}
              </span>
              <span className="truncate opacity-60">{path}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
});

const PartAppear = memo(function PartAppear({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      style={{ willChange: "transform, opacity" }}
    >
      {children}
    </motion.div>
  );
});

const ReadRow = memo(function ReadRow({ part }: { part: AnyPart }) {
  const path = readPathFromPart(part);
  const state = (part as { state?: string }).state ?? "";
  const isError = state === "output-error";
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isError
            ? "bg-destructive"
            : "border border-muted-foreground/40 bg-transparent",
        )}
      />
      <HugeiconsIcon
        icon={File01Icon}
        size={13}
        strokeWidth={1.75}
        className="shrink-0 text-muted-foreground"
      />
      <span className="shrink-0 font-medium text-foreground">Read</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
        {path ?? ""}
      </span>
    </div>
  );
});

const RenderedPart = memo(function RenderedPart({
  part,
  onApproval,
  streaming,
}: {
  part: AnyPart;
  onApproval: (id: string, approved: boolean) => void;
  streaming: boolean;
}) {
  if (part.type === "text") {
    const raw = (part as unknown as { text: string }).text;
    const cleaned = stripLeakedTokens(raw);
    if (!cleaned) return null;
    return (
      <MessageResponse streaming={streaming}>
        {cleaned}
      </MessageResponse>
    );
  }

  if (part.type === "reasoning") {
    const reasoningText = stripLeakedTokens(
      (part as unknown as { text: string }).text,
    );
    if (!reasoningText) return null;
    return (
      <Reasoning>
        <ReasoningTrigger />
        <ReasoningContent>{reasoningText}</ReasoningContent>
      </Reasoning>
    );
  }

  if (
    part.type === "dynamic-tool" ||
    (typeof part.type === "string" && part.type.startsWith("tool-"))
  ) {
    return (
      <RenderedTool
        part={part as unknown as AnyToolPart}
        onApproval={onApproval}
      />
    );
  }

  return null;
});

const RenderedTool = memo(function RenderedTool({
  part,
  onApproval,
}: {
  part: AnyToolPart;
  onApproval: (id: string, approved: boolean) => void;
}) {
  const toolName =
    part.type === "dynamic-tool"
      ? part.toolName
      : part.type.replace(/^tool-/, "");

  if (part.state === "approval-requested") {
    return (
      <AiToolApproval
        part={part as Extract<ToolUIPart, { state: "approval-requested" }>}
        toolName={toolName}
        onRespond={(approved) => onApproval(part.approval.id, approved)}
      />
    );
  }

  // Render generated images/videos inline instead of as collapsed tool output.
  if (
    (toolName === "generate_image" || toolName === "generate_video") &&
    "output" in part &&
    isMediaOutput(part.output)
  ) {
    return <MediaMessage output={part.output} />;
  }

  return (
    <Tool
      toolName={toolName}
      state={part.state}
      input={part.input}
      output={"output" in part ? part.output : undefined}
      errorText={"errorText" in part ? part.errorText : undefined}
      defaultOpen={toolName === "list_directory"}
    />
  );
});
