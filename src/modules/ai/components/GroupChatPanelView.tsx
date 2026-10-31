import { useCallback, useEffect, useMemo, useState } from "react";
import { useSyncExternalStore } from "react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  Cancel01Icon,
  Delete02Icon,
  Folder01Icon,
  LeftToRightBlockQuoteIcon,
  Link01Icon,
  MinusSignIcon,
  SentIcon,
  StopIcon,
  Tick02Icon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getProjectAgentStatus } from "../store/projectStatus";
import { useAgentsStore } from "../store/agentsStore";
import { BUILTIN_AGENTS } from "../lib/agents";
import {
  useChatStore,
  subscribeSessionAgentMeta,
  getSessionMetaVersion,
} from "../store/chatStore";
import { AiToolApproval } from "./AiToolApproval";
import {
  respondUnifiedApproval,
  unifiedGroupApprovals,
} from "../lib/groupApprovals";
import {
  addParticipants,
  addPersonaParticipants,
  createGroupChat,
  deleteGroupChat,
  endGroupChat,
  getGroupStoreVersion,
  getGroup,
  getGroups,
  getPersonaApprovals,
  isPersonaParticipantId,
  participantActivity,
  removeParticipant,
  resumeGroupChat,
  setGroupAutoApprove,
  sendGroupMessage,
  stopGroupParticipant,
  stopGroupParticipants,
  subscribeGroupChats,
  type GroupChat,
  type GroupMessage,
  type GroupParticipant,
} from "../store/groupChatStore";
import type { ProjectSwitcherItem } from "@/modules/workspace/ProjectRail";
import { CoordinatorMenu } from "./CoordinatorMenu";
import {
  buildQuoteBlock,
  quoteExcerpt,
  splitQuoteBlock,
} from "../lib/chatText";

/**
 * Cross-project group chat panel — app-level surface (mounted once in
 * AppShell, sibling of AiMiniWindow's slot), NOT bound to any project's
 * session. The user coordinates participant agents from here; participant
 * replies are mirrored in by AgentRunBridge.
 *
 * Phase 1 scope: user-as-coordinator messaging, invite from the rail's
 * project list, queue-while-busy delivery, end/resume. Agent-coordinator
 * delegation tools are Phase 2 (see groupChatStore doc comment).
 */

