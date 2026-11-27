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
import { Tool, toolVisualMeta, type ToolPart } from "@/components/ai-elements/tool";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { absoluteTime } from "../lib/relativeTime";
import { motion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import CodeIcon from "@hugeicons/core-free-icons/CodeIcon";
import File01Icon from "@hugeicons/core-free-icons/File01Icon";
import GitForkIcon from "@hugeicons/core-free-icons/GitForkIcon";
import HashtagIcon from "@hugeicons/core-free-icons/HashtagIcon";
import Image01Icon from "@hugeicons/core-free-icons/Image01Icon";
import LeftToRightBlockQuoteIcon from "@hugeicons/core-free-icons/LeftToRightBlockQuoteIcon";
import TerminalIcon from "@hugeicons/core-free-icons/TerminalIcon";
import { SLASH_COMMANDS, Kai_CMD_RE } from "../lib/slashCommands";
import { useChatFontSize, installChatZoomShortcuts } from "../lib/chatFont";
import { Spinner } from "@/components/ui/spinner";
import { useChatStore, sendMessage, respondToApprovalStandalone, resolveErrorDisplay, approvalContinuationPending, getMediaOverride, getOrCreateChat, patchSessionAgentMeta, subscribeSessionAgentMeta, getSessionAgentMeta, getSessionMetaVersionFor } from "../store/chatStore";
import type {
  ChatStatus,
  DynamicToolUIPart,
  ToolUIPart,
  UIMessage,
  UIMessagePart,
} from "ai";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Fragment } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { AiToolApproval } from "./AiToolApproval";
import { MediaMessage, isMediaOutput, isGeneratingMedia } from "./MediaMessage";
import UserMultiple02Icon from "@hugeicons/core-free-icons/UserMultiple02Icon";
import { groupDeliveryPreview, isGroupDeliveryText } from "../store/groupChatStore";
import {
  isBlankMarkdown,
  splitThinkingBlocks,
  stripLeakedTokens,
  stripUserContextBlocks,
  type ContextChip,
} from "../lib/chatText";

/** Render an error display string with any http(s) URL rendered as a clickable
 *  link (opens in the system browser via the opener plugin). Long URL text
 *  otherwise stretches the message bubble; we wrap the link and break it. */
function renderErrorWithLinks(text: string): ReactNode {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, i) => {
    if (/^https?:\/\//.test(part)) {
      let host = part;
      try {
        host = new URL(part).host;
      } catch {
        // keep raw
      }
      return (
        <a
          key={i}
          href={part}
          onClick={(e) => {
            e.preventDefault();
            void openUrl(part).catch(() => {});
          }}
          className="underline opacity-90 hover:opacity-100"
        >
          {host}
        </a>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

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
      title="Fork: branch the conversation from this message into a new chat — same project files. (To isolate FILES, use Shadow mode in the session menu.)"
      className="shrink-0 size-6 flex items-center justify-center rounded-md border border-border/40 bg-background/50 text-muted-foreground opacity-0 group-hover/msg:opacity-100 transition-all hover:bg-accent hover:text-foreground shadow-sm"
    >
      <HugeiconsIcon icon={GitForkIcon} size={13} strokeWidth={1.75} />
    </button>
  );
}

function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  const onClick = () => {
    // Compute the text lazily — stripping leaked tokens over every text part
    // on every render (for a pre-filled prop) ran on each streamed token and
    // contributed to the streaming freeze. Only pay the cost on click.
    const text = getText();
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title="Copy message content"
      className="shrink-0 size-6 flex items-center justify-center rounded-md border border-border/40 bg-background/50 text-muted-foreground opacity-0 group-hover/msg:opacity-100 transition-all hover:bg-accent hover:text-foreground shadow-sm"
    >
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" />
          <path d="M3.5 10.5h-.75a1.5 1.5 0 01-1.5-1.5v-5.5a1.5 1.5 0 011.5-1.5h5.5a1.5 1.5 0 011.5 1.5v.75" />
        </svg>
      )}
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

