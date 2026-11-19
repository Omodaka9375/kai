import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Chat as SdkChat, UIMessage } from "@ai-sdk/react";
import { useChat } from "@ai-sdk/react";
import Mic01Icon from "@hugeicons/core-free-icons/Mic01Icon";
import NextIcon from "@hugeicons/core-free-icons/NextIcon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { AiChatView } from "./AiChat";
import { AiErrorBoundary } from "./AiErrorBoundary";
import { useWhisperRecording } from "../hooks/useWhisperRecording";
import {
  getOrCreateChat,
  useChatStore,
  patchSessionAgentMeta,
  subscribeSessionAgentMeta,
  getSessionAgentMeta,
  getSessionMetaVersion,
  setSessionSteeringMessage,
  stopSession,
} from "../store/chatStore";
import {
  getSessionPreferences,
  setSessionPreferences,
} from "../store/sessionPreferences";
import {
  getProjectActiveSession,
  subscribeProjectActiveSessions,
} from "../store/projectRegistry";
import { subscribeProjectAgentStatus, getProjectAgentStatus } from "../store/projectStatus";
import type { ProjectSwitcherItem } from "@/modules/workspace";
import { projectIconCss, projectIconFillCss } from "@/modules/workspace/projectIcons";
import { GRID_COLS, GRID_ROWS } from "../store/projectChatGrid";

/**
 * WORKSPACES (the project chat grid, 2026-11-18; universal view 2026-11-19):
 * a fixed 2x4, no-scroll overview of the open projects' chats — each card
 * is the mini-window BODY (live transcript, working approval cards, no top
 * bar) plus its own input and the shared mic, tinted with its project's
 * icon color. Ordering follows the project rail top-down; cards fill
 * row-major (rail 1-4 top row, 5-8 bottom row).
 *
 * UNIVERSAL VIEW (2026-11-19): opening Workspaces collapses the sidebar and
 * hides the per-project AI window — the grid is app-level, spanning the
 * area right of the project rail, not tied to any project. Geometry is
 * ABSOLUTE inside AppShell's post-rail container (NOT the sidebar-offset
 * CSS variable the expanded AI window uses), so it stays full-width while
 * the sidebar is collapsed.
 *
 * SCROLLING: each card's transcript scrolls on hover (wheel over a card
 * scrolls THAT card's Conversation); stick-to-bottom keeps it pinned to the
 * newest text as it streams. The card body wrapper is a min-h-0 flex column
 * — without it the Conversation has no bounded height, the parent clips
 * instead of scrolling, and hover-scroll is dead.
 *
 * NOT the global composer: that singleton follows the FOREGROUND session;
 * a card input must send to its OWN project's session. Each card keeps its
 * own draft and calls chat.sendMessage directly — the project's
 * AgentRunBridge (mounted per workspace, background-safe) picks the run
 * up. A busy agent gets the steering queue for THAT session.
 *
 * MIC (ONE instance, deliberately): a single useWhisperRecording owned by
 * the grid. micTarget snapshots which card's session the recording is for;
 * the transcript routes into that card's draft only. Click-only (never
 * bound to the global Kai:ai-voice-toggle — that shortcut belongs to the
 * main composer; one shortcut must not start two recordings).
 */

type CellStatus = ProjectSwitcherItem["status"];

/** Live project-status map; re-reads on every agent-status transition. */
function useProjectStatuses(projectIds: string[]): Record<string, CellStatus> {
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeProjectAgentStatus(() => setVersion((v) => v + 1)), []);
  const [statuses, setStatuses] = useState<Record<string, CellStatus>>({});
  useEffect(() => {
    const next: Record<string, CellStatus> = {};
    for (const id of projectIds) {
      const raw = getProjectAgentStatus(id);
      next[id] =
        raw === "awaiting-approval"
          ? "awaiting"
          : raw === "error"
            ? "error"
            : raw === "idle"
              ? "idle"
              : "running";
    }
    setStatuses(next);
  }, [projectIds, version]);
  return statuses;
}