export function GroupChatPanel({
  projects,
  activeProjectId,
}: {
  /** Rail items — the invite picker needs open projects. */
  projects: ProjectSwitcherItem[];
  activeProjectId: string | null;
}) {
  // Monotonic store version as the snapshot — group deletes/ends/messages
  // MUST re-render this panel, or it shows ghosts of dead groups (the X
  // would seem not to work: the pill/panel would keep pointing at a group
  // that no longer exists until some unrelated re-render).
  const version = useSyncExternalStore(
    subscribeGroupChats,
    getGroupStoreVersion,
    getGroupStoreVersion,
  );
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Right-gutter stack: the group panel and the AI mini window share ONE
  // expanded slot. Whichever surface owns it renders as the window; the
  // other is a pill. `expanded` = the group panel owns the slot.
  const stackSurface = useChatStore((s) => s.stackRail.surface);
  const openGroupToStack = useChatStore((s) => s.openGroupToStack);
  const closeGroupFromStack = useChatStore((s) => s.closeGroupFromStack);
  // Full-view toggle — twin of the AI mini window's expand state.
  const groupExpanded = useChatStore((s) => s.groupPanelExpanded);
  const setGroupExpanded = useChatStore((s) => s.setGroupPanelExpanded);
  // The group pill always sits at the bottom of the right-gutter stack;
  // the expanded surface (whoever owns the slot) renders above it.
  const groups = useMemo(() => getGroups(), [version]);
  const active = useMemo(
    () => (openGroupId ? getGroup(openGroupId) : null),
    [openGroupId, version],
  );
  const expanded = stackSurface === "group" && active !== null;

  // Auto-open the newest group when created; close the panel state when the
  // open group vanishes (deleted, etc.). If it owned the expanded slot, the
  // AI mini window comes back automatically.
  useEffect(() => {
    if (!openGroupId) return;
    if (!getGroup(openGroupId)) {
      setOpenGroupId(null);
      if (useChatStore.getState().stackRail.surface === "group") {
        closeGroupFromStack();
      }
    }
  }, [openGroupId, version, closeGroupFromStack]);

  // Stack invariant: a selected group only makes sense while the group
  // panel owns the expanded slot. When the AI window takes the slot back
  // (openMiniToStack from the AI pill), clear the selection — otherwise the
  // group is unreachable: the tray pill hides on activeId !== null while
  // the panel hides on !expanded.
  useEffect(() => {
    if (stackSurface !== "group" && openGroupId !== null) {
      setOpenGroupId(null);
    }
  }, [stackSurface, openGroupId]);

  // Cross-surface entries via window events (the rail and the status bar
  // live inside project workspaces; the panel is app-level — events keep
  // them decoupled, same pattern as Kai:term-command-end).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id === "string" && getGroup(id)) {
        setOpenGroupId(id);
        openGroupToStack();
      }
    };
    // Status-bar "start group chat" button → open the invite picker here.
    const onNew = () => setPickerOpen(true);
    window.addEventListener("Kai:open-group-chat", onOpen);
    window.addEventListener("Kai:new-group-chat", onNew);
    return () => {
      window.removeEventListener("Kai:open-group-chat", onOpen);
      window.removeEventListener("Kai:new-group-chat", onNew);
    };
  }, [openGroupToStack]);

  const onCreate = useCallback(
    async (invitees: ProjectSwitcherItem[], personas: string[]) => {
      const inviter = projects.find((p) => p.id === activeProjectId);
      if (!inviter) return;
      if (invitees.length === 0 && personas.length === 0) return;
      // Persona invitees ride the SAME createGroupChat invitees array — the
      // store recognizes the synthetic "persona:<id>" projectId and skips
      // session resolution for them (see createGroupChat's map).
      const personaItems = personas.map((id) => {
        const all = [...useAgentsStore.getState().customAgents, ...BUILTIN_AGENTS];
        const found = all.find((a) => a.id === id);
        return { projectId: `persona:${id}`, root: "", name: found?.name ?? id };
      });
      const g = await createGroupChat(
        {
          projectId: inviter.id,
          sessionId: "",
          root: inviter.root,
          name: inviter.name,
        },
        [
          ...invitees.map((i) => ({ projectId: i.id, root: i.root, name: i.name })),
          ...personaItems,
        ],
        `${inviter.name} ↔ ${[...invitees, ...personaItems].map((i) => i.name).join(", ")}`,
      );
      if (g && personas.length > 0) {
        // Re-add via the validated store path (idempotent per persona) so a
        // deleted-during-creation persona can't slip in as a zombie.
        await addPersonaParticipants(g.id, personas);
      }
      setPickerOpen(false);
      // Claim the expanded slot immediately. Without openGroupToStack the
      // new group is INVISIBLE: the tray pill hides itself while a group is
      // selected (activeId !== null) and the panel needs the slot to expand.
      if (g) {
        setOpenGroupId(g.id);
        openGroupToStack();
      }
    },
    [projects, activeProjectId, openGroupToStack],
  );

  // No groups and no picker open — nothing to render. Starting a group lives
  // in the status bar (next to the AI panel toggle). The pill is the group's
  // floating entry point now.
  if (groups.length === 0 && !pickerOpen) return null;

  return (
    <>
      <InvitePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        projects={projects}
        activeProjectId={activeProjectId}
        onCreate={onCreate}
        onOpenGroup={(id) => {
          setPickerOpen(false);
          setOpenGroupId(id);
          openGroupToStack();
        }}
      />
      <AnimatePresence>
        {expanded ? (
          <motion.div
            key={active.id}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16 }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
            data-group-chat-panel
            data-group-id={active.id}
            className={cn(
              "fixed z-40 flex flex-col overflow-hidden",
              "rounded-2xl border border-border/60 bg-card text-[12px] shadow-lg",
              "ring-1 ring-black/5 dark:ring-white/5",
              // Twin of the AI mini window in BOTH states: expanded mirrors
              // the mini window's full-workspace overlay (and owns the
              // +42px strip — the AI pill hides); docked keeps the same
              // width, height formula, and the +84px anchor (AI pill below).
              groupExpanded
                ? "top-[2.85rem] right-2 bottom-[calc(var(--kai-input-bar-h,0px)+42px)] left-[calc(var(--kai-workspace-left,0px)+8px)] rounded-xl"
                : "right-2 w-[min(34rem,calc(100vw-2rem))] bottom-[calc(var(--kai-input-bar-h,0px)+84px)] h-[min(42rem,calc(100vh-var(--kai-input-bar-h,0px)-92px))]",
            )}
          >
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-foreground/[0.03] to-transparent"
            />
            <PanelHeader
              group={active}
              candidates={projects}
              onEnd={() => void endGroupChat(active.id)}
              onStopAll={() => void stopGroupParticipants(active.id)}
              expanded={groupExpanded}
              onToggleExpand={() => setGroupExpanded(!groupExpanded)}
              // Minimize hands the slot back to the AI mini window; the
              // group keeps running and its pill re-opens it.
              onClose={() => {
                setOpenGroupId(null);
                closeGroupFromStack();
              }}
            />
            <Transcript group={active} expanded={groupExpanded} />
            <GroupApprovals group={active} />
            <ActivityStrip group={active} />
            <Composer group={active} expanded={groupExpanded} />
          </motion.div>
        ) : null}
      </AnimatePresence>
      {groups.length > 0 && stackSurface !== "group" ? (
        <GroupListTray
          groups={groups}
          activeId={active?.id ?? null}
          onOpen={(id) => {
            setOpenGroupId(id);
            openGroupToStack();
          }}
          onEnd={(id) => {
            // End (soft-stop participants) THEN delete (transcript gone,
            // pill falls to the next group or disappears entirely).
            return endGroupChat(id).then(() => deleteGroupChat(id));
          }}
        />
      ) : null}
    </>
  );
}