const ContextChips = memo(function ContextChips({
  chips,
}: {
  chips: ContextChip[];
}) {
  return (
    <div className="mb-1 flex flex-wrap gap-1">
      {chips.map((c, i) => {
        // Quote chips render as a reply-quote preview (author + excerpt,
        // left accent bar) like mainstream chat apps; other chips stay pills.
        if (c.kind === "quote") {
          return (
            <span
              key={i}
              className="flex w-full items-center gap-1.5 rounded-md border-l-2 border-primary/70 bg-muted/50 px-2 py-1 text-[10.5px]"
            >
              <HugeiconsIcon icon={LeftToRightBlockQuoteIcon} size={10} strokeWidth={1.75} className="shrink-0 text-primary/80" />
              <span className="min-w-0 truncate">
                <span className="font-semibold text-primary/90">{c.author}</span>
                <span className="ml-1.5 text-muted-foreground">{c.excerpt}</span>
              </span>
              {c.lines > 1 ? <span className="shrink-0 opacity-70">{c.lines}L</span> : null}
            </span>
          );
        }
        return (
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
        );
      })}
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
  if (c.kind === "quote") {
    return (
      <HugeiconsIcon icon={LeftToRightBlockQuoteIcon} size={10} strokeWidth={1.75} />
    );
  }
  return <HugeiconsIcon icon={HashtagIcon} size={10} strokeWidth={1.75} />;
}

function chipLabel(c: ContextChip): string {
  if (c.kind === "selection") {
    return c.source === "editor" ? "Editor selection" : "Terminal selection";
  }
  if (c.kind === "file") return c.name;
  if (c.kind === "quote") return c.excerpt;
  return `#${c.name}`;
}
type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

/**
 * Split text into alternating non-thinking / thinking segments.
 * Returns an array of { thinking: boolean; text: string } objects.
 * Complete <thinking>…</thinking> blocks become thinking=true segments;
 * everything else (including unclosed trailing <thinking> blocks that are
 * still streaming) becomes thinking=false.
 */
/** Regex matching any thinking-block boundary marker (opening or closing). */

type Props = {
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  clearError: () => void;
  /** Extra classes for the ConversationContent (transcript) wrapper.
   *  Surfaces with a fixed chrome rhythm (Workspaces cards) use it to
   *  align the transcript's padding with their header/input rows. */
  contentClassName?: string;
  /** CARD MODE (Workspaces, 2026-11-19): tool parts render as compact
   *  rows (trailing state dot, chip background) and consecutive calls of
   *  the same tool collapse into one expandable group - at ~290px wide
   *  the doc-scale rows read as loose debris. */
  compact?: boolean;
  /** OWNING session (2026-11-21). A surface that shows a NON-foreground
   *  session (every Workspaces card but the active project's) must say so:
   *  the approval card reads that session's Ask/Allow mode to predict
   *  auto-approval, and reading the FOREGROUND session's mode instead made
   *  a card render a buttonless green "approved" row for a call its own
   *  session was still asking about - parked forever. Absent = the
   *  surface shows the active session (AI panel / mini window). */
  sessionId?: string;
  /** FORCE-HIDE thinking UI. Workspaces cards pass this so reasoning parts
   *  and inline <thinking> pills are never rendered there, regardless of
   *  the user's showModelThinking preference (that toggle is for the
   *  project AI window only). */
  hideThinking?: boolean;
};

/**
 * TRANSCRIPT TAIL WINDOWING (freeze fix, 2026-11-22): a 1M-context session
 * can accumulate hundreds of messages before summarization triggers, and
 * rendering the entire list into the DOM (especially across 8 Workspaces
 * cards at once) forces React + the browser layout engine to reconcile
 * thousands of markdown/tool nodes on every 50ms token flush. Render the
 * trailing window by default; the user can reveal earlier messages on
 * demand in chunks.
 */
const TRANSCRIPT_WINDOW_FULL = 60;
const TRANSCRIPT_WINDOW_COMPACT = 30;
const TRANSCRIPT_WINDOW_STEP = 60;

export function AiChatView({
  messages,
  status,
  error,
  clearError,
  contentClassName,
  compact = false,
  sessionId,
  hideThinking = false,
}: Props) {
  const scrollCtx = useRef<StickToBottomContext | null>(null);
  const baseWindow = compact ? TRANSCRIPT_WINDOW_COMPACT : TRANSCRIPT_WINDOW_FULL;
  const [visibleLimit, setVisibleLimit] = useState(baseWindow);
  useEffect(() => {
    setVisibleLimit(compact ? TRANSCRIPT_WINDOW_COMPACT : TRANSCRIPT_WINDOW_FULL);
  }, [sessionId, compact]);
  // Floating day pill: tracks which day's first message is near the top of
  // the scroller so the user can see where they are in a long conversation.
  // The pill is only shown for PAST days - when the top message is from
  // today there is nothing to orient by (2026-11-27 ask).
  const [topTs, setTopTs] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const topTsRaf = useRef<number>(0);
  // windowStart mirror + auto-load bookkeeping: when the user scrolls near
  // the top and older messages are windowed out, load one more step in-place
  // instead of forcing the "Show earlier messages" button.
  const windowStartRef = useRef(0);
  const pendingScrollRestore = useRef<{ height: number; top: number } | null>(null);
  const lastAutoLoad = useRef(0);
  const updateTopTs = useCallback(() => {
    const scroller = scrollCtx.current?.scrollRef?.current as HTMLElement | null;
    if (!scroller) return;
    // INFINITE SCROLL UP: near the top with hidden history -> grow the
    // window. Record scroll geometry first so the post-render effect can
    // restore the viewport over the newly PREPENDED messages (otherwise
    // prepended content pushes the view down and the read position jumps).
    if (
      scroller.scrollTop <= 120 &&
      windowStartRef.current > 0 &&
      Date.now() - lastAutoLoad.current > 500
    ) {
      lastAutoLoad.current = Date.now();
      if (!pendingScrollRestore.current) {
        pendingScrollRestore.current = { height: scroller.scrollHeight, top: scroller.scrollTop };
      }
      setVisibleLimit((prev) => prev + TRANSCRIPT_WINDOW_STEP);
      return;
    }
    const rootRect = scroller.getBoundingClientRect();
    const nodes = scroller.querySelectorAll("[data-ts]");
    for (const n of nodes) {
      const r = (n as HTMLElement).getBoundingClientRect();
      if (r.bottom >= rootRect.top + 24) {
        const ts = Number((n as HTMLElement).dataset.ts);
        if (ts) setTopTs(ts);
        break;
      }
    }
    const dist = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    setAtBottom(dist <= 70);
  }, []);
  useEffect(() => {
    // Restore scroll over prepended window history, then re-measure the pill.
    const scroller = scrollCtx.current?.scrollRef?.current as HTMLElement | null;
    const pending = pendingScrollRestore.current;
    if (scroller && pending) {
      scroller.scrollTop = pending.top + (scroller.scrollHeight - pending.height);
      pendingScrollRestore.current = null;
    }
    topTsRaf.current = window.requestAnimationFrame(updateTopTs);
    return () => cancelAnimationFrame(topTsRaf.current);
  }, [messages, visibleLimit, updateTopTs]);
  const scheduleTopTs = useCallback(() => {
    cancelAnimationFrame(topTsRaf.current);
    topTsRaf.current = window.requestAnimationFrame(updateTopTs);
  }, [updateTopTs]);
  const windowStart = Math.max(0, messages.length - visibleLimit);
  windowStartRef.current = windowStart;
  const visibleMessages =
    windowStart > 0 ? messages.slice(windowStart) : messages;
  // SYMMETRIC CHAT ZOOM (2026-11-18): zoom the TRANSCRIPT by one ratio so
  // prose, code blocks and labels scale together. The shortcuts install
  // here so Ctrl+scroll works inside the DOCKED/expanded AI panel too
  // (they were previously only installed by the mini window + group panel
  // — the third surface was missed entirely).
  const chatFontZoomStyle = useChatFontSize().rootStyle;
  installChatZoomShortcuts();
  const isBusy = status === "submitted" || status === "streaming";
  const lastMessage = messages[messages.length - 1];
  const showSpinner = isBusy && lastMessage?.role === "user";
  const streamingMessageId =
    status === "streaming" && lastMessage?.role === "assistant"
      ? lastMessage.id
      : null;
  // ── OWNED agent meta (2026-11-23 cross-project retry bug) ──────────
  // The step-cap / finish banners and the error card must reflect THIS
  // surface's session, not the global agentMeta slice (which mirrors
  // whichever session is currently ACTIVE). A background Workspaces card
  // showing the global slice painted Project A's error/step-cap state on
  // Project B's card, and pressing its Retry sent "Continue where you
  // stopped" to the ACTIVE session — waking a different project's chat.
  // When sessionId is absent (docked panel / mini window), the surface IS
  // the active session and the global slice is correct.
  const ownedMetaVersion = useSyncExternalStore(
    subscribeSessionAgentMeta,
    () => (sessionId ? getSessionMetaVersionFor(sessionId) : 0),
  );
  // Subscribe to global agentMeta ONLY when sessionId is omitted (defensive:
  // both AiMiniWindow and ProjectChatGrid pass sessionId, so this avoids
  // extra renders there while keeping sessionless callers reactive).
  const fallbackAgentMeta = useChatStore((s) =>
    sessionId ? null : s.agentMeta,
  );
  const ownedMeta = useMemo(
    () =>
      sessionId
        ? getSessionAgentMeta(sessionId)
        : (fallbackAgentMeta ?? useChatStore.getState().agentMeta),
    [sessionId, ownedMetaVersion, fallbackAgentMeta],
  );
  const hitStepCap = ownedMeta.hitStepCap;
  const finishReason = ownedMeta.finishReason;
  const compactionNotice = ownedMeta.compactionNotice;
  const summarizing = ownedMeta.summarizing;
  const summaryNotice = ownedMeta.summaryNotice;
  const patchAgentMeta = useChatStore((s) => s.patchAgentMeta);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const patchOwnedMeta = useCallback(
    (patch: Partial<typeof ownedMeta>) => {
      if (sessionId) patchSessionAgentMeta(sessionId, patch);
      else patchAgentMeta(patch);
    },
    [sessionId, patchAgentMeta],
  );
  const showContinue =
    !isBusy && hitStepCap && lastMessage?.role === "assistant";
  // Show "Done" when the agent finishes and the last visible part is a tool
  // call (no trailing text), so the user knows it stopped.
  const showDone = (() => {
    if (isBusy || status === "error" || hitStepCap) return false;
    if (!lastMessage || lastMessage.role !== "assistant") return false;
    const parts = lastMessage.parts;
    if (parts.length === 0) return false;
    // Waiting on an approval (or one just answered): the accept/deny card
    // conveys the stop, and the SDK fires a continuation request that takes
    // seconds of transport prep + network to appear — in that window the run
    // LOOKS finished. Suppress both the "Ended after tool call" line and its
    // Continue button until the follow-up stream actually starts (status
    // leaves `ready`).
    if (approvalContinuationPending(parts)) return false;
    const lastPart = parts[parts.length - 1];
    const type = (lastPart as { type?: string }).type ?? "";
    // If the last part is text, the agent already said something visible.
    if (type === "text") return false;
    // If it ends with a tool call, the user has no visual cue it's done.
    return type.startsWith("tool-") || type === "dynamic-tool";
  })();
  // Translate the raw provider finish reason into a human label so "Stopped"
  // distinguishes an actual completion from a context-limit, content-filter,
  // or tool-call cutoff.
  const stopLabel = (() => {
    switch (finishReason) {
      case "length":
        return "Context limit reached";
      case "content-filter":
        return "Blocked by content filter";
      case "tool-calls":
        return "Ended after tool call";
      case "error":
        return "Provider error";
      case "stop":
        return "Completed";
      default:
        return "Stopped";
    }
  })();
  const stopTone =
    finishReason === "stop"
      ? "text-emerald-600 dark:text-emerald-400"
      : finishReason === "length" || finishReason === "content-filter"
        ? "text-amber-600 dark:text-amber-400"
        : finishReason === "error"
          ? "text-destructive"
          : "text-muted-foreground";
  const onContinue = useCallback(() => {
    // OWNED META (2026-11-23 cross-project retry bug): patch THIS session's
    // meta (not the global slice) and send to THIS session's chat — the
    // global sendMessage helper targets the ACTIVE session, which from a
    // background Workspaces card is a DIFFERENT project.
    if (sessionId) {
      patchSessionAgentMeta(sessionId, { hitStepCap: false, finishReason: "", summaryNotice: null });
      void getOrCreateChat(sessionId).sendMessage({
        text: "Continue from where you stopped. Don't recap — just keep going.",
      });
    } else {
      patchAgentMeta({ hitStepCap: false, finishReason: "", summaryNotice: null });
      void sendMessage(
        "Continue from where you stopped. Don't recap — just keep going.",
      );
    }
  }, [patchAgentMeta, sessionId]);

  // Decode the raw error (minified React codes, bare network failures,)
  // into actionable text — same resolver as the agent's onError path.
  const errorDisplay = useMemo(
    () => (error ? resolveErrorDisplay(error) : ""),
    [error],
  );

  const onApproval = useCallback(
    (id: string, approved: boolean) => respondToApprovalStandalone(id, approved),
    [],
  );

  // HOOK ORDER (2026-11-21): the empty state renders INSIDE the transcript
  // below - it must NEVER be an early return. It used to sit above the two
  // scroll hooks, so a surface that mounted on an EMPTY session registered
  // three fewer hooks than the render that carried the first message:
  // React threw "Rendered more hooks than during the previous render",
  // AiErrorBoundary swallowed the throw and returned null, and the
  // Workspaces card went BLANK the moment its first message landed.

  // Auto-scroll to bottom when the user sends a new message.
  const prevMsgCount = useRef(messages.length);
  useEffect(() => {
    if (messages.length > prevMsgCount.current) {
      const newest = messages[messages.length - 1];
      if (newest?.role === "user") {
        scrollCtx.current?.scrollToBottom();
      }
    }
    prevMsgCount.current = messages.length;
  }, [messages.length, messages]);

  // Keep the stick-to-bottom lock THROUGH streaming. The library escapes the
  // lock on any scroll-up, including programmatic ones: while markdown
  // streams, Streamdown re-parses and tool cards swap state, so the content
  // can transiently SHRINK (a partial fence completing, a spinner card
  // collapsing) — the browser clamps scrollTop down, that lands as
  // "scrolling up", and the run stops following mid-reply with the
  // catch-up arrow showing even though the user never touched the wheel
  // (the user report). Same rule the library itself applies to negative
  // resizes: if the view is NEAR the bottom (within its own 70px threshold),
  // re-assert the lock on every streamed message update; a user who
  // genuinely scrolled up to read stays far from the bottom and is left
  // alone.
  useEffect(() => {
    if (status !== "streaming" && status !== "submitted") return;
    if (scrollCtx.current?.state.isNearBottom) {
      scrollCtx.current?.scrollToBottom();
    }
  }, [messages, status]);

  return (
    <Conversation contextRef={scrollCtx} onScroll={scheduleTopTs}>
        <ConversationContent
          // min-w-0: flex column children default to min-width:auto, so a
          // single wide block (table, fence, unbroken token) would inflate
          // this scroller past its container - in the narrow Workspaces
          // cards that read as horizontal clipping instead of the block
          // scrolling inside the card.
          className={cn("min-w-0 gap-5 p-3 pb-6", contentClassName)}
          style={chatFontZoomStyle}
        >
        {messages.length === 0 && (
          <ConversationEmptyState
            // flex-1: shares the scroller with the notice rows, so the
            // empty state keeps filling (and centering in) the transcript
            // area the way the old early-return did.
            className="flex-1"
            title="Ask anything"
            description="Explain command output, fix errors, generate snippets, or run a task."
          />
        )}
        {windowStart > 0 && (
          <button
            type="button"
            onClick={() =>
              setVisibleLimit((prev) => prev + TRANSCRIPT_WINDOW_STEP)
            }
            className="mx-auto my-1 rounded-md border border-border/50 bg-muted/30 px-2.5 py-1 text-[10.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Show earlier messages ({windowStart} hidden)
          </button>
        )}
        {visibleMessages.map((m, relIdx) => {
          const idx = windowStart + relIdx;
          // Day separator: rendered whenever the calendar day changes
          // between consecutive timestamped messages. Messages without a
          // timestamp (legacy, pre-feature) never trigger a separator —
          // their real day is unknown, showing one would be a guess.
          const ts = (m.metadata as { createdAt?: number } | undefined)?.createdAt;
          const prevTs =
            idx > 0
              ? (messages[idx - 1].metadata as { createdAt?: number } | undefined)
                  ?.createdAt
              : undefined;
          const dayKey = ts ? new Date(ts).toDateString() : null;
          const prevDayKey = prevTs ? new Date(prevTs).toDateString() : null;
          const showDay = dayKey != null && dayKey !== prevDayKey;
          return (
            <Fragment key={m.id}>
              {showDay && <DaySeparator ts={ts as number} />}
              <div
                className="group/msg relative"
                // Author stamp for the transcript Quote action: the
                // context-menu builder recovers who said the selected text
                // from this attribute (App.tsx contextmenu handler).
                data-msg-author={m.role === "user" ? "You" : (m.metadata as { agentName?: string } | undefined)?.agentName ?? "Kai"}
                data-ts={ts}
              >
              <RenderedMessage
                message={m}
                onApproval={onApproval}
                streaming={m.id === streamingMessageId}
                forkable={
                  !isBusy &&
                  m.role === "user" &&
                  idx > 0 &&
                  (!sessionId || sessionId === activeSessionId)
                }
                messageIndex={idx}
                timestamp={ts}
                compact={compact}
                sessionId={sessionId}
                hideThinking={hideThinking}
              />
              </div>
            </Fragment>
          );
        })}
        {compactionNotice && compactionNotice.droppedCount >= 3 && (
          <CompactionNotice
            droppedCount={compactionNotice.droppedCount}
            kind={compactionNotice.kind}
            onDismiss={() => patchOwnedMeta({ compactionNotice: null })}
          />
        )}
        {summaryNotice && (
          <SummaryNotice
            text={summaryNotice.text}
            onDismiss={() => patchOwnedMeta({ summaryNotice: null })}
          />
        )}
        {summarizing && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner />
            <span>Compressing context…</span>
          </div>
        )}
        {showSpinner && (
          <div className="flex justify-center text-xs text-muted-foreground">
            <GameOfLifeSpinner />
          </div>
        )}
        {showDone && (
          <div className={cn("flex items-center gap-1.5 px-1 text-[11px]", stopTone)}>
            <span className="size-1.5 rounded-full bg-current" />
            {stopLabel}
            {finishReason && finishReason !== "stop" && (
              <button
                type="button"
                onClick={onContinue}
                className="ml-1 rounded-md border border-border/60 bg-background px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
              >
                Continue
              </button>
            )}
          </div>
        )}
        {showContinue && (
          <ContinueRow onContinue={onContinue} />
        )}
        {error && (
          <div className="max-w-full overflow-hidden rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <div className="font-medium">Something went wrong.</div>
            <div className="mt-0.5 whitespace-pre-wrap break-words leading-relaxed opacity-90">
              {renderErrorWithLinks(errorDisplay)}
            </div>
            <div className="mt-1.5 flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  clearError();
                  onContinue();
                }}
                className="rounded-md border border-destructive/50 px-2 py-0.5 font-medium transition-colors hover:bg-destructive/15"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={clearError}
                className="underline opacity-80 hover:opacity-100"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </ConversationContent>
      {topTs != null && !atBottom &&
        new Date(topTs).toDateString() !== new Date().toDateString() && (
        <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full border border-border/40 bg-background/80 px-2.5 py-0.5 text-[10px] font-medium text-muted-foreground shadow-sm backdrop-blur-sm select-none">
          {new Date(topTs).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: new Date(topTs).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
          })}
        </div>
      )}
      <ConversationScrollButton />
    </Conversation>
  );
}

