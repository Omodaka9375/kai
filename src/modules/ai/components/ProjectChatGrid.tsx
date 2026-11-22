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
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import Shield01Icon from "@hugeicons/core-free-icons/Shield01Icon";
import StarIcon from "@hugeicons/core-free-icons/StarIcon";
import Tick01Icon from "@hugeicons/core-free-icons/Tick01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getModel, type ModelId } from "../config";
import { AiChatView } from "./AiChat";
import { AiErrorBoundary } from "./AiErrorBoundary";
import {
  Conversation,
  ConversationContent,
} from "@/components/ai-elements/conversation";
import { useWhisperRecording } from "../hooks/useWhisperRecording";
import {
  getOrCreateChat,
  useChatStore,
  patchSessionAgentMeta,
  subscribeSessionAgentMeta,
  getSessionAgentMeta,
  getSessionMetaVersionFor,
  setSessionSteeringMessage,
  stopSession,
  setSessionAutoApprove,
  getSessionAutoApprove,
  subscribeSessionAutoApprove,
  getSessionAutoApproveVersion,
  getProjectEffectiveModelId,
  setProjectSelectedModelId,
  subscribeProjectModels,
  getProjectModelVersion,
  newSessionForProject,
  resolveBackgroundProjectSession,
} from "../store/chatStore";
import {
  getSessionPreferences,
  setSessionPreferences,
  subscribeSessionPreferences,
} from "../store/sessionPreferences";
import {
  getProjectActiveSession,
  subscribeProjectActiveSessions,
} from "../store/projectRegistry";
import { subscribeProjectAgentStatus, getProjectAgentStatus } from "../store/projectStatus";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setGridOrder } from "@/modules/settings/store";
import { useChatFontSize } from "../lib/chatFont";
import type { ProjectSwitcherItem } from "@/modules/workspace";
import { projectIconFillCss } from "@/modules/workspace/projectIcons";
import { GRID_COLS, GRID_ROWS } from "../store/projectChatGrid";
import {
  type CardAttachment,
  cardImageAttachment,
  cardPasteChip,
  imageFilesFromClipboard,
  shouldAttachCardPaste,
} from "../lib/cardPaste";
import {
  liveGroupForProject,
  sendGroupMessage,
  subscribeGroupChats,
  getGroupStoreVersion,
  type GroupChat,
} from "../store/groupChatStore";

/**
 * WORKSPACES (the project chat grid, 2026-11-18; universal view 2026-11-19):
 * a fixed 2x4, no-scroll overview of the open projects' chats — each card
 * is the mini-window BODY (live transcript, working approval cards, no top
 * bar) plus its own input and the shared mic, tinted with its project's
 * icon color. Ordering follows the project rail top-down; cards fill
 * row-major (rail 1-4 top row, 5-8 bottom row).
 *
 * SURFACE (2026-11-19): each card binds to the project's ACTIVE chat
 * surface — the group panel when that project's live group owns the
 * stack rail, else the project's active AI session. A group card renders
 * the GROUP transcript (participant-tinted, same layout as the panel) and
 * sends via sendGroupMessage (delivers to every participant's session);
 * the status dot/label follow the project's agent status either way.
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

/** Card busy-ring colors - the SAME palette the rail's tile status dot
 *  uses (ProjectRail TileStatusDot), so a glance at either surface reads
 *  identically: emerald = agent running, violet = needs your input, red =
 *  error. Literal values (not Tailwind classes) because the ring is
 *  animated through color-mix, which needs a real color value. */
const CARD_GLOW_COLOR: Record<Exclude<CellStatus, "idle">, string> = {
  running: "#10b981", // emerald-500 (rail: steady emerald)
  awaiting: "#8b5cf6", // violet-500 (rail: pulsing violet)
  error: "var(--destructive)",
};

/**
 * CARD PASTE (2026-11-19): both card inputs accept text + image pastes.
 * Long/structured text becomes a removable chip; images become a tiny
 * thumbnail pill (provider-gated like the main composer) and ride the send
 * as inline file parts. Shared logic lives in lib/cardPaste.ts.
 */