function PanelHeader({
  group,
  candidates,
  onEnd,
  onStopAll,
  expanded,
  onToggleExpand,
  onClose,
}: {
  group: GroupChat;
  candidates: ProjectSwitcherItem[];
  onEnd: () => void;
  onStopAll: () => void;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border/60 px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/70 text-muted-foreground">
          <HugeiconsIcon icon={Link01Icon} size={13} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 truncate text-[12px] font-medium" title={group.name}>
          {group.name}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <span className="flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border/60 px-2.5 text-[10.5px] font-medium text-muted-foreground">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              group.endedAt !== null ? "bg-muted-foreground/40" : "bg-emerald-500",
            )}
          />
          {group.endedAt !== null
            ? "Ended"
            : `${group.participants.length} participant${group.participants.length === 1 ? "" : "s"}`}
        </span>
        {group.coordinator.kind === "agent" && group.endedAt === null ? (
          <span
            className="mr-1 shrink-0 rounded-md bg-primary/10 px-1.5 py-1 text-[10px] font-medium text-primary"
            title={`${group.participants.find((p) => group.coordinator.kind === "agent" && p.projectId === group.coordinator.projectId)?.name ?? "Participant"} coordinates this group`}
          >
            Delegated
          </span>
        ) : null}
        {group.endedAt !== null ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 rounded-full border border-border/60 px-2.5 text-[11px]"
            onClick={() => void resumeGroupChat(group.id)}
          >
            Resume
          </Button>
        ) : (
          <>
            <GroupAutoApproveToggle group={group} />
            <ParticipantsMenu
              group={group}
              candidates={candidates}
              onStopOne={(pid) => void stopGroupParticipant(group.id, pid)}
            />
            <CoordinatorMenu group={group} />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 shrink-0 gap-1 rounded-full border border-border/60 px-2.5 text-[11px]"
              title="Stop every busy participant agent now"
              onClick={onStopAll}
            >
              <HugeiconsIcon icon={StopIcon} size={11} strokeWidth={1.75} />
              Stop
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 shrink-0 rounded-full border border-border/60 px-2.5 text-[11px]"
              title="End group chat - every agent keeps running as before"
              onClick={onEnd}
            >
              End
            </Button>
          </>
        )}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-5"
          aria-label={expanded ? "Collapse to mini window" : "Expand to panel"}
          title={expanded ? "Collapse to mini window" : "Expand to panel"}
          onClick={onToggleExpand}
        >
          <HugeiconsIcon icon={expanded ? ArrowShrink01Icon : ArrowExpand01Icon} size={11} strokeWidth={1.75} />
        </Button>
        {/* Minimize ( _ ), NOT close: hands the expanded slot back to the
            AI mini window but the group keeps running — the tray pill at
            the bottom of the gutter re-opens it. Ending the group lives on
            the collapsed pill's ✕ (and the End button above). */}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-5"
          aria-label="Minimize group chat"
          title="Minimize — the group keeps running in its pill"
          onClick={onClose}
        >
          <HugeiconsIcon icon={MinusSignIcon} size={11} strokeWidth={1.75} />
        </Button>
      </div>
    </div>
  );
}

/** Group auto-allow toggle — twin of the AI input bar's AutoApproveToggle
 *  (same Ask/Allow labels, same emerald dot) but scoped to THIS group's
 *  PERSONA approvals. Project participants are deliberately untouched:
 *  their own sessions' bridges decide with their per-chat setting. */
function GroupAutoApproveToggle({ group }: { group: GroupChat }) {
  const on = group.autoApprove === true;
  return (
    <button
      type="button"
      onClick={() => void setGroupAutoApprove(group.id, !on)}
      title={
        on
          ? "Auto-allow for this group: persona tool calls run without asking. Elevated commands, screen capture, and signed commits still ask. Project participants keep their own chat's setting."
          : "Ask before every persona tool call — click to auto-allow for this group"
      }
      className="flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border/60 px-2.5 text-[10.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          on ? "bg-emerald-500" : "bg-muted-foreground/50",
        )}
      />
      {on ? "Allow" : "Ask"}
    </button>
  );
}

function ParticipantDot({ participant }: { participant: GroupParticipant }) {
  const status = isPersonaParticipantId(participant.projectId)
    ? participantActivity(participant.sessionId) === "working"
      ? "streaming"
      : "idle"
    : getProjectAgentStatus(participant.projectId);
  return (
    <span
      title={`${participant.name}: ${status}`}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status === "streaming" || status === "thinking" ? "bg-emerald-500 animate-pulse" :
        status === "awaiting-approval" ? "bg-amber-500" :
        status === "error" ? "bg-destructive" : "bg-muted-foreground/40",
      )}
    />
  );
}