const CompactionNotice = memo(function CompactionNotice({
  droppedCount,
  kind,
  onDismiss,
}: {
  droppedCount: number;
  /** "memo-fold": durable-memory fold (retrievable, NOT elided);
   *  "elide"/undefined: the local compactor's drop. */
  kind?: "elide" | "memo-fold";
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <span className="size-1.5 shrink-0 rounded-full bg-amber-500/80" />
      <span className="flex-1 truncate">
        {kind === "memo-fold"
          ? `Durable memory - ${droppedCount} older message${droppedCount === 1 ? "" : "s"} folded into the memory capsule; the agent can recall them verbatim.`
          : `Context compacted - ${droppedCount} older tool result${droppedCount === 1 ? "" : "s"} elided to save tokens.`}
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

/**
 * Watch fire rendering — COLLAPSED by default.
 *
 * Watch injections carry up to 2000 chars of raw command stdout; rendered
 * full-height they scroll the whole chat on every firing ("the chat jumps
 * every time the watch fires"). The pill shows the one-line header (label,
 * exit code, poll count) and expands to the full markdown body on click.
 * Default-collapsed state is per-message, not persisted — fresh fires also
 * start collapsed, which is the desired anti-scroll behavior.
 */
/** GROUP-DELIVERY PILL (2026-11-26 report: "after stopping group chats,
 *  texts are visible in main user chat and not only in group"): group
 *  deliveries are injected into the participant's own project chat (the
 *  agent answers them there) but they rendered as WATCH pills or raw user
 *  bubbles - reading as watch fires or leaked chatter, and they lingered
 *  after the group ended. Recognized by the delivery TEXT (the markers are
 *  stable), so the pill survives metadata loss; collapse + expand keeps the
 *  chat readable while the agent still sees the full text in history. */
const GroupDeliveryMessage = memo(function GroupDeliveryMessage({
  text,
}: {
  text: string;
}) {
  const [open, setOpen] = useState(false);
  const preview = useMemo(() => groupDeliveryPreview(text), [text]);
  const label = preview?.label ?? "group chat";
  const excerpt = preview?.excerpt ?? "group message";
  return (
    <Message from="user">
      <MessageContent>
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger
            className={cn(
              "flex w-full items-center gap-1.5 rounded-lg border border-border/50 bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground",
            )}
          >
            <HugeiconsIcon
              icon={UserMultiple02Icon}
              size={12}
              strokeWidth={1.8}
              className="shrink-0 text-primary/70"
            />
            <span className="shrink-0 font-medium">{label}</span>
            <span className="min-w-0 flex-1 truncate text-left opacity-80">
              {excerpt}
            </span>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={12}
              strokeWidth={1.8}
              className={cn(
                "shrink-0 text-muted-foreground/60 transition-transform",
                open && "rotate-90",
              )}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <MessageResponse>{text}</MessageResponse>
          </CollapsibleContent>
        </Collapsible>
      </MessageContent>
    </Message>
  );
});

const WatchFireMessage = memo(function WatchFireMessage({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  // Header line: `**Watch fired**: `label` (exit: 0, poll #N)` — strip the
  // markdown emphasis for the pill (the body keeps full markdown when open).
  const header = useMemo(() => {
    const m = /^\*\*Watch (?:fired|stopped)\*\*: (`.+?`) \((exit: [^)]+)\)/.exec(
      text,
    );
    if (!m) return text.split("\n")[0].slice(0, 120) || "Watch notification";
    const label = m[1].replace(/^`|`$/g, "");
    return `⏱ Watch ${text.includes("**Watch stopped**") ? "stopped" : "fired"} · ${label} · ${m[2]}`;
  }, [text]);
  return (
    <Message from="user">
      <MessageContent>
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger
            className={cn(
              "flex w-full items-center gap-1.5 rounded-lg border border-border/50 bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground",
            )}
          >
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={12}
              strokeWidth={1.8}
              className={cn(
                "shrink-0 text-muted-foreground/60 transition-transform",
                open && "rotate-90",
              )}
            />
            <span className="min-w-0 truncate text-left">{header}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <MessageResponse>{text}</MessageResponse>
          </CollapsibleContent>
        </Collapsible>
      </MessageContent>
    </Message>
  );
});

const SummaryNotice = memo(function SummaryNotice({
  onDismiss,
  text,
}: {
  onDismiss: () => void;
  text?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <span className="size-1.5 shrink-0 rounded-full bg-blue-500/80" />
      <span className="flex-1 truncate">
        {text ?? "Context summarized — earlier messages compressed."}
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

/**
 * User-role message rendering, isolated from RenderedMessage so the latter's
 * hook list is unconditional (RULES OF HOOKS — the early return over
 * message.role previously skipped two useMemo/useCallback dispatches; role
 * never flips within an instance today, but one metadata/persistence change
 * would have turned it into React #310 at best-effort reuse time).
 */
function UserMessageView({
  message,
  forkable,
  messageIndex,
  timeTitle,
}: {
  message: UIMessage;
  forkable?: boolean;
  messageIndex?: number;
  timeTitle?: string;
}) {
  const rawText = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");

  const isWatchMessage =
    ((message as { metadata?: { kind?: string } }).metadata?.kind ?? "") ===
    "watch";
  // GROUP deliveries ride the same injectMessage machinery (kind "watch"),
  // but they are NOT watch fires - the group pill must win so the delivery
  // reads as group chatter (label + excerpt), not "Watch fired". Detected by
  // text (stable markers), so a metadata loss still renders correctly.
  if (isGroupDeliveryText(rawText)) {
    return <GroupDeliveryMessage text={rawText} />;
  }
  if (isWatchMessage) {
    return <WatchFireMessage text={rawText} />;
  }

  const cmdMatch = rawText.match(Kai_CMD_RE);
  const commandName = cmdMatch?.[1] ?? null;
  const withoutCmd = cmdMatch ? rawText.slice(cmdMatch[0].length) : rawText;
  const stripped = stripUserContextBlocks(withoutCmd);

  const imageParts = message.parts.filter(
    (p): p is { type: "file"; url: string; mediaType: string; [k: string]: any } =>
      p.type === "file" &&
      typeof p.url === "string" &&
      p.mediaType.startsWith("image/"),
  );

  return (
    <Message from="user" title={timeTitle}>
      <div className="flex items-center gap-1.5">
        {forkable && messageIndex !== undefined && (
          <ForkButton messageIndex={messageIndex} />
        )}
        {/* Copy for user messages too (same CopyButton assistant messages
            use). Strips context blocks first — chips/selections are metadata
            the user didn't type, so copying should yield what they wrote. */}
        {!isWatchMessage && stripped.text ? (
          <CopyButton getText={() => stripUserContextBlocks(rawText).text || rawText} />
        ) : null}
        <MessageContent>
          {commandName ? <CommandSnippet name={commandName} /> : null}
          {stripped.chips.length > 0 ? (
            <ContextChips chips={stripped.chips} />
          ) : null}
          {imageParts.length > 0 && (
            <UserImageParts parts={imageParts} />
          )}
          {stripped.text ? (
            <p className="whitespace-pre-wrap break-words overflow-wrap-anywhere">
              {stripped.text}
            </p>
          ) : null}
        </MessageContent>
      </div>
    </Message>
  );
}

/** Image attachments of a user message (split out of the JSX for readability). */
function UserImageParts({
  parts,
}: {
  parts: { type: "file"; url: string; mediaType: string }[];
}) {
  return (
    <div className="flex flex-col gap-1.5 mb-2 max-w-sm">
      {parts.map((p, idx) =>
        // After a restart, persisted images are stripped to a bare
        // data-prefix (no payload) to keep the store compact - render a
        // placeholder chip instead of a broken zero-size image.
        // PAYLOAD check, not split-count: the stripped form is
        // `data:image/png;base64,` WITH a trailing comma, so split(",")
        // yields TWO elements (["data:...", ""]) and the old `.length < 2`
        // test let it through, rendering a corrupted <img> instead of
        // this placeholder (2026-11-24 report: images looked corrupted
        // after the freeze-restart).
        !(p.url.split(",")[1] ?? "").trim() ? (
          <div
            key={idx}
            className="flex h-12 items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 text-[11px] text-muted-foreground"
          >
            <HugeiconsIcon
              icon={Image01Icon}
              size={14}
              strokeWidth={1.8}
            />
            Image attachment (not stored across restarts)
          </div>
        ) : (
          <img
            key={idx}
            src={p.url}
            alt="User upload"
            className="rounded-lg max-h-48 object-contain"
            draggable={false}
          />
        ),
      )}
    </div>
  );
}

const RenderedMessage = memo(function RenderedMessage({
  message,
  onApproval,
  streaming,
  forkable,
  messageIndex,
  timestamp,
  compact,
  sessionId,
  hideThinking,
}: {
  message: UIMessage;
  onApproval: (id: string, approved: boolean) => void;
  streaming: boolean;
  forkable?: boolean;
  messageIndex?: number;
  /** Per-message createdAt for hover tooltips; undefined = legacy/unknown. */
  timestamp?: number;
  compact?: boolean;
  /** Session that OWNS this transcript (approval cards read its mode). */
  sessionId?: string;
  /** Force-hide reasoning/thinking UI regardless of user preference. */
  hideThinking?: boolean;
}) {
  // RULES OF HOOKS: RenderedMessage is now a hook-free dispatcher. The user
  // and assistant paths live in DIFFERENT child components, so React can
  // never reuse one instance across a role change — each child's hook list
  // is unconditional within its own lifetime.
  if (message.role === "user") {
    return (
      <UserMessageView
        message={message}
        forkable={forkable}
        messageIndex={messageIndex}
        timeTitle={timestamp ? absoluteTime(timestamp) : undefined}
      />
    );
  }
  return (
    <AssistantMessageView
      message={message}
      onApproval={onApproval}
      streaming={streaming}
      timestamp={timestamp}
      compact={compact}
      sessionId={sessionId}
      hideThinking={hideThinking}
    />
  );
});

function AssistantMessageView({
  message,
  onApproval,
  streaming,
  timestamp,
  compact,
  sessionId,
  hideThinking,
}: {
  message: UIMessage;
  onApproval: (id: string, approved: boolean) => void;
  streaming: boolean;
  timestamp?: number;
  compact?: boolean;
  sessionId?: string;
  hideThinking?: boolean;
}) {
  const timeTitle = timestamp ? absoluteTime(timestamp) : undefined;

  const prefShowModelThinking = usePreferencesStore((s) => s.showModelThinking);
  const showModelThinking = prefShowModelThinking && !hideThinking;

  const groups = useMemo(
    () => buildPartGroups(message.parts as AnyPart[], compact, showModelThinking),
    [message.parts, compact, showModelThinking],
  );

  // Sequential approval queue: when a step emits several approval-requested
  // tool calls, only the first is interactive — the rest render as compact
  // queued chips and unlock one at a time as the user responds. Order is
  // part order, which matches the model's intended sequence.
  const pendingApprovals = useMemo(() => {
    const out: { id: string; toolName: string }[] = [];
    for (const p of message.parts as AnyPart[]) {
      const state = (p as { state?: string }).state ?? "";
      if (state !== "approval-requested") continue;
      const id = (p as { approval?: { id?: string } }).approval?.id;
      if (!id) continue;
      const type = (p as { type?: string }).type ?? "";
      const toolName =
        type === "dynamic-tool"
          ? ((p as { toolName?: string }).toolName ?? "tool")
          : type.replace(/^tool-/, "");
      out.push({ id, toolName });
    }
    return out;
  }, [message.parts]);

  // Lazy: only compute the full cleaned text when the user copies. Building
  // it on every render re-ran stripLeakedTokens over every text part per
  // streamed token.
  const getAssistantText = useCallback(() => {
    return message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => stripLeakedTokens(p.text))
      .join("\n");
  }, [message.parts]);

  const hasAssistantText = message.parts.some(
    (p) =>
      p.type === "text" &&
      ((p as { text?: string }).text ?? "").trim().length > 0,
  );

  return (
    <Message from={message.role} title={timeTitle}>
      <div className="flex items-start gap-3 w-full">
        <div className="flex-1 min-w-0">
          <MessageContent>
            <div className={cn("flex flex-col", compact ? "gap-1.5" : "gap-3")}>
              {groups.map((g) => {
                if (g.kind === "reads") {
                  return (
                    <PartAppear key={`${message.id}-${g.key}`}>
                      <ReadGroup parts={g.parts} />
                    </PartAppear>
                  );
                }
                if (g.kind === "calls") {
                  return (
                    <PartAppear key={`${message.id}-${g.key}`}>
                      <ToolGroup toolName={g.toolName} parts={g.parts} />
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
                const gState = (g.part as { state?: string }).state ?? "";
                const gApprovalId =
                  gState === "approval-requested"
                    ? ((g.part as { approval?: { id?: string } }).approval?.id ??
                      null)
                    : null;
                const queueIndex = gApprovalId
                  ? pendingApprovals.findIndex((a) => a.id === gApprovalId)
                  : -1;
                return (
                  <PartAppear key={`${message.id}-${g.key}`}>
                    <RenderedPart
                      part={g.part}
                      onApproval={onApproval}
                      compact={compact}
                      sessionId={sessionId}
                      hideThinking={hideThinking}
                      streaming={
                        streaming &&
                        (partType(g.part) === "text" ||
                          partType(g.part) === "reasoning") &&
                        (g.part as { state?: string }).state === "streaming"
                      }
                      approvalQueue={
                        gApprovalId && queueIndex > 0
                          ? {
                              queued: true,
                              position: queueIndex + 1,
                              total: pendingApprovals.length,
                            }
                          : gApprovalId && queueIndex === 0
                            ? {
                                queued: false,
                                position: 1,
                                total: pendingApprovals.length,
                              }
                            : null
                      }
                    />
                  </PartAppear>
                );
              })}
            </div>
          </MessageContent>
        </div>
        {hasAssistantText ? (
          <div className="pt-0.5">
            <CopyButton getText={getAssistantText} />
          </div>
        ) : null}
      </div>
    </Message>
  );
}


type Group =
  | { kind: "single"; part: AnyPart; idx: number; key: string }
  | { kind: "reads"; parts: AnyPart[]; key: string }
  | { kind: "calls"; toolName: string; parts: AnyPart[]; startIdx: number; key: string };

function partType(p: AnyPart): string {
  return (p as { type?: string }).type ?? "";
}

function isReadFilePart(p: AnyPart): boolean {
  if (partType(p) !== "tool-read_file") return false;
  const state = (p as { state?: string }).state ?? "";
  return state !== "approval-requested";
}

/** Tool name for grouping consecutive identical calls (compact mode), or
 *  null when the part is not groupable: text/reasoning never group,
 *  approval-requested parts must stay individually interactive, and media
 *  tools render as inline results (MediaMessage), not rows. */
function groupableToolName(p: AnyPart): string | null {
  const t = partType(p);
  if (t === "text" || t === "reasoning" || t === "step-start") return null;
  const state = (p as { state?: string }).state ?? "";
  if (state === "approval-requested") return null;
  if (t === "dynamic-tool") {
    const name = (p as { toolName?: string }).toolName ?? "";
    if (name === "generate_image" || name === "generate_video") return null;
    return name || null;
  }
  if (t.startsWith("tool-")) {
    const name = t.slice(5);
    if (name === "generate_image" || name === "generate_video") return null;
    return name;
  }
  return null;
}

function partKey(p: AnyPart, idx: number): string {
  const tc = (p as { toolCallId?: string }).toolCallId;
  if (tc) return tc;
  const id = (p as { approval?: { id?: string } }).approval?.id;
  if (id) return id;
  return `i-${idx}`;
}

const INLINE_THINKING_TAG_RE = /<thinking>|<\|thinking\||<\/thinking>/i;

/**
 * True when a part renders NOTHING on screen (so wrapping it in a PartAppear
 * div inside the flex-col message stack would leave a phantom empty flex item
 * that multiplies `gap` between neighboring tool rows — e.g. step-start
 * markers, hidden reasoning parts in Workspaces cards, or whitespace-only
 * text parts). Skipping invisible parts BEFORE grouping ALSO lets consecutive
 * same-tool calls across step boundaries collapse into a single group.
 */
function isInvisiblePart(p: AnyPart, showModelThinking: boolean): boolean {
  const t = partType(p);
  if (t === "step-start" || t === "source-url" || t === "source-document") {
    return true;
  }
  if (t === "reasoning") {
    if (!showModelThinking) return true;
    const state = (p as { state?: string }).state;
    // Live streaming reasoning parts are checked inside RenderedPart on the
    // 80ms throttle — avoid rescanning the full growing buffer at 20Hz here.
    if (state === "streaming") return false;
    const raw = (p as unknown as { text?: string }).text ?? "";
    const cleaned = stripLeakedTokens(raw);
    return !cleaned;
  }
  if (t === "text") {
    const state = (p as { state?: string }).state;
    if (state === "streaming") return false;
    const raw = (p as unknown as { text?: string }).text ?? "";
    if (INLINE_THINKING_TAG_RE.test(raw)) {
      const segments = splitThinkingBlocks(raw);
      if (!showModelThinking) {
        const visibleOnly = segments
          .filter((s) => !s.thinking)
          .map((s) => stripLeakedTokens(s.text))
          .join("");
        return !visibleOnly.trim() || isBlankMarkdown(visibleOnly);
      }
      const hasVisibleText = segments.some((s) => {
        if (s.thinking) return false;
        const cleaned = stripLeakedTokens(s.text);
        return Boolean(cleaned.trim()) && !isBlankMarkdown(cleaned);
      });
      const hasThinking = segments.some((s) => s.thinking);
      return !hasVisibleText && !hasThinking;
    }
    const cleaned = stripLeakedTokens(raw);
    return !cleaned || isBlankMarkdown(cleaned);
  }
  if (t === "dynamic-tool" || t.startsWith("tool-")) {
    return false;
  }
  // RenderedPart returns null for any other unknown part type.
  return true;
}

export function buildPartGroups(
  parts: AnyPart[],
  compact?: boolean,
  showModelThinking = true,
): Group[] {
  const out: Group[] = [];
  let run: { parts: AnyPart[]; startIdx: number } | null = null;
  // Compact card mode: consecutive calls of the SAME tool collapse into a
  // "calls" group (mirrors the reads grouping the wide surfaces already do
  // for read_file) so a bash burst is one row, not five.
  let callRun: { toolName: string; parts: AnyPart[]; startIdx: number } | null =
    null;
  const flushCalls = () => {
    if (!callRun) return;
    if (callRun.parts.length >= 2) {
      out.push({
        kind: "calls",
        toolName: callRun.toolName,
        parts: callRun.parts,
        startIdx: callRun.startIdx,
        key: `calls-${partKey(callRun.parts[0], callRun.startIdx)}`,
      });
    } else {
      callRun.parts.forEach((p, k) => {
        const idx = callRun!.startIdx + k;
        out.push({ kind: "single", part: p, idx, key: partKey(p, idx) });
      });
    }
    callRun = null;
  };
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
    if (isInvisiblePart(p, showModelThinking)) return;
    if (isReadFilePart(p)) {
      flushCalls();
      if (!run) run = { parts: [], startIdx: i };
      run.parts.push(p);
      return;
    }
    flushRun();
    if (compact) {
      const gname = groupableToolName(p);
      if (gname) {
        if (callRun && callRun.toolName === gname) {
          callRun.parts.push(p);
          return;
        }
        flushCalls();
        callRun = { toolName: gname, parts: [p], startIdx: i };
        return;
      }
    }
    flushCalls();
    out.push({ kind: "single", part: p, idx: i, key: partKey(p, i) });
  });
  flushRun();
  flushCalls();
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
          {val === 1 ? "█" : "\u00A0"}
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

/**
 * Compact card mode (Workspaces): collapse N consecutive calls of the same
 * tool into ONE row - a "Run x3" chip that expands to the individual compact
 * Tool rows. A bash burst is one line, not five. Header shows the tool glyph
 * + label + count; trailing dots preview each call's state. Approval-needed
 * and media parts never group (groupableToolName filters them), so every
 * part here is a settled or running plain call.
 */
const ToolGroup = memo(function ToolGroup({
  toolName,
  parts,
}: {
  toolName: string;
  parts: AnyPart[];
}) {
  const { label, Icon } = useMemo(() => toolVisualMeta(toolName), [toolName]);
  return (
    <Collapsible className="group/call overflow-hidden rounded-md border border-border/50 bg-card/50">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1 text-left text-[11.5px]",
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
            "group-data-[state=open]/call:rotate-90",
          )}
        />
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">{label}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {"\u00D7"}
          {parts.length}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 group-data-[state=open]/call:invisible">
          {parts.map((p, i) => {
            const st = (p as { state?: string }).state ?? "";
            const err = st === "output-error";
            const denied = st === "output-denied";
            const running =
              st === "input-streaming" ||
              st === "input-available" ||
              st === "approval-responded";
            return (
              <span
                key={i}
                className={cn(
                  "size-1.5 rounded-full",
                  err
                    ? "bg-destructive"
                    : denied
                      ? "bg-orange-500"
                      : running
                        ? "bg-amber-500 animate-pulse"
                        : "bg-emerald-500/70",
                )}
              />
            );
          })}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="Kai-collapsible-content border-t border-border/30">
        <div className="flex flex-col gap-1 px-1.5 py-1.5">
          {parts.map((p, i) => (
            <Tool
              key={`${partKey(p, i)}-${i}`}
              toolName={toolName}
              state={(p as { state: ToolPart["state"] }).state}
              input={(p as { input?: unknown }).input}
              output={"output" in p ? (p as { output?: unknown }).output : undefined}
              errorText={"errorText" in p ? (p as { errorText?: string }).errorText : undefined}
              compact
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

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
  // Same dot contract as the Tool card (STATUS_DOT in ai-elements/tool.tsx):
  // amber while running (input-streaming/input-available/approval-*), hollow
  // ring when done, destructive on error. The old literal `border` added 2px
  // to the done state and visibly offset the row on every settle - reads are
  // typically the FIRST row of a run, so this was the jump users saw most.
  // ring-inset keeps every state the same 6px geometry.
  const dot = isError
    ? "bg-destructive"
    : state === "output-available" || state === "output-denied"
      ? "bg-transparent ring-1 ring-inset ring-muted-foreground/40"
      : "bg-amber-500";
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full transition-[background-color,box-shadow] duration-200 ease-out",
          dot,
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

type ApprovalQueueInfo = { queued: boolean; position: number; total: number };

const STREAM_TEXT_THROTTLE_MS = 80;

/**
 * Streaming perf: a part's raw text grows on every token, and re-running
 * `stripLeakedTokens` + Streamdown over the whole accumulated text per token
 * is O(n²) — it saturates the main thread, freezes the chat UI, and lags the
 * terminal until the LLM finishes. This throttles the *visible* text while a
 * part is live: tokens are batched at ~12 fps, and the exact final text is
 * flushed the moment streaming stops.
 */
function useThrottledStreamingText(raw: string, live: boolean): string {
  const [text, setText] = useState(raw);
  const latestRef = useRef(raw);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasLiveRef = useRef(live);

  useEffect(() => {
    latestRef.current = raw;
    const wasLive = wasLiveRef.current;
    wasLiveRef.current = live;

    if (!live) {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setText(raw);
      return;
    }

    // Paint the first tokens immediately when streaming begins.
    if (!wasLive) setText(raw);

    // Schedule at most one pending flush. Deliberately NOT cleared on raw
    // changes (that would starve updates until tokens pause); it re-arms
    // itself after firing and reads the latest text via `latestRef`.
    if (timerRef.current == null) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setText(latestRef.current);
      }, STREAM_TEXT_THROTTLE_MS);
    }
  }, [raw, live]);

  // Unmount cleanup only.
  useEffect(
    () => () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    },
    [],
  );

  return text;
}

const RenderedPart = memo(function RenderedPart({
  part,
  onApproval,
  streaming,
  approvalQueue,
  compact,
  sessionId,
  hideThinking,
}: {
  part: AnyPart;
  onApproval: (id: string, approved: boolean) => void;
  streaming: boolean;
  approvalQueue?: ApprovalQueueInfo | null;
  compact?: boolean;
  sessionId?: string;
  hideThinking?: boolean;
}) {
  // SHOW/HIDE MODEL THINKING (Settings -> General -> Chat): when off,
  // reasoning parts and inline <thinking> pills are not rendered at all.
  // hideThinking (Workspaces cards) forces the OFF state regardless of
  // the preference - that toggle belongs to the project AI window only.
  const prefShowModelThinking = usePreferencesStore((s) => s.showModelThinking);
  const showModelThinking = prefShowModelThinking && !hideThinking;
  // Only text/reasoning parts stream. For them, throttle the visible text so
  // stripLeakedTokens + Streamdown run at most ~12 fps instead of per token.
  const rawText =
    part.type === "text" || part.type === "reasoning"
      ? (part as unknown as { text: string }).text
      : "";
  const live = streaming && (part.type === "text" || part.type === "reasoning");
  const throttled = useThrottledStreamingText(rawText, live);
  // PERF (2026-11-24): inline `<thinking>` text MUST ride the same 80ms
  // throttle + memo as plain text. Previously it read `part.text` raw and
  // ran splitThinkingBlocks + stripLeakedTokens unmemoized on every 50ms
  // flush, making long local-model thinking streams O(n²).
  const textRender = useMemo(() => {
    if (part.type !== "text") return null;
    if (!INLINE_THINKING_TAG_RE.test(throttled)) {
      const cleaned = stripLeakedTokens(throttled);
      if (!cleaned || isBlankMarkdown(cleaned)) return { kind: "empty" as const };
      return { kind: "plain" as const, text: cleaned };
    }
    const segments = splitThinkingBlocks(throttled);
    if (!showModelThinking) {
      const visibleOnly = segments
        .filter((s) => !s.thinking)
        .map((s) => stripLeakedTokens(s.text))
        .join("");
      if (!visibleOnly.trim() || isBlankMarkdown(visibleOnly)) {
        return { kind: "empty" as const };
      }
      return { kind: "plain" as const, text: visibleOnly };
    }
    const prepared: Array<{ thinking: boolean; text: string }> = [];
    for (const seg of segments) {
      if (seg.thinking) {
        prepared.push({ thinking: true, text: seg.text });
        continue;
      }
      const cleaned = stripLeakedTokens(seg.text);
      if (!cleaned.trim() || isBlankMarkdown(cleaned)) continue;
      prepared.push({ thinking: false, text: cleaned });
    }
    if (prepared.length === 0) return { kind: "empty" as const };
    return { kind: "segments" as const, segments: prepared };
  }, [part.type, throttled, showModelThinking]);

  const reasoningText = useMemo(() => {
    if (part.type !== "reasoning" || !showModelThinking) return "";
    return stripLeakedTokens(throttled);
  }, [part.type, throttled, showModelThinking]);

  if (part.type === "text") {
    if (!textRender || textRender.kind === "empty") return null;
    if (textRender.kind === "plain") {
      return (
        <MessageResponse streaming={streaming}>
          {textRender.text}
        </MessageResponse>
      );
    }
    const segs = textRender.segments;
    return (
      <>
        {segs.map((seg, i) =>
          seg.thinking ? (
            <Reasoning key={i}>
              <ReasoningTrigger />
              <ReasoningContent>{seg.text}</ReasoningContent>
            </Reasoning>
          ) : (
            <MessageResponse key={i} streaming={streaming && i === segs.length - 1}>
              {seg.text}
            </MessageResponse>
          ),
        )}
      </>
    );
  }

  if (part.type === "reasoning") {
    if (!showModelThinking) return null;
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
        approvalQueue={approvalQueue}
        compact={compact}
        sessionId={sessionId}
      />
    );
  }

  return null;
});

const RenderedTool = memo(function RenderedTool({
  part,
  onApproval,
  approvalQueue,
  compact,
  sessionId,
}: {
  part: AnyToolPart;
  onApproval: (id: string, approved: boolean) => void;
  approvalQueue?: ApprovalQueueInfo | null;
  compact?: boolean;
  /** Owning session: the approval card must read ITS Ask/Allow mode. */
  sessionId?: string;
}) {
  const toolName =
    part.type === "dynamic-tool"
      ? part.toolName
      : part.type.replace(/^tool-/, "");

  // A finished background media job OWNS this card. The SDK rewrites the
  // in-flight assistant message from its own response state on every stream
  // write, so a resolved image was clobbered back to the "generating"
  // placeholder (it appeared, then vanished and regenerated). The store's
  // overlay is the authoritative result; prefer it over part.output.
  const resolvedMediaOutput =
    "toolCallId" in part && typeof part.toolCallId === "string"
      ? getMediaOverride(part.toolCallId)
      : undefined;
  const mediaOutput =
    resolvedMediaOutput ?? ("output" in part ? part.output : undefined);

  if (part.state === "approval-requested") {
    return (
      <AiToolApproval
        part={part as Extract<ToolUIPart, { state: "approval-requested" }>}
        toolName={toolName}
        onRespond={(approved) => onApproval(part.approval.id, approved)}
        queue={approvalQueue}
        sessionId={sessionId}
      />
    );
  }

  // Render generated images/videos inline instead of as collapsed tool
  // output. display_video and display_image carry the same media-output
  // shape on success (2026-11-06: media tools surface in chat like
  // generated media, terminal decoration is the optional second surface).
  if (
    (toolName === "generate_image" ||
      toolName === "generate_video" ||
      toolName === "display_video" ||
      toolName === "display_image") &&
    isMediaOutput(mediaOutput)
  ) {
    return <MediaMessage output={mediaOutput} />;
  }

  // A background media failure is a terminal result too. Without this branch
  // the error object fell into a collapsed generic tool card, so a provider
  // rejection looked exactly like a job that never completed.
  if (
    (toolName === "generate_image" || toolName === "generate_video") &&
    typeof (mediaOutput as { error?: unknown } | undefined)?.error === "string"
  ) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {toolName === "generate_image" ? "Image" : "Video"} generation failed: {String((mediaOutput as { error: string }).error)}
      </div>
    );
  }

  // Show a live "generating…" state for media jobs running in the background.
  if (
    (toolName === "generate_image" || toolName === "generate_video") &&
    isGeneratingMedia(mediaOutput)
  ) {
    const g = mediaOutput;
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-card/60 px-3 py-2.5 text-xs text-muted-foreground">
        <Spinner />
        <span className="truncate">
          Generating {g.kind} via {g.providerLabel ?? g.provider}…
        </span>
      </div>
    );
  }

  return (
    <Tool
      toolName={toolName}
      state={part.state}
      input={part.input}
      output={"output" in part ? part.output : undefined}
      errorText={"errorText" in part ? part.errorText : undefined}
      defaultOpen={toolName === "list_directory"}
      compact={compact}
    />
  );
});

/**
 * iMessage-style day separator between message groups. Rendered by the
 * transcript map whenever the calendar day changes between consecutive
 * timestamped messages; legacy (pre-feature) messages carry no timestamp
 * and never trigger one — their day is unknown.
 */
function DaySeparator({ ts }: { ts: number }) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const label =
    d.toDateString() === today.toDateString()
      ? "Today"
      : d.toDateString() === yesterday.toDateString()
        ? "Yesterday"
        : d.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
          });
  return (
    <div
      className="flex select-none items-center gap-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70"
      role="separator"
      aria-label={label}
    >
      <span className="h-px flex-1 bg-border/60" />
      <span>{label}</span>
      <span className="h-px flex-1 bg-border/60" />
    </div>
  );
}