const CardPastePills = memo(function CardPastePills({
  files,
  onRemove,
}: {
  files: CardAttachment[];
  onRemove: (id: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-wrap gap-1 px-3 pt-1.5">
      {files.map((f) =>
        f.kind === "image" ? (
          <button
            key={f.id}
            type="button"
            title={`${f.name} - remove`}
            onClick={() => onRemove(f.id)}
            className="shrink-0 rounded border border-border/60 p-px transition-colors hover:border-destructive/60"
          >
            <img
              src={f.payload}
              alt={f.name}
              className="size-6 rounded-sm object-cover"
              draggable={false}
            />
          </button>
        ) : (
          <button
            key={f.id}
            type="button"
            title={`${f.name} - remove`}
            onClick={() => onRemove(f.id)}
            className="flex max-w-[130px] shrink-0 items-center rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[9.5px] text-muted-foreground transition-colors hover:border-destructive/60 hover:text-foreground"
          >
            <span className="truncate">{f.name}</span>
          </button>
        ),
      )}
    </div>
  );
});

/**
 * CLIP FADES (2026-11-19 card polish): a card transcript is almost always
 * scrolled - mid-message text just CUTS at the rounded edge and there is no
 * signal that more exists above. This wrapper paints soft background
 * gradients at the top/bottom edges, but ONLY while content is actually
 * clipped there (the transcript's role="log" scroll element is watched for
 * scroll position + content resizes, streaming included). Static always-on
 * fades would wash out the first/last line of short chats.
 */
function useTranscriptClips(ref: React.RefObject<HTMLDivElement | null>) {
  const [clips, setClips] = useState({ top: false, bottom: false });
  // No dep list by design: re-acquires the scroll element whenever React
  // swaps subtrees (empty-state <-> transcript), and update() bails on
  // equal state so the re-run is inert. Re-observes the content node too -
  // a scroll container's own box never changes while text streams.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>('[role="log"]');
    if (!el) return;
    const update = () => {
      setClips((c) => {
        const top = el.scrollTop > 4;
        const bottom =
          el.scrollHeight - el.scrollTop - el.clientHeight > 4;
        return c.top === top && c.bottom === bottom
          ? c
          : { top, bottom };
      });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  });
  return clips;
}