function Transcript({
  group,
  expanded,
}: {
  group: GroupChat;
  expanded: boolean;
}) {
  const version = useSyncExternalStore(subscribeGroupChats, getGroupStoreVersion, getGroupStoreVersion);
  // Re-read the group each version bump — messages arrays are replaced.
  const live = useMemo(() => getGroup(group.id) ?? group, [group.id, version]);
  const nameFor = useCallback(
    (projectId: string) =>
      live.participants.find((p) => p.projectId === projectId)?.name ?? projectId,
    [live],
  );
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4",
        // Full view: keep transcript lines readable — centered column.
        expanded && "mx-auto w-full max-w-3xl",
      )}
    >
      {live.messages.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <span className="mb-3 flex size-10 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground/70">
            <HugeiconsIcon icon={Link01Icon} size={20} strokeWidth={1.5} />
          </span>
          <span className="text-[12px] font-medium text-foreground/80">
            Coordinate your projects together
          </span>
          <span className="mt-1 max-w-64 text-[11px] leading-relaxed text-muted-foreground">
            Send a message and each project's agent receives it in its own
            session.
          </span>
        </div>
      ) : (
        live.messages.map((m) =>
          m.from === "system" ? (
            <div key={m.id} className="px-1 text-center text-[10px] italic text-muted-foreground/70">
              {m.text}
            </div>
          ) : (
          <div
            key={m.id}
            className="flex flex-col gap-0.5"
            data-msg-author={m.from === "user" ? "You" : nameFor(m.projectId)}
          >
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="font-medium text-foreground">
                {m.from === "user" ? "You" : nameFor(m.projectId)}
              </span>
              <span>
                {m.from === "user"
                  ? m.projectId === "all"
                    ? "→ all"
                    : `→ ${nameFor(m.projectId)}`
                  : "replied"}
              </span>
            </div>
            <GroupMessageBody text={m.text} from={m.from} />
          </div>
          )
        )
      )}
    </div>
  );
}

/**
 * UNIFIED approval section: the SAME rich card the regular AI chat renders
 * (AiToolApproval), fed from every group participant source:
 *   - personas (headless runs paused in groupChatStore) and
 *   - background project sessions (approval parts in their live chats,
 *     decided via respondToApprovalStandalone - the audited, latched
 *     standalone responder built for background-project approvals).
 * The foreground session's approvals stay inline in the AI chat (suppressed
 * here - double cards would double-answer). Queue chips render for
 * multi-approval steps exactly like the regular chat. Proxy cards carry a
 * "requested by <name>" subtitle and no edit affordance (edited-shell
 * approve injects into the FOREGROUND terminal - wrong project for a proxy).
 * Version-driven off BOTH the group store (persona registry) and the
 * session-meta store (background approvals land in chat history).
 */
function GroupApprovals({ group }: { group: GroupChat }) {
  const version = useSyncExternalStore(subscribeGroupChats, getGroupStoreVersion, getGroupStoreVersion);
  const metaVersion = useSyncExternalStore(subscribeSessionAgentMeta, getSessionMetaVersion, getSessionMetaVersion);
  const foregroundSessionId = useChatStore((s) => s.activeSessionId);
  const pending = useMemo(
    () =>
      unifiedGroupApprovals({
        personaApprovals: getPersonaApprovals(),
        participants: group.participants.map((p) => ({ name: p.name, sessionId: p.sessionId })),
        foregroundSessionId,
      }).filter((a) => a.groupId === null || a.groupId === group.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [group, foregroundSessionId, version, metaVersion],
  );
  if (pending.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t border-border/60 px-3 py-2">
      {pending.map((a, i) => (
        <AiToolApproval
          key={a.id}
          part={{
            type: `tool-${a.toolName}`,
            toolCallId: a.id,
            state: "approval-requested",
            input: a.input ?? {},
            approval: { id: a.id },
          }}
          toolName={a.toolName}
          onRespond={(approved) => respondUnifiedApproval(a, approved)}
          queue={pending.length > 1 ? { queued: false, position: i + 1, total: pending.length } : null}
          proxy={{
            requester: a.requester,
            context: a.source === "group-persona" ? "persona \u00B7 no project" : undefined,
          }}
        />
      ))}
    </div>
  );
}

/** One group message bubble: renders a leading <quote author="..."> block as
 *  a reply-quote preview (accent bar + author + excerpt) when present - the
 *  same wire shape the regular composer emits. */
function GroupMessageBody({ text, from }: { text: string; from: GroupMessage["from"] }) {
  const parsed = splitQuoteBlock(text);
  if (!parsed) {
    return (
      <div
        className={cn(
          "whitespace-pre-wrap rounded-lg border px-2.5 py-1.5",
          from === "user"
            ? "border-border/60 bg-muted/40"
            : "border-border/60 bg-background",
        )}
      >
        {text}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "rounded-lg border px-2.5 py-1.5",
        from === "user"
          ? "border-border/60 bg-muted/40"
          : "border-border/60 bg-background",
      )}
    >
      <div className="mb-1.5 flex items-start gap-1.5 rounded-md border-l-2 border-primary/60 bg-background/80 px-2 py-1">
        <HugeiconsIcon
          icon={LeftToRightBlockQuoteIcon}
          size={10}
          strokeWidth={1.75}
          className="mt-0.5 shrink-0 text-primary/70"
        />
        <div className="min-w-0 flex-1">
          <span className="text-[10px] font-semibold text-primary/90">
            {parsed.author}
          </span>
          <span className="ml-1.5 text-[10px] text-muted-foreground line-clamp-2">
            {quoteExcerpt(parsed.quoteText)}
          </span>
        </div>
      </div>
      {parsed.rest ? (
        <span className="whitespace-pre-wrap">{parsed.rest}</span>
      ) : null}
    </div>
  );
}

