import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextTrigger,
} from "@/components/ai-elements/context";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useChat, type Chat, type UIMessage } from "@ai-sdk/react";
import {
  Add01Icon,
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  Delete02Icon,
  FilterIcon,
  GitMergeIcon,
  PencilEdit01Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SandboxBadge } from "./SandboxBadge";
import { ShadowStrip, ShadowSessionMenuItem } from "./ShadowStrip";
import { estimateCost, getModel, getModelContextLimit } from "../config";
import { effectiveContextLimit, SYSTEM_OVERHEAD_TOKENS } from "../lib/compact";
import { type SessionMeta } from "../lib/sessions";
import { absoluteTime, relativeTime } from "../lib/relativeTime";
import { normalizeWorkspacePath } from "../lib/workspacePath";
import { getOrCreateChat, useChatStore } from "../store/chatStore";
import { getGroups } from "../store/groupChatStore";
import { Input } from "@/components/ui/input";
import { usePlanStore } from "../store/planStore";
import { AgentSwitcher } from "./AgentSwitcher";
import { AiChatView, GameOfLifeSpinner } from "./AiChat";
import { PlanDiffReview } from "./PlanDiffReview";
import { TodoStrip } from "./TodoStrip";
import { useComposer } from "./composer";
import { cancelAllShellSessions } from "../tools/shell";

/** Transcript renders below this message count mount instantly (warm
 *  session switches feel unchanged). Above it, the first paint shows the
 *  shell + spinner and the full transcript fills in on the next idle. */
const HEAVY_TRANSCRIPT_MESSAGES = 40;

/** Two-phase transcript mount - the fix for the switch-mid-stream freeze.
 *
 * Rendering the FULL transcript of a large session is the single most
 * expensive synchronous render in KAI: every message x markdown/code
 * parts, hundreds of DOM nodes, all in ONE commit. A project switch
 * mounts the incoming project's window, and that render used to land in
 * the SAME commit as the visibility flip + the outgoing project's
 * still-streaming window - the UI froze for seconds until it finished.
 * Now the shell paints first (header, strips, input - cheap), and the
 * transcript renders two animation frames later, off the interaction.
 * Ready state is keyed to the Chat identity so switching sessions inside
 * the window re-evaluates: small transcripts still mount instantly,
 * heavy ones re-defer. */
function useDeferredTranscript(chat: Chat<UIMessage>): boolean {
  const heavy = chat.messages.length > HEAVY_TRANSCRIPT_MESSAGES;
  const [readyFor, setReadyFor] = useState<Chat<UIMessage> | null>(
    heavy ? null : chat,
  );
  const ready = readyFor === chat || !heavy;
  useEffect(() => {
    if (ready) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setReadyFor(chat));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [ready, chat]);
  return ready;
}
const SUGGESTIONS = [
  {
    label: "Explain the last error",
    hint: "Read the terminal buffer",
    icon: AlertCircleIcon,
    text: "Explain the last error in the terminal.",
  },
  {
    label: "Generate a command",
    hint: "Tell me what you want to do",
    icon: TerminalIcon,
    text: "Give me a command to ",
  },
  {
    label: "Summarize buffer",
    hint: "Recap recent activity",
    icon: FilterIcon,
    text: "Summarize what just happened in the terminal.",
  },
];

