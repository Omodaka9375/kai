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
import MessageMultiple01Icon from "@hugeicons/core-free-icons/MessageMultiple01Icon";
import NextIcon from "@hugeicons/core-free-icons/NextIcon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import CubeIcon from "@hugeicons/core-free-icons/CubeIcon";
import Shield01Icon from "@hugeicons/core-free-icons/Shield01Icon";
import StarIcon from "@hugeicons/core-free-icons/StarIcon";
import SparklesIcon from "@hugeicons/core-free-icons/SparklesIcon";
import Tick01Icon from "@hugeicons/core-free-icons/Tick01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextTrigger,
} from "@/components/ai-elements/context";
import {
  estimateCost,
  getModel,
  getModelContextLimit,
  isProxyManagedModel,
  type ModelId,
} from "../config";
import { effectiveContextLimit, SYSTEM_OVERHEAD_TOKENS } from "../lib/compact";
import { estimateContextTokens } from "../lib/media/contextTokens";
import type { SandboxMode } from "../lib/native";
import {
  loadSandboxModeForProject,
  SANDBOX_LABELS,
  subscribeSandboxChanged,
} from "../lib/sandbox";
import {
  isWorkspaceTrusted,
  subscribeWorkspaceTrust,
} from "@/modules/workspace/workspaceTrust";
import { AiChatView } from "./AiChat";
import { AiErrorBoundary } from "./AiErrorBoundary";
// Card input #skill / /command popup: same detection and the same picker
// body the main composer uses.
import {
  detectSnippetTrigger,
  type SnippetTrigger,
} from "../lib/inputTriggers";
import {
  SLASH_COMMANDS,
  tryRunSlashCommand,
  wrapWithCommandMarker,
} from "../lib/slashCommands";
import { expandSkillTokens } from "../lib/skills";
import { skillsForProject, useSkillsStore } from "../store/skillsStore";
import { BUILTIN_AGENTS, type Agent } from "../lib/agents";
import { useAgentsStore } from "../store/agentsStore";
import { AGENT_ICONS } from "./AgentSwitcher";
import type { PickerItem } from "./SnippetPicker";
import {
  Conversation,
  ConversationContent,
} from "@/components/ai-elements/conversation";
import { useWhisperRecording } from "../hooks/useWhisperRecording";
import {
  getOrCreateChat,
  useChatStore,
  setWorkspacesPinnedSessions,
  patchSessionAgentMeta,
  subscribeSessionAgentMeta,
  getSessionAgentMeta,
  getSessionMetaVersionFor,
  setSessionSteeringMessage,
  stopSession,
  setSessionAutoApprove,
  effectiveSessionAutoApprove,
  subscribeSessionAutoApprove,
  getSessionAutoApproveVersion,
  getProjectEffectiveModelId,
  setProjectSelectedModelId,
  subscribeProjectModels,
  getProjectModelVersion,
  newSessionForProject,
  switchSessionForProject,
  resolveBackgroundProjectSession,
  isGhostSession,
} from "../store/chatStore";
import {
  getSessionPreferences,
  setSessionPreferences,
  subscribeSessionPreferences,
} from "../store/sessionPreferences";
import {
  getProjectActiveSession,
  subscribeProjectActiveSessions,
  getProjectActiveSessionVersion,
  getProjectPersona,
  getProjectRuntime,
} from "../store/projectRegistry";
import { subscribeProjectAgentStatus, getProjectAgentStatus } from "../store/projectStatus";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setGridOrder } from "@/modules/settings/store";
import { useChatFontSize } from "../lib/chatFont";
import type { ProjectSwitcherItem } from "@/modules/workspace";
import { projectIconFillCss } from "@/modules/workspace/projectIcons";
import { CardTrustStrip } from "./TrustStrip";
import { useProjectsMenu } from "@/app/projectsMenu";
import { ACCEPTED_FILES } from "./composer";
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
  // PERF (2026-11-24): attach listeners and ResizeObserver ONCE per log
  // element rather than tearing down + recreating them on every render
  // (every 50ms streaming flush). A lightweight MutationObserver on the
  // frame root handles subtree swaps (empty-state <-> transcript) so we
  // still re-bind automatically when `[role="log"]` mounts or changes.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let boundEl: HTMLElement | null = null;
    let boundContent: Element | null = null;
    let ro: ResizeObserver | null = null;

    const update = () => {
      if (!boundEl) return;
      const el = boundEl;
      setClips((c) => {
        const top = el.scrollTop > 4;
        const bottom = el.scrollHeight - el.scrollTop - el.clientHeight > 4;
        return c.top === top && c.bottom === bottom ? c : { top, bottom };
      });
    };

    const detach = () => {
      if (boundEl) {
        boundEl.removeEventListener("scroll", update);
        boundEl = null;
      }
      boundContent = null;
      ro?.disconnect();
      ro = null;
    };

    const bind = () => {
      const el = root.querySelector<HTMLElement>('[role="log"]');
      if (!el) {
        if (boundEl) {
          detach();
          setClips((c) => (c.top || c.bottom ? { top: false, bottom: false } : c));
        }
        return;
      }
      if (el === boundEl) {
        // Same scroll container; observe newly mounted content child if swapped.
        const first = el.firstElementChild;
        if (first && first !== boundContent && ro) {
          if (boundContent) ro.unobserve(boundContent);
          ro.observe(first);
          boundContent = first;
          update();
        }
        return;
      }
      detach();
      boundEl = el;
      boundContent = el.firstElementChild;
      el.addEventListener("scroll", update, { passive: true });
      ro = new ResizeObserver(update);
      ro.observe(el);
      if (boundContent) ro.observe(boundContent);
      update();
    };

    bind();
    const mo = new MutationObserver(bind);
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      detach();
    };
  }, [ref]);
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
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden select-text"
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
  // STABLE DOM ORDER + CSS `order` (2026-11-23 scroll-reset fix):
  // Reordering React children mutates DOM order via `insertBefore`, which
  // resets `scrollTop = 0` on every scrollable descendant inside moved cards
  // (Chromium/WebView2 spec behavior). Keep `cells` in the stable `items`
  // array order so DOM nodes are NEVER moved on drag, and position each card
  // visually using CSS Grid `order` derived from `dragOrder ?? gridOrder`.
  const cells = useMemo(
    () => items.slice(0, GRID_ROWS * GRID_COLS),
    [items],
  );
  const orderMap = useMemo(() => {
    const order = dragOrder ?? gridOrder;
    const visibleIds = cells.map((c) => c.id);
    const eff = [
      ...order.filter((id) => visibleIds.includes(id)),
      ...visibleIds.filter((id) => !order.includes(id)),
    ];
    return new Map(eff.map((id, i) => [id, i]));
  }, [cells, gridOrder, dragOrder]);
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

  // WORKSPACES PIN (2026-11-23 wipe bug): register the sessions the grid's
  // mounted cells display so the chat LRU never evicts a VISIBLE chat.
  // Evicting one made the cell's next render construct an empty Chat whose
  // mount persist overwrote the session's real disk history with [].
  //
  // RENDER-TIME REGISTRATION (2026-11-25 "cards show new session / no
  // history" report): the pin used to be a useEffect, which runs AFTER the
  // children mounted. On grid OPEN that meant the first render pass
  // constructed every card's Chat with pins still null - and a full grid
  // (8 projects + a fresh session elsewhere) exceeded the LRU cap DURING
  // that pass, evicting a card's chat before the pin ever landed. The
  // evicted card then re-rendered into an empty unseeded Chat that stayed
  // empty (its surface memoizes the Chat by id). Registering during
  // render, synchronously before the cells mount, makes the pin set
  // effective for exactly the render that constructs the chats. The effect
  // below keeps the set refreshed on rebinds and clears it on unmount.
  const pinnedVersion = useSyncExternalStore(
    subscribeProjectActiveSessions,
    getProjectActiveSessionVersion,
  );
  const pinnedIds = useMemo(() => {
    // subscribeProjectActiveSessions guarantees this re-runs on every
    // rebind; version dep keeps it fresh when cells change without a
    // session rebind (project added/removed while the grid is open).
    void pinnedVersion;
    const pins = new Set<string>();
    for (const cell of cells) {
      const sid = getProjectActiveSession(cell.id);
      if (sid) pins.add(sid);
    }
    return pins;
  }, [cells, pinnedVersion]);
  setWorkspacesPinnedSessions(pinnedIds);
  useEffect(() => {
    setWorkspacesPinnedSessions(pinnedIds);
    return () => {
      setWorkspacesPinnedSessions(null);
    };
  }, [pinnedIds]);

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
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  // PERF (2026-11-24): useWhisperRecording returns a fresh object each render;
  // reading through voiceRef gives startCellVoice/stopCellVoice permanent
  // stable identities so memo'd GridCell / CellBody / CellInput don't
  // re-render all 8 cards on every grid status transition.
  const startCellVoice = useCallback((sessionId: string) => {
    const v = voiceRef.current;
    if (v.recording || v.transcribing) return;
    if (v.error) v.clearError();
    micTargetRef.current = sessionId;
    setMicTarget(sessionId);
    v.start();
  }, []);
  const stopCellVoice = useCallback(() => {
    voiceRef.current.stop();
  }, []);
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
      {cells.map((cell, index) => (
        <GridCell
          key={cell.id}
          projectId={cell.id}
          root={cell.root}
          name={cell.name}
          status={statuses[cell.id] ?? "idle"}
          active={cell.active}
          color={cell.color}
          gridOrderIndex={orderMap.get(cell.id) ?? index}
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
  root: string;
  name: string;
  status: CellStatus;
  active: boolean;
  /** Project icon color preset key ("auto"/undefined = hash hue). */
  color?: string;
  /** CSS Grid `order` index so cards rearrange visually without moving DOM
   *  nodes (moving DOM nodes via insertBefore resets descendant scrollTop). */
  gridOrderIndex: number;
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
  const { projectId, root, name, status, active, color, gridOrderIndex, dragging } = props;
  const switchProject = useContext(SwitchProjectContext);
  // The project-LOCAL active session (background projects keep their own).
  const sessionId = useSyncExternalStore(
    subscribeProjectActiveSessions,
    () => sessionOfCell(projectId),
  );
  // GROUP SURFACE (2026-11-19): when this project's group panel owns the
  // stack rail, the card shows the GROUP, not the project AI chat. Capture
  // the snapshots so `useMemo` recomputes whenever group state or stack
  // surface changes.
  const openGroup = useSyncExternalStore(subscribeOpenGroupUi, () => openGroupUiId);
  const groupVer = useSyncExternalStore(subscribeGroupChats, getGroupStoreVersion);
  const stackSurface = useChatStore((s) => s.stackRail.surface);
  const group = useMemo(
    () => groupOfCell(projectId),
    [projectId, sessionId, openGroup, groupVer, stackSurface],
  );
  // CONTEXT MENU (2026-11-23): right-click the card's TOP BAR (not the chat
  // body or input) -> Close Project, the same projectsMenu.closeProject path
  // the rail's X uses (confirmation dialog included - AppShell arms its
  // AlertDialog on this call). Scoping the trigger to the header preserves
  // text/transcript/input right-click menus inside the card body.
  const projectsMenu = useProjectsMenu();
  const closeThisProject = useCallback(() => {
    projectsMenu?.closeProject(projectId);
  }, [projectsMenu, projectId]);

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
        {
          order: gridOrderIndex,
          ...(status !== "idle"
            ? { "--kai-card-glow": CARD_GLOW_COLOR[status] }
            : {}),
        } as React.CSSProperties
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
      <ContextMenu>
        <ContextMenuTrigger asChild>
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
          // kai-tinted-bar (2026-11-25): this bar is ALWAYS tinted with the
          // project's hue (projectIconFillCss above); the class re-inks muted
          // grays and hue-neutralizes the pills' hover washes via globals.css
          // - the flat-card styles they shipped with fought the tint.
          "kai-tinted-bar flex shrink-0 select-none items-center gap-1 border-b border-border/40 px-3 py-1.5",
          // VERTICAL CENTERING (2026-11-23): inline SVGs sit on the text
          // baseline by default, which leaves a descender gap BELOW each
          // icon and pushes everything visually 2-3px above the bar's
          // center. Forcing svg display:block removes the baseline
          // alignment so flexbox centering is exact.
          "[&_svg]:block",
          dragging ? "cursor-grabbing" : "cursor-pointer active:cursor-grabbing",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <CardSandboxIcon root={root} projectId={projectId} />
          {/* GROUP SURFACE IN THE TITLE (2026-11-21): a card swaps from the
              project AI chat to its GROUP transcript when the group panel owns
              the stack rail. Without the group name in the bar the two
              surfaces look identical, so the title reads "project · group".
              CHARACTER CAP (2026-11-23): max 30 shown chars + ellipsis —
              CSS truncate alone hides the tail at the container edge, but
              a long name squeezes the flex row; a hard string cap keeps the
              pill cluster's width stable regardless of project name. */}
          <span className="truncate text-[11px] font-medium leading-none text-foreground">
            {(group ? `${name} · ${group.name}` : name).length > 30
              ? `${(group ? `${name} · ${group.name}` : name).slice(0, 30)}…`
              : group ? `${name} · ${group.name}` : name}
          </span>
        </div>
        {!group && sessionId ? (
          <div className="flex shrink-0 items-center gap-1">
            {/* PILL ORDER (2026-11-23 ask): context ring FIRST, then the
                model pill, then the persona picker - the ring is a passive
                status readout, the persona picker is the active control and
                sits closest to the right-aligned action cluster. */}
            <CardContextRing projectId={projectId} sessionId={sessionId} />
            <CardModelPill projectId={projectId} sessionId={sessionId} />
            <SessionPersonaPill projectId={projectId} sessionId={sessionId} />
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
          {sessionId ? <CardSessionPicker projectId={projectId} sessionId={sessionId} /> : null}
          {sessionId ? <SessionApprovePill sessionId={sessionId} /> : null}
        </div>
      </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44 text-xs">
          <ContextMenuItem
            onSelect={closeThisProject}
            className="gap-2 text-destructive focus:text-destructive"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={2} />
            Close Project
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* WORKSPACES TRUST BANNER (2026-11-25): the grid shows MANY
          projects at once, so the active-project TrustStrip in the AI
          window cannot cover it - each untrusted project's card carries
          its own compact strip with a one-click Trust button. Renders
          nothing once trusted (same defer-until-hydrated semantics as
          TrustStrip, so trusted projects never flash). Placed between the
          tinted header and the body so the transcript scrolls below it. */}
      <CardTrustStrip projectId={projectId} />

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

/** Sandbox indicator icon to the left of the project title when the
 *  project's sandbox mode is active (readOnly or workspaceOnly). Hidden
 *  when sandbox is off. Resolves through loadSandboxModeForProject so an
 *  untrusted new project shows its seeded read-only default (2026-11-25). */
const CardSandboxIcon = memo(function CardSandboxIcon({
  root,
  projectId,
}: {
  root: string;
  projectId: string;
}) {
  const [mode, setMode] = useState<SandboxMode>("off");
  useEffect(() => {
    let alive = true;
    const resolve = () => {
      void loadSandboxModeForProject(root, {
        trusted: isWorkspaceTrusted(projectId),
      }).then((m) => {
        if (alive) setMode(m);
      });
    };
    resolve();
    let unlisten: (() => void) | null = null;
    void subscribeSandboxChanged(() => {
      resolve();
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    // TRUST CHANGES re-resolve (2026-11-25 review): Trust/Untrust flips the
    // seeded-default decision - the card icon follows without a remount.
    const untrust = subscribeWorkspaceTrust(() => {
      resolve();
    });
    return () => {
      alive = false;
      unlisten?.();
      untrust();
    };
  }, [root, projectId]);

  if (mode === "off") return null;

  return (
    <span
      title={SANDBOX_LABELS[mode]}
      aria-label={SANDBOX_LABELS[mode]}
      className="inline-flex shrink-0 items-center text-primary"
    >
      <HugeiconsIcon icon={CubeIcon} size={11} strokeWidth={1.9} />
    </span>
  );
});

function formatCardTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Circle-only context usage indicator for a Workspaces card's session
 *  (no percentage number label; full breakdown hover card on hover). */
const CardContextRing = memo(function CardContextRing({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  useSyncExternalStore(
    subscribeSessionAgentMeta,
    () => getSessionMetaVersionFor(sessionId),
  );
  useSyncExternalStore(subscribeProjectModels, getProjectModelVersion);
  useSyncExternalStore(
    subscribeSessionPreferences,
    () => getSessionPreferences(sessionId).modelId ?? "",
  );
  usePreferencesStore((s) => s.projectModelIds);
  usePreferencesStore((s) => s.defaultModelId);

  const modelId = getProjectEffectiveModelId(projectId, sessionId);
  const meta = getSessionAgentMeta(sessionId);
  const tokens = meta.tokens;
  const lastInput = meta.lastInputTokens;
  const lastCached = meta.lastCachedTokens;

  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const [estimated, setEstimated] = useState(() =>
    estimateContextTokens(chat.messages),
  );
  useEffect(() => {
    setEstimated(estimateContextTokens(chat.messages));
    const t = setInterval(() => {
      setEstimated(estimateContextTokens(chat.messages));
    }, 1000);
    return () => clearInterval(t);
  }, [chat]);

  const used = lastInput > 0 ? Math.max(lastInput, estimated) : estimated;
  const reported = tokens.inputTokens + tokens.outputTokens;
  const max = effectiveContextLimit(getModelContextLimit(modelId));
  // PROXY-MANAGED MEMORY (MemoChain): footer swaps its explanation when this
  // card's session routes through the proxy endpoint (see AiMiniWindow twin).
  const proxyManaged = isProxyManagedModel(modelId);
  const usedPercent = Math.min(1, Math.max(0, max > 0 ? used / max : 0));
  const circumference = 2 * Math.PI * 10;
  const dashOffset = circumference * (1 - usedPercent);

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
      <ContextTrigger asChild>
        <button
          type="button"
          aria-label="Model context usage"
          className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <svg
            aria-hidden
            height="13"
            width="13"
            viewBox="0 0 24 24"
            style={{ color: "currentcolor" }}
          >
            <circle
              cx={12}
              cy={12}
              fill="none"
              opacity="0.25"
              r={10}
              stroke="currentColor"
              strokeWidth={2.2}
            />
            <circle
              cx={12}
              cy={12}
              fill="none"
              opacity="0.75"
              r={10}
              stroke="currentColor"
              strokeDasharray={`${circumference} ${circumference}`}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              strokeWidth={2.2}
              style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
            />
          </svg>
        </button>
      </ContextTrigger>
      <ContextContent className="w-64 text-[11px]">
        <ContextContentHeader />
        <ContextContentBody>
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Model</span>
            <span className="font-mono text-foreground">{modelLabel}</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-muted-foreground">
            <span>
              {used === lastInput && used > 0
                ? "Last request"
                : "Estimated context"}
            </span>
            <span className="font-mono text-foreground">
              {formatCardTokens(used)}
            </span>
          </div>
          {lastCached > 0 && (
            <div className="flex items-center justify-between text-muted-foreground">
              <span>Of which cached</span>
              <span className="font-mono text-foreground">
                {formatCardTokens(lastCached)}
              </span>
            </div>
          )}
          {reported > 0 && (
            <>
              <div className="mt-1.5 flex items-center justify-between text-muted-foreground">
                <span>Session input</span>
                <span className="font-mono text-foreground">
                  {formatCardTokens(tokens.inputTokens)}
                </span>
              </div>
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Session output</span>
                <span className="font-mono text-foreground">
                  {formatCardTokens(tokens.outputTokens)}
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
              {formatCardTokens(max)}
            </span>
          </div>
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Model window</span>
            <span className="font-mono text-foreground">
              {formatCardTokens(getModelContextLimit(modelId))}
            </span>
          </div>
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Reserved (system+tools)</span>
            <span className="font-mono text-foreground">
              {formatCardTokens(
                Math.min(SYSTEM_OVERHEAD_TOKENS, getModelContextLimit(modelId)),
              )}
            </span>
          </div>
        </ContextContentBody>
        <ContextContentFooter>
          <span className="text-[10px] italic text-muted-foreground">
            {proxyManaged
              ? "Proxy-managed session (MemoChain): the proxy owns context memory — it caps the prompt at a hot window + compact memory and verifies state with a receipt chain. Local compaction and /compact are off."
              : "Ring shows pressure on the conversation budget (model window minus system prompt + tool schemas); compaction starts at 40%."}
          </span>
        </ContextContentFooter>
      </ContextContent>
    </Context>
  );
});

/** Session picker toggle for a Workspaces card (2026-11-23 ask): lists the
 *  PROJECT's own sessions (ghosts filtered) and switches the card's bound
 *  session via switchSessionForProject - never the foreground switchSession,
 *  which would yank the foreground project's chat. The button sits LEFT of
 *  the Ask/Allow pill in the card's right-aligned action cluster.
 *
 *  NEW SESSION IN THE DROPDOWN (2026-11-25 declutter): the old standalone
 *  + button in the header was redundant with this picker - "New session"
 *  now lives at the BOTTOM of the list, separated, so one control owns all
 *  session switching AND creation. */
const CardSessionPicker = memo(function CardSessionPicker({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  // The GLOBAL sessions list is cross-project; the card's picker must only
  // offer THIS project's sessions.
  const sessions = useChatStore((s) => s.sessions);
  const rt = getProjectRuntime(projectId);
  const items = useMemo(() => {
    if (!rt) return [];
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    return sessions.filter(
      (s) =>
        !isGhostSession(s) &&
        (s.id === sessionId || (s.workspaceRoot && rt && norm(s.workspaceRoot) === norm(rt.root))),
    );
  }, [sessions, rt, sessionId]);
  const switchTo = useCallback(
    (id: string) => {
      if (id !== sessionId) switchSessionForProject(projectId, id);
    },
[projectId, sessionId],
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Switch session"
          aria-label="Switch session"
          className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          {/* MessageMultiple01Icon: stacked chat bubbles - reads as "sessions"
              and is distinct from every other icon in the bar (shield, cube,
              sparkles, plus). */}
          <HugeiconsIcon icon={MessageMultiple01Icon} size={12} strokeWidth={2} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-64 min-w-48 overflow-y-auto p-1">
        {items.map((s) => (
          <DropdownMenuItem
            key={s.id}
            onSelect={() => switchTo(s.id)}
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 text-[11px]",
              s.id === sessionId && "bg-accent/40",
            )}
          >
            <span className="truncate">{s.title || "New chat"}</span>
          </DropdownMenuItem>
        ))}
        {items.length === 0 ? (
          <div className="px-2 py-1 text-[10px] text-muted-foreground">No sessions</div>
        ) : null}
        <DropdownMenuSeparator className="my-1" />
        <DropdownMenuItem
          onSelect={() => {
            newSessionForProject(projectId);
          }}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px]"
        >
          <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
          <span>New session</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
  // TRUST GATE: the pill paints the EFFECTIVE mode (untrusted project =
  // amber Ask) and its tooltip says so; clicking still writes the user's
  // stored preference, which resumes effect once the project is trusted.
  const mode = effectiveSessionAutoApprove(sessionId);
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
        // p-1 (2026-11-25): the tinted bar made the old p-0.5 hit area read
        // as an unpadded colored square on hover; hover wash is hue-neutral
        // (hover:bg-foreground/10) so it never fights the project tint.
        "flex shrink-0 items-center justify-center rounded p-1 transition-colors hover:bg-foreground/10",
        mode === "off" ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400",
      )}
    >
      <HugeiconsIcon icon={Shield01Icon} size={12} strokeWidth={2} />
    </button>
  );
});

/** Session-scoped persona picker for a Workspaces card: shows the current
 *  persona's icon and switches THIS session's persona. Uses
 *  setSessionPreferences(personaId) — the same session-scoped activation the
 *  set_persona tool uses — never setActiveId, which would rewrite the
 *  FOREGROUND project's persona. */
const SessionPersonaPill = memo(function SessionPersonaPill({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  // Re-render on session preference, project persona, and app-default
  // persona changes - all three feeds of the resolution below.
  useSyncExternalStore(subscribeSessionPreferences, () => getSessionPreferences(sessionId).personaId ?? "");
  useSyncExternalStore(subscribeProjectModels, getProjectModelVersion);
  const agentsActiveId = useAgentsStore((s) => s.activeId);
  const customAgents = useAgentsStore((s) => s.customAgents);
  // EFFECTIVE PERSONA (2026-11-23): the runtime resolves the session's
  // persona as session pref ?? project persona ?? app default
  // (chatStore.getAgentPersonaId + chatRuntime's activeId fallback). The
  // pill read ONLY the session preference, so a card whose session had no
  // explicit pin showed the generic "No persona" spark icon while its
  // agent actually ran under e.g. Security - the visible "wrong icon".
  // Resolve the same chain the runtime does.
  const personaId =
    getSessionPreferences(sessionId).personaId ??
    getProjectPersona(projectId) ??
    agentsActiveId ??
    "__none__";
  const list = useMemo(() => {
    const byId = new Map<string, Agent>();
    for (const b of BUILTIN_AGENTS) byId.set(b.id, b);
    for (const c of customAgents) byId.set(c.id, c);
    return [...byId.values()];
  }, [customAgents]);
  const active = personaId === "__none__" ? null : list.find((a) => a.id === personaId) ?? null;
  const ActiveIcon = active ? (AGENT_ICONS[active.icon] ?? SparklesIcon) : SparklesIcon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={active ? `Persona: ${active.name} (click to switch)` : "No persona (click to set one)"}
          aria-label="Switch persona"
          className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <HugeiconsIcon icon={ActiveIcon} size={12} strokeWidth={1.75} className={active ? "text-primary" : undefined} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="max-h-72 min-w-52 overflow-y-auto p-1">
        <DropdownMenuItem
          onSelect={() => setSessionPreferences(sessionId, { personaId: "__none__" })}
          className={cn("flex items-center gap-1.5 rounded px-2 py-1 text-[11px]", personaId === "__none__" && "bg-accent/40")}
        >
          <span className="w-3 text-center text-[10px] text-muted-foreground/70">—</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span>None</span>
            <span className="line-clamp-1 text-[9.5px] text-muted-foreground">
              No persona - base system prompt only
            </span>
          </span>
        </DropdownMenuItem>
        {list.map((a) => {
          const Icon = AGENT_ICONS[a.icon] ?? SparklesIcon;
          return (
            <DropdownMenuItem
              key={a.id}
              onSelect={() => setSessionPreferences(sessionId, { personaId: a.id })}
              className={cn(
                "flex items-center gap-1.5 rounded px-2 py-1 text-[11px]",
                a.id === personaId && "bg-accent/40",
              )}
            >
              <HugeiconsIcon icon={Icon} size={12} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{a.name}</span>
                {a.description ? (
                  <span className="line-clamp-1 text-[9.5px] text-muted-foreground">{a.description}</span>
                ) : null}
              </span>
              {a.id === personaId ? (
                <HugeiconsIcon icon={Tick01Icon} size={11} strokeWidth={2} className="shrink-0 text-foreground" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
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
          // kai-tint-chip (2026-11-25): the old bg-background/40 painted a
          // flat gray rectangle on the tinted bar; the chip class gives a
          // translucent tinted surface + hairline border via globals.css.
          className="kai-tint-chip flex max-w-[100px] shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[9.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
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
                      data-msg-author={m.from === "user" ? "You" : nameFor(m.projectId)}
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
          className="max-h-[79px] min-h-[20px] flex-1 resize-none bg-transparent text-[11px] leading-snug text-foreground outline-none placeholder:text-muted-foreground/50"
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
  const { sessionId, root, micRecording, micTranscribing, micBusy, micTarget, voiceError, onMicDown, onMicStop } = props;
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
            // THINKING UI: cards never show reasoning pills/thinking
            // blocks - the showModelThinking toggle is for the project
            // AI window only, and at 290px wide the pills are noise.
            hideThinking
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
        root={root}
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
  root,
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
  /** Project root for skillsForProject (project skills shadow globals). */
  root: string;
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
  const lastSessionRef = useRef(sessionId);
  const [text, setText] = useState<string>(() => getSessionPreferences(sessionId).draft ?? "");
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    const persisted = getSessionPreferences(sessionId).draft ?? "";
    const sessionChanged = lastSessionRef.current !== sessionId;
    lastSessionRef.current = sessionId;
    if (sessionChanged) {
      draftRef.current = persisted;
      setText(persisted);
      return;
    }
    // Only pull an external draft write (e.g. mic transcript landing) when
    // `persisted` actually moved away from what we last saw/wrote AND the
    // user does not have unsaved local keystrokes pending in the debounce.
    if (
      draftRef.current !== null &&
      draftRef.current !== persisted &&
      textRef.current === draftRef.current
    ) {
      setText(persisted);
    }
    draftRef.current = persisted;
  }, [sessionId, draftTick]);

  // Persist the field (debounced, same contract as the main composer).
  useEffect(() => {
    const timer = setTimeout(() => {
      draftRef.current = text;
      setSessionPreferences(sessionId, { draft: text || undefined });
    }, 150);
    return () => clearTimeout(timer);
  }, [sessionId, text]);

  // ── #skill / /command popup (2026-11-23) ─────────────────────────────
  // Same detection and same picker body as the main composer (AiInputBar);
  // the picker is an absolutely-positioned dropdown above the input strip
  // (the group-chat mention-picker pattern — a Radix Popover needs an
  // anchor and portals can escape the card's clip). Skills resolve against
  // THIS project's root so project skills shadow globals.
  const snippets = useSkillsStore((s) => s.globalSkills);
  const mergedSkills = useMemo(
    () => skillsForProject(root),
    [snippets, root],
  );
  const slashCommands = useMemo(() => Object.values(SLASH_COMMANDS), []);
  const [trigger, setTrigger] = useState<SnippetTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pickerOpen = trigger !== null;

  useEffect(() => {
    setActiveIndex(0);
  }, [pickerOpen, trigger?.query, trigger?.char]);

  const filteredItems = useMemo<PickerItem[]>(() => {
    if (!trigger) return [];
    const q = trigger.query;
    const cmdItems: PickerItem[] = slashCommands
      .filter((c) => !q || c.name.includes(q) || c.label.toLowerCase().includes(q))
      .map((command) => ({ kind: "command", command }));
    // `/` shows commands only; `#` shows commands + skills (main-composer
    // contract: "/" is the canonical command prefix, skills live on "#").
    const snipItems: PickerItem[] =
      trigger.char === "/"
        ? []
        : mergedSkills
            .filter(
              (s) =>
                !q ||
                s.handle.includes(q) ||
                s.name.toLowerCase().includes(q) ||
                s.description.toLowerCase().includes(q),
            )
            .map((snippet) => ({ kind: "snippet", snippet }));
    return [...cmdItems, ...snipItems];
  }, [trigger, mergedSkills, slashCommands]);

  const updateTrigger = useCallback(() => {
    const el = textareaRef.current;
    if (!el) {
      setTrigger(null);
      return;
    }
    setTrigger(detectSnippetTrigger(textRef.current, el.selectionStart ?? 0));
  }, []);

  const onPickItem = useCallback(
    (item: PickerItem) => {
      if (!trigger) return;
      const before = textRef.current.slice(0, trigger.start);
      const after = textRef.current.slice(trigger.end).replace(/^\s+/, "");
      // Insert the token the send path will expand: `#handle` for skills,
      // the command name for commands — the card's send() runs
      // expandSkillTokens / tryRunSlashCommand on submit just like the main
      // composer's submit.
      const token =
        item.kind === "snippet"
          ? `#${item.snippet.handle} `
          : `/${item.command.name} `;
      const next = `${before}${token}${after}`;
      setText(next);
      setTrigger(null);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange((before + token).length, (before + token).length);
      });
    },
    [trigger],
  );

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

  // FILE UPLOAD (2026-11-25 ask): hidden input + the + button RIGHT of the
  // mic. Routed through the SAME card-attachment pipeline as paste: images
  // become image pills (cardImageAttachment), anything readable-as-text
  // becomes a name chip carrying the file's content - so the + needs no new
  // send-path shape, the pills/composition below already handle both kinds.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const onPickFiles = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = ""; // allow re-picking the same file
      if (files.length === 0) return;
      void (async () => {
        const next: CardAttachment[] = [];
        for (const f of files) {
          if (f.type.startsWith("image/")) {
            next.push(await cardImageAttachment(f));
          } else {
            // Text-ish file: chip carrying the file's content (paste-chip
            // shape). Unreadable picks degrade to a note instead of poison.
            const text = await f.text().catch(() => null);
            next.push({
              id: `${f.name}-${f.size}-${f.lastModified}`,
              name: f.name,
              kind: "text",
              mediaType: f.type || "text/plain",
              payload:
                text != null
                  ? text
                  : `[file "${f.name}" could not be read as text]`,
            });
          }
        }
        setPasted((prev) => [...prev, ...next]);
      })();
    },
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

  // TRANSIENT COMMAND TOAST (e.g. "/compact" outcome), shown above the
  // card input strip for a few seconds - the card has no transcript
  // notice row of its own.
  const [cmdToast, setCmdToast] = useState<string | null>(null);
  const cmdToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showCmdToast = useCallback((text: string) => {
    if (cmdToastTimer.current) clearTimeout(cmdToastTimer.current);
    setCmdToast(text);
    cmdToastTimer.current = setTimeout(() => setCmdToast(null), 4_000);
  }, []);
  useEffect(() => () => {
    if (cmdToastTimer.current) clearTimeout(cmdToastTimer.current);
  }, []);

  const sendingRef = useRef(false);

  const send = useCallback(() => {
    if (sendingRef.current) return;
    const trimmed = textRef.current.trim();
    const files = pastedRef.current;
    if (!trimmed && files.length === 0) return;
    sendingRef.current = true;
    // SLASH COMMAND INTERCEPT (2026-11-23): `/compact`, `/clean` and the
    // other commands run against THIS session (opts.sessionId), never the
    // foreground project's. Handled -> do not send a chat message;
    // send-prompt -> the command's prompt rides INSTEAD of the draft.
    void (async () => {
      try {
        let outgoing = trimmed;
        if (files.length === 0 && (trimmed.startsWith("/") || trimmed.startsWith("#"))) {
          const outcome = await tryRunSlashCommand(trimmed, { sessionId });
          if (outcome.kind === "handled") {
            setText("");
            draftRef.current = "";
            setSessionPreferences(sessionId, { draft: undefined });
            if (outcome.toast) showCmdToast(outcome.toast);
            return;
          }
          if (outcome.kind === "send-prompt") {
            outgoing = wrapWithCommandMarker(outcome.prompt, outcome.commandName ?? "");
          }
        }
        // SKILL / COMMAND EXPANSION (2026-11-23): `#handle` tokens expand
        // into <skill> blocks against the CARD's project (not the
        // foreground project). A send-prompt command rides as the body
        // verbatim (it is not a skill token).
        const { body: bodyAfterTokens, blocks: skillBlocks } = expandSkillTokens(
          outgoing,
          skillsForProject(root),
        );
        const sendText = [...skillBlocks, bodyAfterTokens].filter(Boolean).join("\n\n");
        if (files.length === 0) {
          // No attachments: the original pure-text path (steering keeps its
          // exact wire shape).
          if (busy) {
            setSessionSteeringMessage(sessionId, [{ type: "text", text: sendText }]);
          } else {
            void chat.sendMessage({ role: "user", parts: [{ type: "text", text: sendText }] });
            patchSessionAgentMeta(sessionId, {
              hitStepCap: false,
              finishReason: "",
              compactionNotice: null,
              summaryNotice: null,
            });
          }
          setText("");
          draftRef.current = "";
          setSessionPreferences(sessionId, { draft: undefined });
          return;
        }
        // With attachments: compose skill/path/text blocks first, then inline
        // image file parts - the same wire shape the main composer produces.
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
        const composed = [...skillBlocks, ...pathBlocks, ...textBlocks, bodyAfterTokens]
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
        setText("");
        draftRef.current = "";
        setPasted([]);
        setSessionPreferences(sessionId, { draft: undefined });
      } finally {
        sendingRef.current = false;
      }
    })();
  }, [busy, chat, sessionId, root, showCmdToast]);

  const stop = useCallback(() => {
    stopSession(sessionId);
  }, [sessionId]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (pickerOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, Math.max(0, filteredItems.length - 1)));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && filteredItems.length > 0)) {
          const safeIdx = Math.min(activeIndex, Math.max(0, filteredItems.length - 1));
          const it = filteredItems[safeIdx];
          if (it) {
            e.preventDefault();
            onPickItem(it);
            return;
          }
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setTrigger(null);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send, pickerOpen, filteredItems, activeIndex, onPickItem],
  );

  return (
    <>
      <CardPastePills files={pasted} onRemove={removePasted} />
      {cmdToast ? (
        <div className="shrink-0 px-3 pb-1 pt-0.5 text-[10.5px] text-muted-foreground">
          <span className="truncate">{cmdToast}</span>
        </div>
      ) : null}
      <div className="relative flex shrink-0 items-center gap-1.5 border-t border-border/40 bg-card/40 px-3 py-1.5">
        {pickerOpen && filteredItems.length > 0 ? (
          <div
            role="listbox"
            aria-label="Skills and commands"
            className="absolute bottom-full left-2 z-50 mb-1 w-64 overflow-hidden rounded-lg border border-border/70 bg-popover p-1 shadow-lg"
          >
            <div className="max-h-56 overflow-y-auto">
              {filteredItems.map((it, i) => (
                <button
                  key={it.kind === "command" ? `cmd-${it.command.name}` : `sn-${it.snippet.name}`}
                  type="button"
                  role="option"
                  aria-selected={i === activeIndex}
                  onMouseDown={(e) => {
                    // Prevent the textarea blur before the click lands.
                    e.preventDefault();
                    onPickItem(it);
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={cn(
                    "flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left text-[12px]",
                    i === activeIndex ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  {it.kind === "command" ? (
                    <span className="flex items-center gap-1.5">
                      <span className="font-mono text-muted-foreground">/{it.command.name}</span>
                      <span className="font-medium">{it.command.label}</span>
                    </span>
                  ) : (
                    <>
                      <span className="flex w-full items-center gap-1.5">
                        <span className="font-mono text-muted-foreground">#{it.snippet.handle}</span>
                        <span className="font-medium">{it.snippet.name}</span>
                      </span>
                      {it.snippet.description ? (
                        <span className="line-clamp-1 text-[10.5px] text-muted-foreground">
                          {it.snippet.description}
                        </span>
                      ) : null}
                    </>
                  )}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          requestAnimationFrame(updateTrigger);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={updateTrigger}
        onClick={updateTrigger}
        onPaste={onPaste}
        rows={1}
        placeholder={
          micTranscribing
            ? "Transcribing…"
            : busy
              ? "Steer the running agent."
              : "Send a message"
        }
        className="max-h-[79px] min-h-[20px] flex-1 resize-none bg-transparent text-[11px] leading-snug text-foreground outline-none placeholder:text-muted-foreground/50"
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
      {/* FILE UPLOAD + (2026-11-25 ask): opens the OS picker for THIS
           card's input. Sits RIGHT of the mic, mirroring the main
           composer's attach affordance; picked files land in the same
           attachment strip paste uses. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPTED_FILES}
        className="hidden"
        onChange={onPickFiles}
      />
      <button
        type="button"
        title="Attach file or image"
        onClick={() => fileInputRef.current?.click()}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
      </button>
      </div>
    </>
  );
});