/**
 * Live per-participant presence, rendered between transcript and composer:
 * who is working (typing dots), who is waiting on an approval, whose
 * message queued behind a busy run, and who stopped on an error. Driven by
 * chatStore's session-meta version (fires on every status transition) plus
 * the group-store version (queue changes also notify).
 */
function ActivityStrip({ group }: { group: GroupChat }) {
  // Real version snapshot: the old constant (() => 0) NEVER notified React,
  // so the strip only refreshed by accident of parent re-renders. The group
  // store version joins it: persona busy/queue changes bump THAT signal.
  useSyncExternalStore(
    subscribeSessionAgentMeta,
    getSessionMetaVersion,
    getSessionMetaVersion,
  );
  useSyncExternalStore(
    subscribeGroupChats,
    getGroupStoreVersion,
    getGroupStoreVersion,
  );
  if (group.endedAt !== null) return null;
  const live = group.participants
    .map((p) => ({ p, act: participantActivity(p.sessionId) }))
    .filter((x) => x.act !== "idle");
  if (live.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/40 px-4 py-1.5 text-[10.5px] text-muted-foreground">
      {live.map(({ p, act }) => (
        <span key={p.projectId} className="flex min-w-0 items-center gap-1.5">
          {act === "working" ? (
            <>
              <TypingDots />
              <span className="truncate font-medium text-foreground/80">{p.name}</span>
              <span>is working…</span>
            </>
          ) : act === "approval" ? (
            <>
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
              <span className="truncate font-medium text-foreground/80">{p.name}</span>
              <span>needs your approval</span>
            </>
          ) : act === "queued" ? (
            <>
              <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
              <span className="truncate font-medium text-foreground/80">{p.name}</span>
              <span>queued (busy)</span>
            </>
          ) : (
            <>
              <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
              <span className="truncate font-medium text-foreground/80">{p.name}</span>
              <span>stopped on error</span>
            </>
          )}
        </span>
      ))}
    </div>
  );
}

/** Three bouncing dots — the chat-app "typing" affordance. */
function TypingDots() {
  return (
    <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-1 rounded-full bg-foreground/60"
          animate={{ y: [0, -2, 0], opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }}
        />
      ))}
    </span>
  );
}

