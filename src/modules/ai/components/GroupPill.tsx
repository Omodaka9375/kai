import { useMemo } from "react";
import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { AiBrain02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  getGroupStoreVersion,
  getGroups,
  getPersonaApprovals,
  subscribeGroupChats,
} from "../store/groupChatStore";
import { useChatStore, getSessionAgentMeta } from "../store/chatStore";

/**
 * The AI surface's collapsed pill. When a group chat owns the expanded slot
 * (`stackRail.surface === "group"`), the AI mini window is NOT mounted and
 * this pill sits at the bottom of the right-gutter stack instead — same
 * width as the mini window, mirroring the group pill's look. Clicking it
 * swaps back: the group collapses to its pill, the AI window returns.
 */
export function GroupPill() {
  const version = useSyncExternalStore(
    subscribeGroupChats,
    getGroupStoreVersion,
    getGroupStoreVersion,
  );
  const openMiniToStack = useChatStore((s) => s.openMiniToStack);
  const groupPanelExpanded = useChatStore((s) => s.groupPanelExpanded);
  // Count is cosmetic — shows how many groups are live while the group
  // panel is the expanded surface.
  const groups = useMemo(() => getGroups(), [version]);
  const liveCount = groups.filter((g) => g.endedAt === null).length;
  // Pending approvals across ALL live groups — personas (registry) PLUS
  // background participant sessions awaiting approval cards (2026-11-02
  // audit NIT: the badge counted only persona cards, so a background
  // participant's approval was invisible behind the collapsed pill — its
  // tooltip under-promised "waiting in group chats"). The pill is the group
  // system's attention surface when the panel is collapsed behind the AI
  // window. Same violet as the rail's "needs your input" dot: one meaning,
  // one color.
  const pendingApprovals = useMemo(() => {
    const personas = getPersonaApprovals().length;
    // Background participant sessions: any live group participant whose
    // session meta reports awaiting-approval. Personas are already counted
    // via the registry; skip their synthetic ids here.
    const sessions = groups
      .filter((g) => g.endedAt === null)
      .flatMap((g) => g.participants)
      .filter(
        (p) =>
          !p.projectId.startsWith("persona:") &&
          p.sessionId &&
          getSessionAgentMeta(p.sessionId).status === "awaiting-approval",
      ).length;
    return personas + sessions;
  }, [version, groups]);

  // Full view: the group panel overlays the workspace down to the +42px
  // strip — the pill's own strip. Hide instead of painting over/below it.
  if (groupPanelExpanded) return null;

  // AI-PILL-MODE BADGE (2026-11-06): when this pill stands in for a
  // MINIMIZED AI window (no group involved), the group badges below are
  // noise - but the ACTIVE session's state is the signal that matters.
  // Show a busy/streaming dot so a minimized agent's activity stays
  // visible at a glance; approvals stay in the group badge (in this mode
  // there are no group approvals - liveCount is 0).
  const aiMode = !useMemo(() => getGroups().some((g) => g.endedAt === null), [version]);

  return (
    <button
      type="button"
      onClick={openMiniToStack}
      title="Open AI chat"
      aria-label="Open AI chat"
      data-ai-pill
      className={cn(
        // Twin of the group pill: same width (mini-window stack), same
        // height, sits at the bottom edge of the expanded group panel.
        "fixed z-40 flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-card px-2.5",
        "text-[11px] text-muted-foreground shadow-md transition-colors hover:bg-accent hover:text-foreground",
        "right-2 w-[min(34rem,calc(100vw-2rem))] bottom-[calc(var(--kai-input-bar-h,0px)+42px)]",
      )}
    >
      <HugeiconsIcon icon={AiBrain02Icon} size={12} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
      <span className="truncate font-medium">AI chat</span>
      <span className="flex-1" />
      {aiMode ? <AiPillStatusBadge /> : null}
      {liveCount > 0 ? (
        <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
          {liveCount} live
        </span>
      ) : null}
      {pendingApprovals > 0 ? (
        <span
          title={`${pendingApprovals} approval${pendingApprovals === 1 ? "" : "s"} waiting in group chats`}
          className="ml-1 inline-flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-full border border-violet-500/50 bg-violet-500/15 px-1 text-[8.5px] font-semibold tabular-nums text-violet-600 dark:text-violet-400"
        >
          {pendingApprovals}
        </span>
      ) : null}
    </button>
  );
}

/** Busy-state badge for the minimized-AI-window pill: a small pulsing dot
 *  plus tok/s while the agent runs, so a minimized agent is glanceable
 *  exactly like the group pill makes a running group glanceable. */
function AiPillStatusBadge() {
  const status = useChatStore((s) => s.agentMeta.status);
  const outputTps = useChatStore((s) => s.agentMeta.outputTps);
  if (status !== "streaming") return null;
  return (
    <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
      <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
      {status === "streaming" && outputTps > 0 ? (
        <span className="tabular-nums">{outputTps} tok/s</span>
      ) : null}
    </span>
  );
}