export function AiMiniWindow() {
  const sessionId = useChatStore((s) => s.activeSessionId);
  // Expanded state lives in the store (not local useState) so App can
  // collapse the window when the user opens a file — an expanded AI window
  // covers the editor, and the file would open behind it invisibly.
  const expanded = useChatStore((s) => s.mini.expanded);
  // The group pill sits directly below this window when a group exists and
  // the AI owns the expanded slot — the window's bottom offset grows by one
  // pill height + gap (84 = 42 base + 42 pill) so they stack.
  const groupPillVisible =
    useChatStore((s) => s.stackRail.surface !== "group") &&
    getGroups().length > 0;
  const setMiniExpanded = useChatStore((s) => s.setMiniExpanded);
  const toggleExpand = useCallback(
    () => setMiniExpanded(!expanded),
    [setMiniExpanded, expanded],
  );
  const c = useComposer();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // If any child already handled this Escape (dropdown, autocomplete,
        // file-trigger dismiss, etc.), don't steal it.
        if (e.defaultPrevented) return;
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        // CodeMirror (and any contenteditable surface) reports tagName "DIV" —
        // without this check, pressing Escape in the editor (dismiss
        // autocomplete, vim normal mode) would silently kill a running agent.
        if (target?.isContentEditable || target?.closest("[contenteditable]")) {
          return;
        }
        // Same for the terminal: xterm renders into a div/canvas and forwards
        // Escape to the shell (vim, fzf, menus). The raw keydown still bubbles
        // to window — don't let it stop the agent.
        if (target?.closest(".xterm")) return;
        if (c.isBusy) {
          e.preventDefault();
          cancelAllShellSessions(useChatStore.getState().activeSessionId ?? undefined);
          c.stop();
        }
        // Intentionally do NOT close the mini-window on Escape —
        // the open/close button controls window visibility.
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [c.isBusy, c.stop]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.98 }}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
      data-ai-mini-window
      className={cn(
        "no-scrollbar-deep fixed z-40 flex flex-col overflow-hidden",
        "rounded-2xl border border-border/60 bg-card text-[12px]",
        "shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_24px_48px_-12px_rgba(0,0,0,0.45),0_8px_16px_-8px_rgba(0,0,0,0.3)]",
        "ring-1 ring-black/5 dark:ring-white/5",
        "transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
        expanded
          ? "top-[2.85rem] right-2 bottom-[calc(var(--kai-input-bar-h,0px)+42px)] left-[calc(var(--kai-workspace-left,0px)+8px)] rounded-xl"
          : "right-2 bottom-[calc(var(--kai-input-bar-h,0px)+42px)] h-[min(42rem,calc(100vh-var(--kai-input-bar-h,0px)-92px))] w-[min(34rem,calc(100vw-2rem))]",
        // Shrink up by one pill height + gap when the group pill is stacked
        // below (84 = 42 base + 42 pill).
        !expanded && groupPillVisible &&
          "bottom-[calc(var(--kai-input-bar-h,0px)+84px)] h-[min(42rem,calc(100vh-var(--kai-input-bar-h,0px)-134px))]",
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-foreground/[0.03] to-transparent"
      />
      {sessionId ? (
        <Body
          sessionId={sessionId}
          onExpand={toggleExpand}
          expanded={expanded}
        />
      ) : (
        <EmptyShell onExpand={toggleExpand} expanded={expanded} />
      )}
      <PlanDiffReview />
    </motion.div>
  );
}

function Body({
  sessionId,
  onExpand,
  expanded,
}: {
  sessionId: string;
  onExpand: () => void;
  expanded: boolean;
}) {
  const focusInput = useChatStore((s) => s.focusInput);
  const c = useComposer();

  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const transcriptReady = useDeferredTranscript(chat);
  // Same rationale as AgentRunBridge: the mini window is always mounted and
  // shares the Chat with the main bridge — an unthrottled subscriber here
  // would keep per-chunk setStates (and #185 re-entrancy) alive even with
  // the bridge throttled.
  const helpers = useChat<UIMessage>({ chat, experimental_throttle: 50 });

  return (
    <>
      <Header
        onExpand={onExpand}
        expanded={expanded}
        messages={helpers.messages}
      />

      <PlanModeStrip />

      <div className="flex min-h-0 flex-1 flex-col">
        {helpers.messages.length === 0 ? (
          <EmptyState onPick={focusInput} />
        ) : transcriptReady ? (
          <div className="flex min-h-0 flex-1 flex-col [&_.text-sm]:text-[12px] [&_p]:leading-relaxed">
            <AiChatView
              messages={helpers.messages}
              status={helpers.status}
              error={helpers.error}
              clearError={helpers.clearError}
            />
          </div>
        ) : (
          // Heavy transcript deferred past the switch commit - paint the
          // shell now, fill the history on the next idle.
          <div className="flex flex-1 items-center justify-center">
            <GameOfLifeSpinner />
          </div>
        )}
      </div>

      <TodoStrip
        sessionId={sessionId}
        isBusy={c.isBusy}
        onStop={() => {
          cancelAllShellSessions(useChatStore.getState().activeSessionId ?? undefined);
          c.stop();
        }}
      />
      <ShadowStrip sessionId={sessionId} />
    </>
  );
}

function PlanModeStrip() {
  const active = usePlanStore((s) => s.active);
  const queueLen = usePlanStore((s) => s.queue.length);
  const disable = usePlanStore((s) => s.disable);
  if (!active) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/40 bg-muted/40 px-3 py-1.5">
      <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
      <span className="text-[11px] font-medium text-foreground">Plan mode</span>
      <span className="text-[11px] text-muted-foreground">
        {queueLen > 0 ? `· ${queueLen} queued` : "· no edits queued"}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => disable()}
        className="rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        Exit
      </button>
    </div>
  );
}