function Composer({
  group,
  expanded,
}: {
  group: GroupChat;
  expanded: boolean;
}) {
  const [text, setText] = useState("");
  const [target, setTarget] = useState<string | "all">("all");
  const [sending, setSending] = useState(false);
  // Reply-quote from the group transcript (right-click → Quote). The quote
  // rides the sent text as a <quote author="..."> block so every participant
  // agent sees WHO is being quoted from the earlier conversation.
  const [pendingQuote, setPendingQuote] = useState<{ author: string; text: string } | null>(null);
  // The group panel is app-level; quote dispatches arrive via the same
  // window-event seam the panel's other cross-surface entries use. Scope by
  // groupId so quoting in one group doesn't seed another group's composer.
  useEffect(() => {
    const onQuote = (e: Event) => {
      const detail = (e as CustomEvent<{ groupId: string; author: string; text: string }>).detail;
      if (detail?.groupId !== group.id || !detail.text) return;
      setPendingQuote({ author: detail.author, text: detail.text });
    };
    window.addEventListener("Kai:group-quote", onQuote);
    return () => window.removeEventListener("Kai:group-quote", onQuote);
  }, [group.id]);
  const send = useCallback(async () => {
    const trimmed = text.trim();
    if ((!trimmed && !pendingQuote) || group.endedAt !== null || sending) return;
    setSending(true);
    try {
      const quoteBlock = pendingQuote
        ? buildQuoteBlock(pendingQuote.author, pendingQuote.text)
        : null;
      const composed = [quoteBlock, trimmed].filter(Boolean).join("\n\n");
      await sendGroupMessage(group.id, composed, target === "all" ? undefined : target);
      setText("");
      setPendingQuote(null);
    } finally {
      setSending(false);
    }
  }, [text, group, target, sending, pendingQuote]);

  if (group.endedAt !== null) {
    return (
      <div className="shrink-0 border-t border-border/60 px-3 py-2 text-center text-[11px] text-muted-foreground">
        Group ended — participants continue independently. Resume to re-open.
      </div>
    );
  }
  return (
    <div
      className={cn(
        // Same footprint as the AI input bar (AiInputBar): borderless strip,
        // no boxed input — the textarea is a transparent flex-1 element
        // flanked by the target picker and send button, so it fills the
        // panel edge-to-edge instead of a small centered box.
        "flex shrink-0 flex-col gap-1.5 border-t border-border/60 bg-card/40 px-3 py-2",
        expanded && "mx-auto w-full max-w-3xl",
      )}
    >
      {pendingQuote && (
        <div className="flex items-center gap-1.5 rounded-lg border-l-2 border-primary/70 bg-muted/50 px-2 py-1">
          <HugeiconsIcon
            icon={LeftToRightBlockQuoteIcon}
            size={12}
            strokeWidth={1.75}
            className="shrink-0 text-primary/80"
          />
          <div className="min-w-0 flex-1">
            <span className="text-[10px] font-semibold text-primary/90">
              {pendingQuote.author}
            </span>
            <span className="ml-1.5 text-[10.5px] text-muted-foreground line-clamp-1">
              {quoteExcerpt(pendingQuote.text)}
            </span>
          </div>
          <button
            type="button"
            aria-label="Remove quote"
            title="Remove quote"
            onClick={() => setPendingQuote(null)}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
          </button>
        </div>
      )}
      <div className="flex items-center gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            title="Send to…"
          >
            <span className="max-w-24 truncate">
              {target === "all" ? "All" : group.participants.find((p) => p.projectId === target)?.name ?? target}
            </span>
            <HugeiconsIcon icon={ArrowDown01Icon} size={9} strokeWidth={2} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-44 gap-0 p-1 text-xs">
          {group.participants.map((p) => (
            <button
              key={p.projectId}
              type="button"
              onClick={() => setTarget(p.projectId)}
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-accent"
            >
              <span className="truncate">{p.name}</span>
              <ParticipantDot participant={p} />
            </button>
          ))}
        </PopoverContent>
      </Popover>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder="Coordinate your project agents…"
        rows={1}
        wrap="soft"
        className={cn(
          // AiInputBar's textarea contract: transparent, borderless,
          // flex-1 — reads as one continuous strip with the picker and
          // send button, not a boxed input. Grows with content up to a
          // practical cap (the panel stays usable with a long draft).
          "min-h-8 flex-1 resize-none rounded-lg bg-transparent px-1 text-[12.5px] leading-relaxed outline-none",
          "overflow-x-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
          "placeholder:text-muted-foreground/60 focus-visible:ring-1 focus-visible:ring-ring/50",
          "max-h-24 overflow-y-auto",
        )}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-8 shrink-0 rounded-lg"
        aria-label="Send to group"
        disabled={!text.trim() || sending}
        onClick={() => void send()}
      >
          <HugeiconsIcon icon={SentIcon} size={15} strokeWidth={1.75} />
      </Button>
      </div>
    </div>
  );
}