const TranscriptFrame = memo(function TranscriptFrame({
  children,
}: {
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const clips = useTranscriptClips(ref);
  return (
    <div
      ref={ref}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {children}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-10 h-4 bg-gradient-to-b from-background to-transparent transition-opacity duration-200",
          clips.top ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-4 bg-gradient-to-t from-background to-transparent transition-opacity duration-200",
          clips.bottom ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
});

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

/** Switch callback supplied by the parent (AppShell) via context so the
 *  memoized cells don't take a changing prop. */
const SwitchProjectContext = createContext<(id: string) => void>(() => {});
export const SwitchProjectContextProvider = SwitchProjectContext.Provider;

function sessionOfCell(projectId: string): string | null {
  return getProjectActiveSession(projectId);
}

/** The group a card should show, or null when the card is a plain AI chat.
 *  A group counts only when it is LIVE and the project's panel currently
 *  shows it (stack rail on "group" + that group open). */
function groupOfCell(projectId: string): GroupChat | null {
  const s = useChatStore.getState();
  if (s.stackRail.surface !== "group") return null;
  const g = liveGroupForProject(projectId);
  return g && g.id === openGroupUiId ? g : null;
}

/** Open-group UI id: the panel's openGroupId is component-local, so the
 *  panel mirrors it here on change (mirrorOpenGroupId below). Module-level
 *  (not React state) so groupOfCell can read it synchronously. */
let openGroupUiId: string | null = null;
export function mirrorOpenGroupId(id: string | null): void {
  if (openGroupUiId === id) return;
  openGroupUiId = id;
  for (const l of openGroupUiListeners) l();
}
const openGroupUiListeners = new Set<() => void>();
function subscribeOpenGroupUi(listener: () => void): () => void {
  openGroupUiListeners.add(listener);
  return () => openGroupUiListeners.delete(listener);
}

function mergeTranscriptIntoDraft(
  existing: string | null | undefined,
  transcript: string,
): string {
  const pre = (existing ?? "").trim();
  return pre ? `${pre} ${transcript}` : transcript;
}

export function ProjectChatGrid({ items }: { items: ProjectSwitcherItem[] }) {
  // DRAG-TO-REORDER (2026-11-20): the persisted gridOrder preference drives
  // display order; ids absent from it sort after (natural items order), so
  // new projects append without touching the saved array. Drag lifecycle:
  // dragId tracks WHICH card is carried (dimmed style + dragover checks);
  // dragOrder holds the LIVE sequence while a drag is in flight -
  // committed to the preferences store on dragend only, so a dragover
  // storm never spams the prefs file.
  const gridOrder = usePreferencesStore((s) => s.gridOrder);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const handleDragStart = useCallback((id: string) => {
    setDragId(id);
    setDragOrder(null);
  }, []);
  const handleDragOverCard = useCallback(
    (overId: string) => {
      const from = dragId;
      if (!from || from === overId) return;
      setDragOrder((prev) => {
        const base = prev ?? gridOrder;
        const visible = items
          .slice(0, GRID_ROWS * GRID_COLS)
          .map((c) => c.id);
        const eff = [
          ...base.filter((id) => visible.includes(id)),
          ...visible.filter((id) => !base.includes(id)),
        ];
        const fromIdx = eff.indexOf(from);
        const toIdx = eff.indexOf(overId);
        if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return prev;
        const next = eff.slice();
        next.splice(fromIdx, 1);
        next.splice(toIdx, 0, from);
        return next;
      });
    },
    [dragId, gridOrder, items],
  );
  const handleDragEnd = useCallback(() => {
    if (dragOrder) void setGridOrder(dragOrder);
    setDragOrder(null);
    setDragId(null);
  }, [dragOrder]);
  const cells = useMemo(() => {
    const visible = items.slice(0, GRID_ROWS * GRID_COLS);
    // Live drag sequence wins over the persisted one so cards follow the
    // pointer in real time; the store is updated once on dragend.
    const order = dragOrder ?? gridOrder;
    const pos = new Map(order.map((id, i) => [id, i]));
    const UNRANKED = Number.MAX_SAFE_INTEGER;
    return [...visible].sort((a, b) => {
      const ai = pos.get(a.id) ?? UNRANKED;
      const bi = pos.get(b.id) ?? UNRANKED;
      return ai - bi;
    });
  }, [items, gridOrder, dragOrder]);
  const projectIds = useMemo(() => cells.map((cell) => cell.id), [cells]);
  const statuses = useProjectStatuses(projectIds);

  // LAZY LOAD (2026-11-19): every card loads and streams on its own — no
  // click-to-visit. A project whose sessions were never hydrated (never
  // switched to since launch) resolves through the background resolver:
  // it reads the project's own sessions file from disk, seeds the active
  // session's history, and binds the project's active session in the
  // registry. That registry write re-renders the card via its
  // subscribeProjectActiveSessions subscription, and CellBody mounts with
  // a seeded chat. The resolver dedupes in-flight calls, so re-running
  // this effect is safe.
  useEffect(() => {
    for (const cell of cells) {
      if (getProjectActiveSession(cell.id)) continue;
      void resolveBackgroundProjectSession(cell.id).catch(() => {});
    }
  }, [cells]);

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
        "absolute z-40 grid grid-rows-2 overflow-hidden gap-2 rounded-2xl border border-border/60 bg-card text-[12px]",
        "shadow-[0_24px_48px_-12px_rgba(0,0,0,0.45)] ring-1 ring-black/5 dark:ring-white/5",
        // UNIVERSAL (2026-11-19): ABSOLUTE inside AppShell's post-rail
        // container — spans everything right of the rail, independent of
        // any project's sidebar (which is collapsed while this is open).
        // Tight universal view (2026-11-19): the grid renders ONLY while
        // Workspaces is open, and that mode hides both the bottom AI input
        // and the status bar - so there is no strip to reserve and the
        // cards take the screen down to a small bottom margin. (The +42px
        // calc here used to reserve the status-bar band that created a
        // dead gap under the grid.)
        "inset-x-2 top-[2.85rem] bottom-2",
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
          dragging={dragId === cell.id}
          onDragStartCell={handleDragStart}
          onDragOverCell={handleDragOverCard}
          onDragEndCell={handleDragEnd}
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
  /** Drag-to-reorder: true while THIS card is being carried. */
  dragging: boolean;
  onDragStartCell: (id: string) => void;
  onDragOverCell: (id: string) => void;
  onDragEndCell: () => void;
};

const GridCell = memo(function GridCell(props: GridCellProps) {
  const { projectId, name, status, active, color, dragging } = props;
  const switchProject = useContext(SwitchProjectContext);
  // The project-LOCAL active session (background projects keep their own).
  const sessionId = useSyncExternalStore(
    subscribeProjectActiveSessions,
    () => sessionOfCell(projectId),
  );
  // GROUP SURFACE (2026-11-19): when this project's group panel owns the
  // stack rail, the card shows the GROUP, not the project AI chat. Both
  // subscriptions re-render the card when the surface flips either way.
  useSyncExternalStore(subscribeOpenGroupUi, () => openGroupUiId);
  useSyncExternalStore(subscribeGroupChats, getGroupStoreVersion);
  const group = useMemo(() => groupOfCell(projectId), [projectId, sessionId]);

  return (
    <div
      onDragOver={(e) => {
        // preventDefault makes this card a valid drop target so the
        // live-reorder fires while the pointer is over it.
        e.preventDefault();
        props.onDragOverCell(projectId);
      }}
      onDrop={(e) => e.preventDefault()}
      style={
        status !== "idle"
          ? ({
              "--kai-card-glow": CARD_GLOW_COLOR[status],
            } as React.CSSProperties)
          : undefined
      }
      className={cn(
        // UNIFORM CARDS (2026-11-19): no selected outline in Workspaces -
        // it is a universal view, the active card would just be whichever
        // project the user last foregrounded. All cards share one border;
        // the project-color tint and the busy ring carry the differences.
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-background/95",
        dragging && "opacity-50",
      )}
    >
      {/* BUSY RING (2026-11-20 v3): the CARD is the status indicator, in
          the SAME palette as the rail's tile dot - emerald = agent
          running, violet = needs your input, red = error. Painted as an
          OVERLAY on the card's own top layer so it can never be hidden
          behind card content or an adjacent card (the box-shadow-only
          version was invisible in the dense 8px-gap grid). Replaces the
          removed header dot + status label. */}
      {status !== "idle" && <span aria-hidden className="kai-card-glow" />}
      {/* Slim header, TINTED with the project's icon color (2026-11-19):
          same hue scheme the rail tile uses, so each card reads as its
          project at a glance. Status lives in the CARD's glow (see the
          busy-glow note above), not here.

          FULL-STRIP DRAG (2026-11-20): the WHOLE status bar is the drag
          handle and the open target - no inner button spans the strip any
          more. A <button> covering the bar swallowed dragstart (browsers do
          not start a drag from a button inside a draggable ancestor), so
          dragging only worked on the few pixels of padding and on the grip
          icon. The title is now a plain span: the strip drags from
          anywhere and select-none keeps a text selection from hijacking
          the gesture.

          DOUBLE-CLICK OPENS (2026-11-20): a single click on the bar no
          longer switches project - it is a drag surface, and an accidental
          click while grabbing used to yank the user out of Workspaces. The
          guard skips double-clicks that land on a real control (the
          Ask/Allow pill) so a fast pill toggle never opens the project.

          CURSOR (2026-11-21): hover shows the POINTER, not a grab hand -
          the bar's primary action is double-click-to-open. The grabbing
          hand appears only during a press (or while the card is carried). */}
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          props.onDragStartCell(projectId);
        }}
        onDragEnd={props.onDragEndCell}
        onDoubleClick={(e) => {
          // Controls inside the bar (Ask/Allow pill) own their clicks.
          if ((e.target as HTMLElement).closest("button")) return;
          switchProject(projectId);
        }}
        title={
          group
            ? `${name} — group "${group.name}" — double-click to open, drag to reorder`
            : `${name} — double-click to open, drag to reorder`
        }
        style={{ background: projectIconFillCss(color, projectId, active) }}
        // CURSOR HONESTY (2026-11-21): a constant grab hand read as "this
        // only drags", but a click on the bar also opens the project on
        // double-click. Hover shows the POINTER (the click affordance); the
        // grabbing hand appears only while the gesture is live - :active
        // during a press, plus the explicit flag while this card is the one
        // being carried (a native HTML5 drag can drop :active).
        className={cn(
          "flex shrink-0 select-none items-center gap-1 border-b border-border/40 px-3 py-1.5",
          dragging ? "cursor-grabbing" : "cursor-pointer active:cursor-grabbing",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {/* GROUP SURFACE IN THE TITLE (2026-11-21): a card swaps from the
              project AI chat to its GROUP transcript when the group panel owns
              the stack rail. Without the group name in the bar the two
              surfaces look identical, so the title reads "project · group". */}
          <span className="truncate text-[11px] font-medium text-foreground">
            {group ? `${name} · ${group.name}` : name}
          </span>
        </div>
        {!group ? (
          <CardModelPill projectId={projectId} sessionId={sessionId} />
        ) : null}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
          {sessionId ? <SessionApprovePill sessionId={sessionId} /> : null}
          {!group ? (
            <button
              type="button"
              onClick={() => {
                newSessionForProject(projectId);
              }}
              title="New session"
              aria-label={`New session in ${name}`}
              className="flex shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
            </button>
          ) : null}
        </div>
      </div>

      {group ? (
        <GroupCardBody group={group} {...props} projectId={projectId} />
      ) : sessionId ? (
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

/** Ask/Allow pill for a card's OWN session (Workspaces, 2026-11-19):
 *  same state as the project chat's AutoApproveToggle - the session-scoped
 *  map via the version counter, NOT the legacy presentation field (that
 *  follows the FOREGROUND session). Writes via setSessionAutoApprove so
 *  the project chat's toggle follows the same state. Colors match the
 *  toggle: Ask = amber (attention), Allow = green (free to run). */
const SessionApprovePill = memo(function SessionApprovePill({
  sessionId,
}: {
  sessionId: string;
}) {
  useSyncExternalStore(subscribeSessionAutoApprove, getSessionAutoApproveVersion);
  const mode = getSessionAutoApprove(sessionId);
  const onClick = useCallback(() => {
    setSessionAutoApprove(sessionId, mode === "off" ? "all" : "off");
  }, [sessionId, mode]);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={mode === "off" ? "Ask mode (click to switch to Allow)" : "Allow mode (click to switch to Ask)"}
      title={
        mode === "off"
          ? "Ask mode: ask before every approval-required tool call (click to switch to Allow)"
          : "Allow mode: allow tool calls without asking (click to switch to Ask)"
      }
      className={cn(
        "flex shrink-0 items-center justify-center rounded p-0.5 transition-colors hover:bg-accent/60",
        mode === "off" ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400",
      )}
    >
      <HugeiconsIcon icon={Shield01Icon} size={12} strokeWidth={2} />
    </button>
  );
});

/** Shorten a model display label so the compact card pill stays tiny. */
export function shortenModelLabel(label: string): string {
  const s = label
    .replace(
      /^(Anthropic|OpenAI|Google|DeepSeek|Mistral|Meta|Alibaba|Zhipu|Moonshot|xAI)\s*[:/·-]?\s*/i,
      "",
    )
    .replace(/^Claude\s+/i, "")
    .replace(/\s+\(Preview\)$/i, "")
    .trim();
  return s || label;
}

/** Compact model pill centered in a Workspaces card top bar: shows the
 *  shortened active model name for THIS project/session and opens a small
 *  dropdown of the user's favorite models on click. */
const CardModelPill = memo(function CardModelPill({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string | null;
}) {
  useSyncExternalStore(subscribeProjectModels, getProjectModelVersion);
  useSyncExternalStore(
    subscribeSessionPreferences,
    () => (sessionId ? getSessionPreferences(sessionId).modelId ?? "" : ""),
  );
  // Subscribe to persisted per-project and global default model changes too.
  usePreferencesStore((s) => s.projectModelIds);
  usePreferencesStore((s) => s.defaultModelId);
  const favoriteIds = usePreferencesStore((s) => s.favoriteModelIds);
  const compatModelId = usePreferencesStore((s) => s.openaiCompatibleModelId);

  const selected = getProjectEffectiveModelId(projectId, sessionId);
  const current = getModel(selected);
  const fullLabel =
    current.id === "openai-compatible-custom" && compatModelId.trim()
      ? compatModelId.trim()
      : current.label;
  const shortLabel = shortenModelLabel(fullLabel);

  const favoriteModels = useMemo(
    () => favoriteIds.map((id) => getModel(id as ModelId)),
    [favoriteIds],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={`Model: ${fullLabel} — click for favorites`}
          className="flex max-w-[100px] shrink-0 items-center gap-0.5 rounded bg-background/40 px-1.5 py-0.5 text-[9.5px] font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <span className="truncate">{shortLabel}</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={9}
            strokeWidth={2}
            className="shrink-0 opacity-70"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        className="max-h-56 w-48 overflow-y-auto p-1"
      >
        {favoriteModels.length === 0 ? (
          <div className="flex items-center gap-1.5 px-2 py-2 text-[10.5px] text-muted-foreground/80">
            <HugeiconsIcon
              icon={StarIcon}
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-amber-500/80"
            />
            <span>No favorite models starred yet.</span>
          </div>
        ) : (
          favoriteModels.map((m) => {
            const isSelected = m.id === selected;
            const label =
              m.id === "openai-compatible-custom" && compatModelId.trim()
                ? compatModelId.trim()
                : m.label;
            return (
              <DropdownMenuItem
                key={m.id}
                onSelect={() => {
                  setProjectSelectedModelId(projectId, m.id as ModelId);
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[11px]",
                  isSelected
                    ? "bg-accent/60 font-medium text-foreground"
                    : "text-foreground/85",
                )}
              >
                <HugeiconsIcon
                  icon={StarIcon}
                  size={10}
                  strokeWidth={2}
                  className="shrink-0 fill-amber-500 text-amber-500"
                />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {isSelected ? (
                  <HugeiconsIcon
                    icon={Tick01Icon}
                    size={11}
                    strokeWidth={2}
                    className="shrink-0 text-foreground"
                  />
                ) : null}
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/** GROUP CARD BODY (2026-11-19): the group transcript, compact — same
 *  message layout as the group panel (participant-tinted names, user
 *  bubbles right-capped, system notes centered italic), plus a one-line
 *  input that fans out via sendGroupMessage. No per-participant presence
 *  strips or menus: the card is an at-a-glance surface; open the project
 *  for the full panel. */
const GroupCardBody = memo(function GroupCardBody(props: GridCellProps & { group: GroupChat }) {
  const { group } = props;
  const [text, setText] = useState("");
  const textRef = useRef(text);
  textRef.current = text;
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // SYMMETRIC CHAT ZOOM (2026-11-20): the group transcript rides the SAME
  // shared chatFontSize ratio as AiChatView (AI cards, panels, mini
  // window). Without it, generated code blocks and prose in AI cards
  // rendered proportionally larger than the group cards whenever the
  // preference was above the 12px default.
  const chatFontZoomStyle = useChatFontSize().rootStyle;
  const ended = group.endedAt !== null;
  // CARD PASTE (2026-11-19): group sends are text-only (the fan-out is a
  // string relay), so pasted IMAGES land as persisted-path attachments
  // referenced by text ("image saved at ..."), and long text becomes a
  // chip that inlines its body on send.
  const [pasted, setPasted] = useState<CardAttachment[]>([]);
  const pastedRef = useRef(pasted);
  pastedRef.current = pasted;
  const removePasted = useCallback(
    (id: string) => setPasted((prev) => prev.filter((f) => f.id !== id)),
    [],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const images = imageFilesFromClipboard(e.clipboardData);
      if (images.length > 0) {
        e.preventDefault();
        void (async () => {
          const next: CardAttachment[] = [];
          for (const f of images) next.push(await cardImageAttachment(f));
          setPasted((prev) => [...prev, ...next]);
        })();
        return;
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (shouldAttachCardPaste(text)) {
        e.preventDefault();
        setPasted((prev) => [...prev, cardPasteChip(text)]);
      }
    },
    [],
  );

  const nameFor = useCallback(
    (pid: string) => {
      const p = group.participants.find((x) => x.projectId === pid);
      return p ? p.name : pid;
    },
    [group.participants],
  );

  const send = useCallback(() => {
    const trimmed = textRef.current.trim();
    const files = pastedRef.current;
    if (!trimmed && files.length === 0) return;
    if (ended || sending) return;
    setSending(true);
    void (async () => {
      try {
        // Compose: persisted image paths first, then text-chip bodies, then
        // the typed message (same order the AI cards use).
        let body = trimmed;
        for (const f of files) {
          if (f.kind === "image") {
            const b64 = f.payload.split(",")[1] ?? "";
            try {
              const { persistUploadedMedia } = await import("../lib/media/persist");
              const { native } = await import("../lib/native");
              const path = await persistUploadedMedia(native, {
                name: f.name,
                mimeType: f.mediaType,
                base64: b64,
              });
              if (path) {
                body = `${body ? body + "\n\n" : ""}[image attached: ${f.name} saved at ${path} - use read tools that accept image paths to view it]${body ? "" : "\n" + trimmed}`;
              } else {
                body = `${body}\n\n[image attached: ${f.name} - could not be saved to disk]`;
              }
            } catch {
              body = `${body}\n\n[image attached: ${f.name} - could not be saved to disk]`;
            }
          } else {
            body = `${body ? body + "\n\n" : ""}<file name="${f.name}" mediaType="${f.mediaType}">\n${f.payload}\n</file>`;
          }
        }
        const r = await sendGroupMessage(group.id, body);
        if (r.length === 0 && !ended) {
          setSendError("no deliverable participants");
        } else {
          setText("");
          setPasted([]);
          setSendError(null);
        }
      } catch (e) {
        setSendError(e instanceof Error ? e.message : String(e));
      } finally {
        setSending(false);
      }
    })();
  }, [ended, sending, group.id]);

  return (
    <>
      {/* Same bounded wrapper as CellBody (TranscriptFrame carries the
          min-h-0/min-w-0 contract + the clip fades). */}
      <TranscriptFrame>
        <AiErrorBoundary>
          <Conversation className="px-3 py-2">
            <ConversationContent className="gap-3" style={chatFontZoomStyle}>
              {group.messages.length === 0 ? (
                <div className="flex flex-1 items-center justify-center px-3 text-center text-[11px] text-muted-foreground/70">
                  No messages yet
                </div>
              ) : (
                group.messages.slice(-40).map((m) =>
                  m.from === "system" ? (
                    <div
                      key={m.id}
                      className="px-1 text-center text-[10px] italic text-muted-foreground/70"
                    >
                      {m.text}
                    </div>
                  ) : (
                    <div
                      key={m.id}
                      className={cn(
                        "flex flex-col gap-0.5",
                        m.from === "user" && "ml-auto max-w-[85%]",
                      )}
                    >
                      <div
                        className={cn(
                          "flex items-center gap-1.5 text-[10px] text-muted-foreground",
                          m.from === "user" && "justify-end",
                        )}
                      >
                        <span className="font-medium text-foreground/80">
                          {m.from === "user" ? "You" : nameFor(m.projectId)}
                        </span>
                      </div>
                      <div
                        className={cn(
                          "whitespace-pre-wrap break-words text-[11px] leading-snug",
                          m.from === "user"
                            ? "rounded-lg bg-muted/70 px-2 py-1 text-foreground"
                            : "text-foreground/90",
                        )}
                      >
                        {m.text}
                      </div>
                    </div>
                  ),
                )
              )}
            </ConversationContent>
          </Conversation>
        </AiErrorBoundary>
      </TranscriptFrame>
      <CardPastePills files={pasted} onRemove={removePasted} />
      <div className="flex shrink-0 items-center gap-1.5 border-t border-border/40 bg-card/40 px-3 py-1.5">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          disabled={ended}
          placeholder={ended ? "Group ended" : sendError ? sendError : "Message group."}
          className="max-h-12 min-h-[20px] flex-1 resize-none bg-transparent text-[11px] leading-snug text-foreground outline-none placeholder:text-muted-foreground/50"
        />
        <button
          type="button"
          title="Send (Enter)"
          disabled={ended || sending || (!text.trim() && pasted.length === 0)}
          onClick={send}
          className={cn(
            "shrink-0 rounded-full p-1 transition-colors",
            (text.trim() || pasted.length > 0) && !ended && !sending
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40",
          )}
        >
          <HugeiconsIcon icon={NextIcon} size={12} strokeWidth={2} />
        </button>
      </div>
    </>
  );
});

/** Split props so CellBody only re-renders on its own slice. */
type CellBodyProps = GridCellProps & { sessionId: string; projectId: string };

const CellBody = memo(function CellBody(props: CellBodyProps) {
  const { sessionId, micRecording, micTranscribing, micBusy, micTarget, voiceError, onMicDown, onMicStop } = props;
  // Session-scoped busy signal (thinking/streaming/awaiting-approval).
  // PER-SESSION snapshot (freeze fix, 2026-11-22): the global meta version
  // moves on every streaming patch of ANY session (outputTps alone fires
  // 2x/s per streaming agent), which re-rendered all 8 cards at that rate.
  // The per-session counter only moves when THIS session's meta changes.
  useSyncExternalStore(
    subscribeSessionAgentMeta,
    () => getSessionMetaVersionFor(sessionId),
  );
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
      {/* Bounded flex COLUMN (2026-11-19): min-h-0 gives AiChatView's
          Conversation (`flex-1 overflow-y-auto`) a bounded height, so it
          scrolls on hover and stick-to-bottom pins to the newest text as
          it streams. min-w-0: a flex item defaults to min-width:auto, so
          a wide code block's intrinsic width would inflate this wrapper
          past the narrow card and the card CLIPS on the right instead of
          the block scrolling inside - Streamdown's code-block bodies
          (overflow-x-auto) then scroll horizontally WITHIN the card. */}
      <TranscriptFrame>
        <AiErrorBoundary>
          <AiChatView
            messages={helpers.messages}
            status={helpers.status}
            error={helpers.error}
            clearError={helpers.clearError}
            // CARD RHYTHM (2026-11-19): 12px horizontal padding on EVERY
            // card region (header, transcript, input) so text and chrome
            // share one aligned edge; slightly tighter message gap for
            // the narrow card.
            contentClassName="gap-4 px-3 pb-3"
            // CARD MODE: compact tool rows (trailing state dot, chip bg)
            // + consecutive same-tool calls collapse into one group row.
            compact
            // OWNING SESSION (2026-11-21): a card shows a NON-foreground
            // project's chat, so approval cards must read THIS session's
            // Ask/Allow mode - reading the foreground project's mode made
            // a card paint the buttonless green "auto-approved" row while
            // its own bridge never approved anything (the card stalled
            // until the pill was toggled twice).
            sessionId={sessionId}
          />
        </AiErrorBoundary>
      </TranscriptFrame>
      <CellInput
        key={sessionId}
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

  // CARD PASTE (2026-11-19): pending paste attachments (text chips + image
  // pills) for THIS card, cleared on send. Image path blocks persist at
  // send time (async, best-effort) - the same contract as the main composer.
  const [pasted, setPasted] = useState<CardAttachment[]>([]);
  const pastedRef = useRef(pasted);
  pastedRef.current = pasted;
  const removePasted = useCallback(
    (id: string) => setPasted((prev) => prev.filter((f) => f.id !== id)),
    [],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const images = imageFilesFromClipboard(e.clipboardData);
      if (images.length > 0) {
        e.preventDefault();
        void (async () => {
          const next: CardAttachment[] = [];
          for (const f of images) next.push(await cardImageAttachment(f));
          setPasted((prev) => [...prev, ...next]);
        })();
        return;
      }
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (shouldAttachCardPaste(text)) {
        e.preventDefault();
        setPasted((prev) => [...prev, cardPasteChip(text)]);
      }
    },
    [],
  );

  const canSend =
    (text.trim().length > 0 || pasted.length > 0) && !micTranscribing;

  const send = useCallback(() => {
    const trimmed = textRef.current.trim();
    const files = pastedRef.current;
    if (!trimmed && files.length === 0) return;
    if (files.length === 0) {
      // No attachments: the original pure-text path (steering keeps its
      // exact wire shape).
      if (busy) {
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
      return;
    }
    // With attachments: compose text blocks first, then inline image file
    // parts - the same wire shape the main composer produces. Image path
    // blocks resolve before the send (async persistence, best-effort).
    void (async () => {
      const textBlocks = files
        .filter((f) => f.kind === "text")
        .map(
          (f) =>
            `<file name="${f.name}" mediaType="${f.mediaType}">\n${f.payload}\n</file>`,
        );
      const imageAtts = files.filter((f) => f.kind === "image");
      const pathBlocks: string[] = [];
      for (const f of imageAtts) {
        const b64 = f.payload.split(",")[1] ?? "";
        try {
          const { persistUploadedMedia } = await import("../lib/media/persist");
          const { native } = await import("../lib/native");
          const path = await persistUploadedMedia(native, {
            name: f.name,
            mimeType: f.mediaType,
            base64: b64,
          });
          if (path) {
            pathBlocks.push(
              `<attachment name="${f.name}" savedAt="${path}">The attached image ${f.name} is also saved at the file path above - pass that path to tools that need a file.</attachment>`,
            );
          }
        } catch {
          // Best-effort: the image still rides inline as a file part.
        }
      }
      const composed = [...pathBlocks, ...textBlocks, trimmed]
        .filter(Boolean)
        .join("\n\n");
      const parts: Array<
        | { type: "text"; text: string }
        | { type: "file"; mediaType: string; url: string; filename?: string }
      > = [];
      if (composed) parts.push({ type: "text", text: composed });
      for (const f of imageAtts) {
        parts.push({
          type: "file",
          mediaType: f.mediaType,
          url: f.payload,
          filename: f.name,
        });
      }
      if (busy) {
        setSessionSteeringMessage(
          sessionId,
          parts as unknown as Array<{ type: "text"; text: string }>,
        );
      } else {
        void chat.sendMessage({
          role: "user",
          parts,
        } as unknown as Parameters<typeof chat.sendMessage>[0]);
        patchSessionAgentMeta(sessionId, {
          hitStepCap: false,
          finishReason: "",
          compactionNotice: null,
          summaryNotice: null,
        });
      }
    })();
    setText("");
    setPasted([]);
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
    <>
      <CardPastePills files={pasted} onRemove={removePasted} />
      <div className="flex shrink-0 items-center gap-1.5 border-t border-border/40 bg-card/40 px-3 py-1.5">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        rows={1}
        placeholder={
          micTranscribing
            ? "Transcribing…"
            : busy
              ? "Steer the running agent."
              : "Send a message"
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
          className={cn(
            // PRIMARY ACTION ANNOUNCES ITSELF (2026-11-19): once there is
            // something to send the glyph flips to a filled disc - a
            // muted arrow at 12px was invisible until hover.
            "shrink-0 rounded-full p-1 transition-colors",
            canSend
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40",
          )}
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
    </>
  );
});