function statusLabel(status: CellStatus): string {
  if (status === "awaiting") return "needs input";
  if (status === "error") return "error";
  if (status === "running") return "running";
  return "idle";
}

/** Switch callback supplied by the parent (AppShell) via context so the
 *  memoized cells don't take a changing prop. */
const SwitchProjectContext = createContext<(id: string) => void>(() => {});
export const SwitchProjectContextProvider = SwitchProjectContext.Provider;

function sessionOfCell(projectId: string): string | null {
  return getProjectActiveSession(projectId);
}

function mergeTranscriptIntoDraft(
  existing: string | null | undefined,
  transcript: string,
): string {
  const pre = (existing ?? "").trim();
  return pre ? `${pre} ${transcript}` : transcript;
}

export function ProjectChatGrid({ items }: { items: ProjectSwitcherItem[] }) {
  const cells = useMemo(
    () => items.slice(0, GRID_ROWS * GRID_COLS),
    [items],
  );
  const projectIds = useMemo(() => cells.map((cell) => cell.id), [cells]);
  const statuses = useProjectStatuses(projectIds);

  // ── The ONE mic instance ──────────────────────────────────────────────
  const micTargetRef = useRef<string | null>(null);
  const [micTarget, setMicTarget] = useState<string | null>(null);
  const voice = useWhisperRecording({
    onResult: (transcript) => {
      const target = micTargetRef.current;
      if (!target) return;
      // Land the transcript in the captured cell's persisted draft, then
      // bump the global tick so the cell (a _tick subscriber) re-reads it.
      setSessionPreferences(target, {
        draft: mergeTranscriptIntoDraft(getSessionPreferences(target).draft, transcript),
      });
      useChatStore.setState({ _tick: Date.now() });
    },
  });
  const startCellVoice = useCallback(
    (sessionId: string) => {
      if (voice.recording || voice.transcribing) return;
      if (voice.error) voice.clearError();
      micTargetRef.current = sessionId;
      setMicTarget(sessionId);
      voice.start();
    },
    [voice],
  );
  const stopCellVoice = useCallback(() => {
    voice.stop();
  }, [voice]);
  const micBusy = voice.recording || voice.transcribing;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      role="region"
      aria-label="Workspaces"
      data-project-chat-grid
      style={{ gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))` }}
      className={cn(
        "no-scrollbar-deep absolute z-40 grid grid-rows-2 overflow-hidden gap-2 rounded-2xl border border-border/60 bg-card text-[12px]",
        "shadow-[0_24px_48px_-12px_rgba(0,0,0,0.45)] ring-1 ring-black/5 dark:ring-white/5",
        // UNIVERSAL (2026-11-19): ABSOLUTE inside AppShell's post-rail
        // container — spans everything right of the rail, independent of
        // any project's sidebar (which is collapsed while this is open).
        // Same vertical footprint as the expanded AI window: below the
        // header, above the input-bar strip. No scroll: fixed 2x4.
        "inset-x-2 top-[2.85rem] bottom-[calc(var(--kai-input-bar-h,0px)+42px)]",
      )}
    >
      {cells.map((cell) => (
        <GridCell
          key={cell.id}
          projectId={cell.id}
          name={cell.name}
          status={statuses[cell.id] ?? "idle"}
          active={cell.active}
          color={cell.color}
          micRecording={voice.recording && micTarget === sessionOfCell(cell.id)}
          micTranscribing={voice.transcribing && micTarget === sessionOfCell(cell.id)}
          micBusy={micBusy}
          micTarget={micTarget}
          voiceError={voice.error}
          onMicDown={startCellVoice}
          onMicStop={stopCellVoice}
        />
      ))}
    </motion.div>
  );
}

type GridCellProps = {
  projectId: string;
  name: string;
  status: CellStatus;
  active: boolean;
  /** Project icon color preset key ("auto"/undefined = hash hue). */
  color?: string;
  micRecording: boolean;
  micTranscribing: boolean;
  micBusy: boolean;
  micTarget: string | null;
  voiceError: string | null;
  onMicDown: (sessionId: string) => void;
  onMicStop: () => void;
};

const GridCell = memo(function GridCell(props: GridCellProps) {
  const { projectId, name, status, active, color } = props;
  const switchProject = useContext(SwitchProjectContext);
  // The project-LOCAL active session (background projects keep their own).
  const sessionId = useSyncExternalStore(
    subscribeProjectActiveSessions,
    () => sessionOfCell(projectId),
  );

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border",
        active ? "border-primary/50 bg-background" : "border-border/60 bg-background/95",
      )}
    >
      {/* Slim header, TINTED with the project's icon color (2026-11-19):
          same hue scheme the rail tile uses, so each card reads as its
          project at a glance. Dot = project color (pulses on awaiting/
          running); label still carries the agent status. Click opens the
          project. */}
      <button
        type="button"
        title={`${name} — open project`}
        onClick={() => switchProject(projectId)}
        style={{ background: projectIconFillCss(color, projectId, active) }}
        className="flex shrink-0 items-center gap-1.5 border-b border-border/40 px-2.5 py-1 text-left transition-colors hover:bg-accent/40"
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            status === "awaiting" && "animate-pulse",
            status === "running" && "animate-pulse",
            status === "error" && "bg-destructive",
          )}
          style={
            status === "error"
              ? undefined
              : { background: projectIconCss(color, projectId) }
          }
        />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
          {name}
        </span>
        <span className="shrink-0 text-[9.5px] text-muted-foreground/70">
          {statusLabel(status)}
        </span>
      </button>

      {sessionId ? (
        <CellBody sessionId={sessionId} {...props} projectId={projectId} />
      ) : (
        <button
          type="button"
          onClick={() => switchProject(projectId)}
          className="flex flex-1 items-center justify-center text-center text-[11px] text-muted-foreground/70 transition-colors hover:bg-accent/40"
        >
          No chat yet — open project
        </button>
      )}
    </div>
  );
});

/** Split props so CellBody only re-renders on its own slice. */
type CellBodyProps = GridCellProps & { sessionId: string; projectId: string };

const CellBody = memo(function CellBody(props: CellBodyProps) {
  const { sessionId, micRecording, micTranscribing, micBusy, micTarget, voiceError, onMicDown, onMicStop } = props;
  // Session-scoped busy signal (thinking/streaming/awaiting-approval),
  // subscribed through the shared meta version counter.
  useSyncExternalStore(subscribeSessionAgentMeta, getSessionMetaVersion);
  const meta = getSessionAgentMeta(sessionId);
  const isBusy =
    meta.status === "thinking" ||
    meta.status === "streaming" ||
    meta.status === "awaiting-approval";

  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const helpers = useChat<UIMessage>({ chat, experimental_throttle: 50 });
  const busy = isBusy || helpers.status === "submitted" || helpers.status === "streaming";

  return (
    <>
      {/* min-h-0 flex COLUMN (2026-11-19 hover-scroll fix): AiChatView's
          Conversation is `flex-1 overflow-y-auto` — without a bounded flex
          height it grows to content, the parent clips, and the wheel over
          the card scrolls nothing. Bounded here, it scrolls on hover and
          stick-to-bottom pins to the newest text as it streams. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <AiErrorBoundary>
          <AiChatView
            messages={helpers.messages}
            status={helpers.status}
            error={helpers.error}
            clearError={helpers.clearError}
          />
        </AiErrorBoundary>
      </div>
      <CellInput
        sessionId={sessionId}
        chat={chat}
        busy={busy}
        micRecording={micRecording}
        micTranscribing={micTranscribing}
        micBusy={micBusy}
        micTarget={micTarget}
        voiceError={voiceError}
        onMicDown={onMicDown}
        onMicStop={onMicStop}
      />
    </>
  );
});

const CellInput = memo(function CellInput({
  sessionId,
  chat,
  busy,
  micRecording,
  micTranscribing,
  micBusy,
  micTarget,
  voiceError,
  onMicDown,
  onMicStop,
}: {
  sessionId: string;
  chat: SdkChat<UIMessage>;
  busy: boolean;
  micRecording: boolean;
  micTranscribing: boolean;
  micBusy: boolean;
  micTarget: string | null;
  voiceError: string | null;
  onMicDown: (sessionId: string) => void;
  onMicStop: () => void;
}) {
  // Draft seed + live mic-transcript landing: subscribe to _tick so the
  // grid-level voice onResult (a session-preferences write + tick bump)
  // re-reads the draft into the field.
  const draftTick = useChatStore((s) => s._tick);
  const draftRef = useRef<string | null>(null);
  const [text, setText] = useState<string>(() => getSessionPreferences(sessionId).draft ?? "");
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    const persisted = getSessionPreferences(sessionId).draft ?? "";
    if (draftRef.current !== null && draftRef.current !== persisted) {
      setText(persisted);
    }
    draftRef.current = persisted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, draftTick]);

  // Persist the field (debounced, same contract as the main composer).
  useEffect(() => {
    const timer = setTimeout(() => {
      setSessionPreferences(sessionId, { draft: text || undefined });
    }, 150);
    return () => clearTimeout(timer);
  }, [sessionId, text]);

  const canSend = text.trim().length > 0 && !micTranscribing;

  const send = useCallback(() => {
    const trimmed = textRef.current.trim();
    if (!trimmed) return;
    if (busy) {
      // Busy cell: steering queue for THIS session — its AgentRunBridge
      // stops the run and re-sends once idle (the composer's busy path).
      setSessionSteeringMessage(sessionId, [{ type: "text", text: trimmed }]);
    } else {
      void chat.sendMessage({ role: "user", parts: [{ type: "text", text: trimmed }] });
      patchSessionAgentMeta(sessionId, {
        hitStepCap: false,
        finishReason: "",
        compactionNotice: null,
        summaryNotice: null,
      });
    }
    setText("");
    setSessionPreferences(sessionId, { draft: undefined });
  }, [busy, chat, sessionId]);

  const stop = useCallback(() => {
    stopSession(sessionId);
  }, [sessionId]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send],
  );

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-t border-border/40 bg-card/40 px-2 py-1">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder={
          micTranscribing
            ? "Transcribing…"
            : busy
              ? "Message the running agent…"
              : "Ask…"
        }
        className="max-h-12 min-h-[20px] flex-1 resize-none bg-transparent text-[11px] leading-snug text-foreground outline-none placeholder:text-muted-foreground/50"
      />
      {busy ? (
        <button
          type="button"
          title="Stop agent"
          onClick={stop}
          className="shrink-0 rounded p-1 text-destructive/80 transition-colors hover:bg-accent hover:text-destructive"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
        </button>
      ) : (
        <button
          type="button"
          title="Send (Enter)"
          disabled={!canSend}
          onClick={send}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <HugeiconsIcon icon={NextIcon} size={12} strokeWidth={2} />
        </button>
      )}
      {micTranscribing ? (
        <HugeiconsIcon
          icon={Mic01Icon}
          size={13}
          strokeWidth={2}
          className="shrink-0 animate-pulse text-primary"
        />
      ) : (
        <button
          type="button"
          title={
            micRecording
              ? "Stop recording"
              : voiceError
                ? `${voiceError} — click to retry`
                : "Dictate"
          }
          onClick={() => {
            if (micRecording) onMicStop();
            else onMicDown(sessionId);
          }}
          disabled={micBusy && micTarget !== sessionId}
          className={cn(
            "shrink-0 rounded p-1 transition-colors",
            micRecording
              ? "animate-pulse bg-destructive/15 text-destructive"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
            voiceError && !micRecording && "text-amber-600 dark:text-amber-400",
            "disabled:opacity-40",
          )}
        >
          <HugeiconsIcon icon={Mic01Icon} size={13} strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
});