function GroupListTray({
  groups,
  activeId,
  onOpen,
  onEnd,
}: {
  groups: GroupChat[];
  activeId: string | null;
  onOpen: (id: string) => void;
  /** END + DELETE the named group (the pill's ✕): the group is torn down,
   *  its transcript removed, and the pill falls back to the next group or
   *  disappears. Lives HERE because the tray is the group's collapsed
   *  surface — minimizing the panel never deletes anything. */
  onEnd: (id: string) => void | Promise<void>;
}) {
  // ONE pill for the whole gutter: it names the most recent live group (or
  // the most recent one of any kind) and expands whichever group it names.
  // While a group is expanded it is the panel, not the pill - so with a
  // group owning the slot the pill is hidden entirely (App renders the AI
  // pill instead).
  if (activeId !== null) return null;
  const g = groups.find((x) => x.endedAt === null) ?? groups[0];
  if (!g) return null;
  return (
    <div
      data-group-pill
      className={cn(
        // Twin of the AI pill: same width as the mini window stack, sits at
        // the bottom of the right gutter below the AI window/pill.
        "fixed z-40 flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-card px-2.5",
        "text-[11px] text-muted-foreground shadow-md transition-colors hover:bg-accent hover:text-foreground",
        "right-2 w-[min(34rem,calc(100vw-2rem))] bottom-[calc(var(--kai-input-bar-h,0px)+42px)]",
        g.endedAt !== null && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(g.id)}
        title={g.endedAt !== null ? "Resume group chat" : "Open group chat"}
        className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left"
      >
        <HugeiconsIcon icon={Link01Icon} size={12} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
        <span className="truncate">{g.name}</span>
      </button>
      {/* Small ✕ on the pill's right edge: ends AND deletes the group —
          the true close the panel's minimize is not. Confirmation-free by
          design (matching the panel's End button), but scoped to THIS
          click: the pill body is a separate button, so opening still
          needs a deliberate click on the name. */}
      <button
        type="button"
        aria-label="End and close group chat"
        title="End & close this group chat"
        onClick={(e) => {
          e.stopPropagation();
          void onEnd(g.id);
        }}
        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-accent hover:text-destructive"
      >
        <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
      </button>
    </div>
  );
}

function InvitePicker({
  open,
  onOpenChange,
  projects,
  activeProjectId,
  onCreate,
  onOpenGroup,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projects: ProjectSwitcherItem[];
  activeProjectId: string | null;
  onCreate: (invitees: ProjectSwitcherItem[], personas: string[]) => void | Promise<void>;
  onOpenGroup: (groupId: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [pickedPersonas, setPickedPersonas] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Re-read on every open (the dialog lives outside the version-notify tree).
  const existing = open ? getGroups() : [];
  const candidates = projects.filter((p) => p.id !== activeProjectId);
  const invitees = candidates.filter((p) => picked.includes(p.id));
  // CRITICAL (React #185 fix): the selector must return a STABLE reference —
  // zustand v5 feeds it to useSyncExternalStore, and a selector that builds
  // a fresh array per call makes the snapshot "change" after every render:
  // React re-renders, re-runs the selector, and after ~50 nested updates
  // throws "Maximum update depth exceeded" (minified React error #185 — the
  // crash users saw on opening the group picker). Select the STORE's stable
  // array, derive the mapped shape in useMemo.
  const customAgents = useAgentsStore((s) => s.customAgents);
  const personas = useMemo(
    () =>
      [...customAgents, ...BUILTIN_AGENTS].map((a) => ({
        id: a.id,
        name: a.name,
      })),
    [customAgents],
  );
  const inviterName = projects.find((p) => p.id === activeProjectId)?.name ?? "This project";

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setPicked([]);
      setPickedPersonas([]);
      setConfirmDelete(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md gap-5 rounded-2xl p-5">
        <DialogHeader className="pr-8">
          <DialogTitle>Start group chat</DialogTitle>
          <DialogDescription>
            Select projects to invite. {inviterName} will coordinate the group.
          </DialogDescription>
        </DialogHeader>

        {existing.length > 0 ? (
          <div className="flex flex-col gap-2">
            <div className="text-[11px] font-medium text-muted-foreground">Your groups</div>
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-xl border border-border/60 bg-background/40 p-1.5">
              {existing.map((g) => {
                const confirming = confirmDelete === g.id;
                return (
                  <div
                    key={g.id}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setPicked([]);
                        setConfirmDelete(null);
                        onOpenGroup(g.id);
                      }}
                      title={g.endedAt !== null ? "Resume and open this group" : "Open this group"}
                      className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-accent"
                    >
                      <HugeiconsIcon icon={Link01Icon} size={12} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-[12px]">{g.name}</span>
                      {g.endedAt !== null ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">ended</span>
                      ) : null}
                    </button>
                    {confirming ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5 text-[10.5px]"
                          onClick={() => setConfirmDelete(null)}
                        >
                          Keep
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          className="h-6 px-1.5 text-[10.5px]"
                          onClick={() => {
                            void deleteGroupChat(g.id);
                            setConfirmDelete(null);
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Delete group ${g.name}`}
                        title="Delete this group (removes its transcript)"
                        onClick={() => setConfirmDelete(g.id)}
                        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                      >
                        <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.75} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <div className="text-[11px] font-medium text-muted-foreground">Available projects</div>
          {/* Persona list: agent personas without a project can join too. */}
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-xl border border-border/60 bg-background/40 p-1.5">
            {candidates.length > 0 ? (
              candidates.map((project) => {
                const selected = picked.includes(project.id);
                return (
                  <button
                    key={project.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() =>
                      setPicked((current) =>
                        current.includes(project.id)
                          ? current.filter((id) => id !== project.id)
                          : [...current, project.id],
                      )
                    }
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                      selected ? "bg-accent text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <HugeiconsIcon icon={Folder01Icon} size={17} strokeWidth={1.75} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                      {project.name}
                    </span>
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded border",
                        selected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background",
                      )}
                    >
                      {selected ? <HugeiconsIcon icon={Tick02Icon} size={11} strokeWidth={2.5} /> : null}
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
                Open another project to start a group chat.
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-[11px] font-medium text-muted-foreground">Agent personas</div>
          <div className="flex max-h-44 flex-col gap-1 overflow-y-auto rounded-xl border border-border/60 bg-background/40 p-1.5">
            {personas.length > 0 ? (
              personas.map((persona) => {
                const selected = pickedPersonas.includes(persona.id);
                return (
                  <button
                    key={persona.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() =>
                      setPickedPersonas((current) =>
                        current.includes(persona.id)
                          ? current.filter((id) => id !== persona.id)
                          : [...current, persona.id],
                      )
                    }
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                      selected ? "bg-accent text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <HugeiconsIcon icon={UserMultiple02Icon} size={16} strokeWidth={1.75} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                      {persona.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/70">no project</span>
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded border",
                        selected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background",
                      )}
                    >
                      {selected ? <HugeiconsIcon icon={Tick02Icon} size={11} strokeWidth={2.5} /> : null}
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-4 text-center text-[12px] text-muted-foreground">
                No personas defined.
              </div>
            )}
          </div>
          <p className="text-[10.5px] leading-relaxed text-muted-foreground/80">
            Personas join without a project — they reply from their own
            persona instructions, using the app's selected model.
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={invitees.length === 0 && pickedPersonas.length === 0}
            onClick={() => {
              const inv = invitees;
              const per = pickedPersonas;
              setPicked([]);
              setPickedPersonas([]);
              setConfirmDelete(null);
              void onCreate(inv, per);
            }}
          >
            Create group{invitees.length + pickedPersonas.length > 0
              ? ` (${invitees.length + pickedPersonas.length})`
              : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Phase 3: participants management — invite more projects into a live
 * group, or remove one. HUMAN-ONLY actions (same trust boundary as group
 * creation); the store enforces membership changes, this is just UI.
 */
function ParticipantsMenu({
  group,
  candidates,
  onStopOne,
}: {
  group: GroupChat;
  candidates: ProjectSwitcherItem[];
  onStopOne: (projectId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const live = getGroup(group.id) ?? group;
  const memberIds = new Set(live.participants.map((p) => p.projectId));
  const invitable = candidates.filter((c) => !memberIds.has(c.id));
  // Existing personas not yet in this group (synthetic ids are members too).
  const memberPersonaIds = new Set(
    live.participants
      .filter((p) => isPersonaParticipantId(p.projectId))
      .map((p) => p.projectId.slice("persona:".length)),
  );
  // CRITICAL (React #185 fix, same as InvitePicker): select the store's
  // stable customAgents array; build the filtered/mapped shape in useMemo.
  // An array-building selector = fresh snapshot every render = max update
  // depth crash (#185) as soon as this menu mounts.
  const customAgents = useAgentsStore((s) => s.customAgents);
  const invitablePersonas = useMemo(
    () =>
      [...customAgents, ...BUILTIN_AGENTS]
        .filter((a) => !memberPersonaIds.has(a.id))
        .map((a) => ({ id: a.id, name: a.name })),
    [customAgents, memberPersonaIds],
  );
  void group;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 shrink-0 rounded-full border border-border/60 px-2.5 text-[11px]"
          title="Group participants"
        >
          Members
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 gap-0 p-1 text-xs">
        <div className="px-2 pb-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Participants
        </div>
        {live.participants.map((p) => (
          <div
            key={p.projectId}
            className="flex w-full items-center justify-between rounded px-2 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            <div className="flex items-center gap-1.5">
              <ParticipantDot participant={p} />
              {participantActivity(p.sessionId) !== "idle" ? (
                <button
                  type="button"
                  aria-label={`Stop ${p.name}'s agent`}
                  title={`Stop ${p.name}'s agent now`}
                  onClick={() => onStopOne(p.projectId)}
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive"
                >
                  <HugeiconsIcon icon={StopIcon} size={10} strokeWidth={1.75} />
                </button>
              ) : null}
              {live.participants.length > 2 ? (
                <button
                  type="button"
                  aria-label={`Remove ${p.name}`}
                  title={`Remove ${p.name} from the group`}
                  onClick={() => void removeParticipant(live.id, p.projectId)}
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={9} strokeWidth={2} />
                </button>
              ) : null}
            </div>
          </div>
        ))}
        {/* Persona invite section: existing personas (custom first, then
            builtins) that are not yet in this group. */}
        {invitablePersonas.length > 0 ? (
          <>
            <div className="mt-1 px-2 pb-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Invite personas
            </div>
            {invitablePersonas.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => void addPersonaParticipants(live.id, [a.id])}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left hover:bg-accent"
              >
                <HugeiconsIcon icon={Add01Icon} size={10} strokeWidth={1.75} />
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <span className="shrink-0 text-[9.5px] text-muted-foreground/70">persona</span>
              </button>
            ))}
          </>
        ) : null}
        {invitable.length > 0 ? (
          <>
            <div className="mt-1 px-2 pb-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Invite projects
            </div>
            {invitable.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() =>
                  void addParticipants(live.id, [
                    { projectId: c.id, root: c.root, name: c.name },
                  ])
                }
                className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left hover:bg-accent"
              >
                <HugeiconsIcon icon={Add01Icon} size={10} strokeWidth={1.75} />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
              </button>
            ))}
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
