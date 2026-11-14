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
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import AlertCircleIcon from "@hugeicons/core-free-icons/AlertCircleIcon";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowExpand01Icon from "@hugeicons/core-free-icons/ArrowExpand01Icon";
import ArrowShrink01Icon from "@hugeicons/core-free-icons/ArrowShrink01Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import MinusSignIcon from "@hugeicons/core-free-icons/MinusSignIcon";
import FilterIcon from "@hugeicons/core-free-icons/FilterIcon";
import GitMergeIcon from "@hugeicons/core-free-icons/GitMergeIcon";
import PencilEdit01Icon from "@hugeicons/core-free-icons/PencilEdit01Icon";
import Pin02Icon from "@hugeicons/core-free-icons/Pin02Icon";
import TerminalIcon from "@hugeicons/core-free-icons/TerminalIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { SandboxBadge } from "./SandboxBadge";
import { ShadowStrip, ShadowSessionMenuItem } from "./ShadowStrip";
import { TelegramMonitorMenuItem } from "./TelegramMonitorMenuItem";
import { estimateCost, getModel, getModelContextLimit } from "../config";
import { effectiveContextLimit, SYSTEM_OVERHEAD_TOKENS } from "../lib/compact";
import { type SessionMeta } from "../lib/sessions";
import { estimateContextTokens } from "../lib/media/contextTokens";
import { absoluteTime, relativeTime } from "../lib/relativeTime";
import { normalizeWorkspacePath } from "../lib/workspacePath";
import {
  activeProjectId,
  getActiveProjectVersion,
  getOrCreateChat,
  isGhostSession,
  subscribeActiveProject,
  useChatStore,
} from "../store/chatStore";
import {
  getGroupStoreVersion,
  groupsForProject,
  subscribeGroupChats,
} from "../store/groupChatStore";
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

import { AiWindowBackdrop, AI_EXPANDED_WINDOW_GEOMETRY } from "./AiWindowBackdrop";

export function AiMiniWindow() {
  const sessionId = useChatStore((s) => s.activeSessionId);
  // Expanded state lives in the store (not local useState) so App can
  // collapse the window when the user opens a file — an expanded AI window
  // covers the editor, and the file would open behind it invisibly.
  const expanded = useChatStore((s) => s.mini.expanded);
  // The group pill sits directly below this window when a group exists and
  // the AI owns the expanded slot — the window's bottom offset grows by one
  // pill height + gap (84 = 42 base + 42 pill) so they stack.
  // The live-group lookup is read imperatively (it is not a hook), so this
  // component must ALSO subscribe to the group store — otherwise the pill
  // flag goes stale on group create/delete and the un-shrunk window sits on
  // the exact same +42px strip (same z-40), hiding the pill behind it.
  const groupStoreVersion = useSyncExternalStore(
    subscribeGroupChats,
    getGroupStoreVersion,
    getGroupStoreVersion,
  );
  // The ACTIVE PROJECT is chatStore module state — a project switch bumps
  // NO store this flag reads, so it must be SUBSCRIBED explicitly
  // (2026-11-01: "switch to a normal project and come back — the collapsed
  // group chat is not there, just a gap"). A memo keyed on the group store
  // alone froze across switches: stale-true kept the +84px lift on a
  // project with no pill (the gap), stale-false sat the window at +42px ON
  // the pill's strip, covering a pill that painted correctly underneath.
  const activeProjectVersion = useSyncExternalStore(
    subscribeActiveProject,
    getActiveProjectVersion,
    getActiveProjectVersion,
  );
  const stackSurface = useChatStore((s) => s.stackRail.surface);
  // PILL-VISIBLE must use the SAME predicate the pill itself paints by:
  // the ACTIVE project is a participant in a LIVE group (groupsForProject
  // filters endedAt). Counting ALL groups instead reserved the +42px strip
  // for an ended-but-not-deleted group, or a live group between two OTHER
  // projects, while the pill (scoped 2026-10-31) stayed hidden: a reserved
  // empty strip under the window with nothing in it ("the gap where the
  // pill was"). One predicate, no split-brain. groupsForProject/
  // activeProjectId are read imperatively (not hooks) — the two
  // subscriptions above re-run this on every group change AND every
  // project switch; the surface arrives via its zustand selector.
  const groupPillVisible = useMemo(
    () =>
      stackSurface !== "group" &&
      groupsForProject(activeProjectId() ?? "").length > 0,
    [groupStoreVersion, activeProjectVersion, stackSurface],
  );
  const setMiniExpanded = useChatStore((s) => s.setMiniExpanded);
  const toggleExpand = useCallback(
    () => setMiniExpanded(!expanded),
    [setMiniExpanded, expanded],
  );
  // MINIMIZE ( _ ), the twin of the group panel's minimize: hides the
  // window (mini.open = false) but KEEPS the AI panel open, so the AI pill
  // stays in the bottom strip as the re-entry surface - same
  // collapse-to-pill pattern the group chat uses. A running agent keeps
  // streaming (the bridge is independent of the window).
  const closeMini = useChatStore((s) => s.closeMini);
  const onMinimize = useCallback(() => {
    setMiniExpanded(false);
    closeMini();
  }, [setMiniExpanded, closeMini]);
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
    <>
      {/* Corner-crack matte: the expanded window's rounded corners + translucent
          border let editor/terminal content leak through; this covers the rect
          behind it (see AiWindowBackdrop). */}
      <AiWindowBackdrop active={expanded} />
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
          ? `${AI_EXPANDED_WINDOW_GEOMETRY} rounded-xl`
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
          onMinimize={onMinimize}
          expanded={expanded}
        />
      ) : (
        <EmptyShell onExpand={toggleExpand} onMinimize={onMinimize} expanded={expanded} />
      )}
      <PlanDiffReview />
    </motion.div>
    </>
  );
}