function EmptyShell({
  onExpand,
  expanded,
}: {
  onExpand: () => void;
  expanded: boolean;
}) {
  return (
    <>
      <Header
        step={null}
        isBusy={false}
        onExpand={onExpand}
        expanded={expanded}
      />
      <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
        Loading sessions…
      </div>
    </>
  );
}

function Header({
  onExpand,
  expanded,
  messages,
}: {
  onExpand: () => void;
  expanded?: boolean;
  messages?: UIMessage[];
  step?: string | null;
  isBusy?: boolean;
}) {
  const expandLabel = expanded ? "Collapse to mini window" : "Expand to panel";

  return (
    <div className="relative flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
      <div className="flex min-w-0 items-center gap-1.5">
        <AgentSwitcher isMiniWindow />
        <SandboxBadge />
        {messages !== undefined ? (
          <ContextIndicator messages={messages} />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <SessionPicker />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={onExpand}
          className="size-5"
          aria-label={expandLabel}
          title={expandLabel}
        >
          <HugeiconsIcon icon={expanded ? ArrowShrink01Icon : ArrowExpand01Icon} size={11} strokeWidth={1.75} />
        </Button>
      </div>
    </div>
  );
}

function estimateTokens(messages: UIMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "text") {
        chars += (p as { text?: string }).text?.length ?? 0;
      } else if (p.type === "reasoning") {
        chars += (p as { text?: string }).text?.length ?? 0;
      } else if (typeof p.type === "string" && p.type.startsWith("tool-")) {
        const tp = p as unknown as { input?: unknown; output?: unknown };
        if (tp.input) chars += JSON.stringify(tp.input).length;
        if (tp.output) chars += JSON.stringify(tp.output).length;
      } else if (p.type === "file") {
        // Count file/image parts — data URLs can be multi-MB.
        // Image tokens vary by provider (e.g. OpenAI: ~85 tokens per 512×512 tile),
        // but a rough estimate of data length / 4 gives a conservative lower bound.
        const fp = p as { url?: string; data?: string };
        const data = fp.url ?? fp.data ?? "";
        chars += data.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function ContextIndicator({ messages }: { messages: UIMessage[] }) {
  const modelId = useChatStore((s) => s.selectedModelId);
  const tokens = useChatStore((s) => s.agentMeta.tokens);
  const lastInput = useChatStore((s) => s.agentMeta.lastInputTokens);
  const lastCached = useChatStore((s) => s.agentMeta.lastCachedTokens);
  // estimateTokens JSON.stringifies every tool input/output — up to 256 KB
  // per shell result — so recomputing per streamed chunk (messages gets a new
  // identity on every chunk) is O(history × chunks). Throttle to 1×/second
  // while streaming; recompute exactly once when it settles.
  const [estimated, setEstimated] = useState(() => estimateTokens(messages));
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => {
    setEstimated(estimateTokens(messages));
    const t = setInterval(() => {
      setEstimated(estimateTokens(messagesRef.current));
    }, 1000);
    return () => clearInterval(t);
  }, [messages]);
  // The provider reports the size of the request it actually received —
  // AFTER compaction elided/truncated tool results. A huge raw history can
  // trip compaction while `lastInput` stays small, which made the ring look
  // fine while the pipeline was already compressing. Take the max of the
  // two so the indicator reflects raw-history pressure, never less.
  const used = lastInput > 0 ? Math.max(lastInput, estimated) : estimated;
  const reported = tokens.inputTokens + tokens.outputTokens;
  // The conversation budget is the model window minus system prompt + tool
  // schemas. Compaction thresholds (40/60/75%) are measured against this same
  // effective limit — using it as the ring denominator keeps the UI honest
  // about when compaction will trigger, instead of showing a low percentage
  // against the raw model window while the pipeline is already compacting.
  const max = effectiveContextLimit(getModelContextLimit(modelId));
  const modelLabel = useMemo(() => {
    try {
      return getModel(modelId).label;
    } catch {
      return modelId;
    }
  }, [modelId]);
  const cost = estimateCost(modelId, tokens);
  const cacheRate =
    tokens.inputTokens > 0
      ? Math.round((tokens.cachedInputTokens / tokens.inputTokens) * 100)
      : 0;

  return (
    <Context usedTokens={used} maxTokens={max} modelId={modelId}>
      <ContextTrigger className="h-6 gap-1 px-0 text-[10.5px]" />
      <ContextContent className="w-64 text-[11px]">
        <ContextContentHeader />
        <ContextContentBody>
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Model</span>
            <span className="font-mono text-foreground">{modelLabel}</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-muted-foreground">
            <span>{used === lastInput && used > 0 ? "Last request" : "Estimated context"}</span>
            <span className="font-mono text-foreground">
              {formatTokens(used)}
            </span>
          </div>
          {lastCached > 0 && (
            <div className="flex items-center justify-between text-muted-foreground">
              <span>Of which cached</span>
              <span className="font-mono text-foreground">
                {formatTokens(lastCached)}
              </span>
            </div>
          )}
          {reported > 0 && (
            <>
              <div className="mt-1.5 flex items-center justify-between text-muted-foreground">
                <span>Session input</span>
                <span className="font-mono text-foreground">
                  {formatTokens(tokens.inputTokens)}
                </span>
              </div>
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Session output</span>
                <span className="font-mono text-foreground">
                  {formatTokens(tokens.outputTokens)}
                </span>
              </div>
              {tokens.cachedInputTokens > 0 && (
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>Cache hit</span>
                  <span className="font-mono text-foreground">{cacheRate}%</span>
                </div>
              )}
              {cost != null && (
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>Session cost</span>
                  <span className="font-mono text-foreground">
                    ${cost.toFixed(cost < 0.01 ? 4 : cost < 1 ? 3 : 2)}
                  </span>
                </div>
              )}
            </>
          )}
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Window</span>
            <span className="font-mono text-foreground">
              {formatTokens(max)}
            </span>
          </div>
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Model window</span>
            <span className="font-mono text-foreground">
              {formatTokens(getModelContextLimit(modelId))}
            </span>
          </div>
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Reserved (system+tools)</span>
            <span className="font-mono text-foreground">
              {formatTokens(Math.min(SYSTEM_OVERHEAD_TOKENS, getModelContextLimit(modelId)))}
            </span>
          </div>
        </ContextContentBody>
        <ContextContentFooter>
          <span className="text-[10px] italic text-muted-foreground">
            Ring shows pressure on the conversation budget (model window minus
            system prompt + tool schemas); compaction starts at 40%.
          </span>
        </ContextContentFooter>
      </ContextContent>
    </Context>
  );
}

function SessionPicker() {
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const newSession = useChatStore((s) => s.newSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const workspaceRoot = useChatStore((s) => s.live.getWorkspaceRoot());

  // RULES OF HOOKS: every hook must run on every render. This component
  // previously early-returned on `!active` BEFORE useMemo/useState below —
  // whenever a re-render landed mid-transition with active == null (e.g.
  // resolving an approval re-rendering the picker before activeSessionId
  // settled), React threw #310 ("rendered fewer hooks"), the mini-window
  // error boundary caught it and unmounted the whole window — the
  // intermittent "approving collapses the AI window" bug. Compute everything,
  // THEN branch in JSX.
  const filteredSessions = useMemo(() => {
    if (!workspaceRoot) return sessions;
    const normalized = normalizeWorkspacePath(workspaceRoot);
    const norm = (s: SessionMeta) => normalizeWorkspacePath(s.workspaceRoot ?? "");
    return sessions.filter((s) => {
      // Always show the active session regardless of workspace.
      if (s.id === activeId) return true;
      if (!s.workspaceRoot) return false;
      return norm(s) === normalized;
    });
  }, [sessions, workspaceRoot, activeId]);

  const sorted = [...filteredSessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const [menuOpen, setMenuOpen] = useState(false);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  if (!active) return null;

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex min-w-0 max-w-32 items-center gap-1 rounded-md px-1.5 py-1",
            "text-[11px] text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-foreground",
          )}
          title="Switch session"
        >
          <span className="truncate">{active.title || "New chat"}</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={10}
            strokeWidth={2}
            className="opacity-70"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60vh] min-w-56 max-w-72 overflow-y-auto">
        <DropdownMenuItem
          onSelect={() => newSession()}
          className="gap-2 text-xs"
        >
          <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
          New session
        </DropdownMenuItem>
        <ShadowSessionMenuItem close={() => setMenuOpen(false)} />
        {sorted.length > 0 ? <DropdownMenuSeparator /> : null}
        {sorted.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={s.id === activeId}
            otherSessions={sorted.filter((o) => o.id !== s.id)}
            onSelect={() => switchSession(s.id)}
            onDelete={() => deleteSession(s.id)}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SessionRow({
  session,
  active,
  otherSessions,
  onSelect,
  onDelete,
}: {
  session: SessionMeta;
  active: boolean;
  otherSessions: SessionMeta[];
  onSelect: () => void;
  onDelete: () => void;
}) {
  const renameSession = useChatStore((s) => s.renameSession);
  const mergeSession = useChatStore((s) => s.mergeSession);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title || "");
  const [mergeOpen, setMergeOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== (session.title || "")) {
      renameSession(session.id, trimmed);
    }
    setEditing(false);
  };

  useEffect(() => {
    if (editing) {
      setDraft(session.title || "");
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, session.title]);

  return (
    <DropdownMenuItem
      onSelect={(e) => {
        // Don't dismiss if user clicked controls — handle below.
        const target = e.target as HTMLElement | null;
        if (
          target?.closest("[data-session-delete]") ||
          target?.closest("[data-session-edit]") ||
          target?.closest("[data-session-merge]") ||
          target?.tagName === "INPUT"
        ) {
          e.preventDefault();
          return;
        }
        onSelect();
      }}
      className={cn(
        "group relative flex items-center justify-between gap-2 text-xs",
        active && "bg-accent/40",
      )}
    >
      {editing ? (
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              setEditing(false);
            }
          }}
          className="h-6 min-w-0 flex-1 px-1.5 py-0 font-sans text-[11px]"
        />
      ) : (
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            // Idle: full row width — the action icons take NO layout space.
            // Hover/focus-within: reserve room on the right for them so the
            // title never runs under the floated icon cluster.
            "transition-[padding] duration-150 group-hover:pr-14 group-focus-within:pr-14",
          )}
        >
          {session.title || "New chat"}
          {relativeTime(session.updatedAt ?? session.createdAt) ? (
            <span
              className={cn(
                "block truncate text-[10px] leading-tight text-muted-foreground/70",
                active && "text-muted-foreground",
              )}
              title={absoluteTime(session.updatedAt ?? session.createdAt) || undefined}
            >
              {relativeTime(session.updatedAt ?? session.createdAt)}
            </span>
          ) : null}
        </span>
      )}
      {editing ? null : (
        <div
          className={cn(
            // Floated above the row's right edge — takes NO layout space, so
            // the title spans the full row width when idle; it yields (via
            // the title's group-hover padding) once the icons fade in.
            "absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1",
            "pointer-events-none opacity-0 transition-opacity",
            "group-hover:pointer-events-auto group-hover:opacity-100",
            "group-focus-within:pointer-events-auto group-focus-within:opacity-100",
          )}
        >
          {otherSessions.length > 0 ? (
            <Popover open={mergeOpen} onOpenChange={setMergeOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-session-merge
                  onClick={(e) => e.stopPropagation()}
                  title="Merge into another session"
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <HugeiconsIcon icon={GitMergeIcon} size={11} strokeWidth={1.75} />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                sideOffset={4}
                className="z-[60] w-60 gap-0 rounded-xl p-1.5 text-sm"
              >
                <div className="px-1.5 pb-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Merge into…
                </div>
                {otherSessions.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => {
                      setMergeOpen(false);
                      void mergeSession(session.id, o.id);
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                  >
                    <HugeiconsIcon
                      icon={GitMergeIcon}
                      size={11}
                      strokeWidth={1.75}
                      className="shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {o.title || "New chat"}
                    </span>
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          ) : null}
          <button
            type="button"
            data-session-edit
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            title="Rename session"
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={PencilEdit01Icon} size={11} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            data-session-delete
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete session"
            className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.75} />
          </button>
        </div>
      )}
    </DropdownMenuItem>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8 py-10 text-center">
      <img src="/logo.png" alt="Kai" className="size-14 opacity-90" />
      <div className="space-y-1.5">
        <p className="text-[14px] font-semibold tracking-tight">
          Ask Kai anything
        </p>
        <p className="max-w-[18rem] text-[11.5px] leading-relaxed text-muted-foreground">
          Kai sees the active terminal — cwd, recent commands, and output.
        </p>
      </div>
      <div className="flex w-full flex-col gap-2.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => onPick(s.text)}
            className={cn(
              "group flex items-center gap-2.5 bg-card/70 rounded-lg px-2.5 py-2 border border-border text-left",
              "transition-colors hover:bg-muted/50 hover:text-foreground",
            )}
          >
            <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/70 text-muted-foreground transition-colors group-hover:bg-foreground/5 group-hover:text-foreground">
              <HugeiconsIcon icon={s.icon} size={13} strokeWidth={1.75} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium text-foreground">
                {s.label}
              </div>
              <div className="text-[10.5px] text-muted-foreground">
                {s.hint}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