function Body({
  sessionId,
  onExpand,
  onMinimize,
  expanded,
}: {
  sessionId: string;
  onExpand: () => void;
  onMinimize: () => void;
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
        onMinimize={onMinimize}
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
  onMinimize,
  expanded,
}: {
  onExpand: () => void;
  onMinimize: () => void;
  expanded: boolean;
}) {
  return (
    <>
      <Header
        step={null}
        isBusy={false}
        onExpand={onExpand}
        onMinimize={onMinimize}
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
  onMinimize,
  expanded,
  messages,
}: {
  onExpand: () => void;
  onMinimize?: () => void;
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
        {/* Minimize ( _ ) BEFORE the expand arrow - same order as the group
            panel's header (minimize, then expand), 2026-11-06 ask.
            Minimize collapses the window to the AI pill in the bottom
            strip; the agent keeps running; the pill re-opens it. */}
        {onMinimize ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={onMinimize}
            className="size-5"
            aria-label="Minimize to pill"
            title="Minimize — the agent keeps running, the pill re-opens this window"
          >
            <HugeiconsIcon icon={MinusSignIcon} size={11} strokeWidth={1.75} />
          </Button>
        ) : null}
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

// The provider receives a short media summary, not the raw display payload.
const estimateTokens = estimateContextTokens;

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
  const togglePinSession = useChatStore((s) => s.togglePinSession);
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
      // Always show the active session regardless of workspace — even a
      // fresh "New chat" the user is looking at right now.
      if (s.id === activeId) return true;
      // Hide content-less placeholders (empty "New chat" litter from older
      // builds + this boot's memory-only ghosts). They carry no value.
      if (isGhostSession(s)) return false;
      if (!s.workspaceRoot) return false;
      return norm(s) === normalized;
    });
  }, [sessions, workspaceRoot, activeId]);

  // Pinned sessions stack on top (most recent first within the stack) and
  // stay there until unpinned; everything else keeps the updatedAt order.
  const sorted = [...filteredSessions].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
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
      {/* align="end": the trigger sits at the header's RIGHT edge, so the
          menu must grow LEFTWARD into the window - the old align="start"
          anchored its left edge at the trigger and clipped against the
          window's right side. Wider caps: long titles + timestamps need
          more room than 288px. */}
      <DropdownMenuContent align="end" className="max-h-[60vh] min-w-64 max-w-80 overflow-y-auto">
        <DropdownMenuItem
          onSelect={() => newSession()}
          className="gap-2 text-xs"
        >
          <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
          New session
        </DropdownMenuItem>
        <ShadowSessionMenuItem close={() => setMenuOpen(false)} />
        <TelegramMonitorMenuItem />
        {sorted.length > 0 ? <DropdownMenuSeparator /> : null}
        {sorted.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={s.id === activeId}
            otherSessions={sorted.filter((o) => o.id !== s.id)}
            onSelect={() => switchSession(s.id)}
            onDelete={() => deleteSession(s.id)}
            onTogglePin={() => togglePinSession(s.id)}
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
  onTogglePin,
}: {
  session: SessionMeta;
  active: boolean;
  otherSessions: SessionMeta[];
  onSelect: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
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
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    if (editing) {
      setDraft(session.title || "");
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, session.title]);

  // COMMIT-ON-REAL-AWAY (2026-11-08 report: "rename a session, move the
  // mouse, it ends instantly, can't type"): the input lives inside a Radix
  // DropdownMenuItem, and Radix menu items GRAB DOM FOCUS ON POINTER MOVE
  // (hover-highlight = focus in menus). That blur fired the old
  // onBlur={commit} and instantly ended the rename; the menu's typeahead
  // also swallowed letter keys. Two layers fix it: (1) a capture-phase
  // pointerdown listener commits ONLY when the user actually presses down
  // outside the input (the real "done editing" intent - clicking another
  // row, outside the menu, etc.); (2) onBlur from anything else is treated
  // as a focus steal - focus is reclaimed, never committed. The input's
  // onKeyDown stopPropagation keeps keystrokes (and Escape) out of the
  // menu's typeahead/dismiss handlers, so typing just types.
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: PointerEvent) => {
      if (!inputRef.current?.contains(e.target as Node)) {
        commitRef.current();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [editing]);

  return (
    <DropdownMenuItem
      onSelect={(e) => {
        // Don't dismiss if user clicked controls — handle below.
        const target = e.target as HTMLElement | null;
        if (
          target?.closest("[data-session-delete]") ||
          target?.closest("[data-session-edit]") ||
          target?.closest("[data-session-merge]") ||
          target?.closest("[data-session-pin]") ||
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
          onBlur={(e) => {
            // Never commit on blur: Radix steals focus to the hovered item
            // on every pointer move (see the pointerdown effect above).
            // Real commit paths: Enter, pointerdown elsewhere, or a blur
            // to a target OUTSIDE the menu (rare - keyboard tab-out).
            const to = e.relatedTarget as HTMLElement | null;
            if (
              to &&
              !to.closest?.("[role='menu'], [data-radix-popper-content-wrapper]")
            ) {
              commitRef.current();
              return;
            }
            inputRef.current?.focus();
          }}
          onKeyDown={(e) => {
            // Keep keys out of the menu: stopPropagation prevents Radix's
            // typeahead from hijacking typed letters and Escape from
            // closing the whole picker mid-edit.
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
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
            "transition-[padding] duration-150",
            // 4 hover icons when the merge control is present, 3 otherwise.
            otherSessions.length > 0
              ? "group-hover:pr-20 group-focus-within:pr-20"
              : "group-hover:pr-14 group-focus-within:pr-14",
          )}
        >
          {session.title || "New chat"}
          {session.pinned ? (
            <span
              title="Pinned - stacks at the top of the list"
              className="ml-1 inline-flex items-center align-middle text-primary"
            >
              <HugeiconsIcon icon={Pin02Icon} size={10} strokeWidth={1.75} />
            </span>
          ) : null}
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
          <button
            type="button"
            data-session-pin
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            title={session.pinned ? "Unpin session" : "Pin to top"}
            aria-label={session.pinned ? "Unpin session" : "Pin to top"}
            className={cn(
              "rounded p-0.5 transition-colors",
              session.pinned
                ? "text-primary hover:bg-accent"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <HugeiconsIcon icon={Pin02Icon} size={11} strokeWidth={1.75} />
          </button>
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
