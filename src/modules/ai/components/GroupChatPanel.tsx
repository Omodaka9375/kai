import { useCallback, useEffect, useMemo, useState } from "react";
import { useSyncExternalStore } from "react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  Cancel01Icon,
  Delete02Icon,
  Folder01Icon,
  Link01Icon,
  SentIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getProjectAgentStatus } from "../store/projectStatus";
import { useChatStore } from "../store/chatStore";
import {
  addParticipants,
  createGroupChat,
  deleteGroupChat,
  endGroupChat,
  getGroupStoreVersion,
  getGroups,
  getGroup,
  removeParticipant,
  resumeGroupChat,
  sendGroupMessage,
  subscribeGroupChats,
  type GroupChat,
  type GroupParticipant,
} from "../store/groupChatStore";
import type { ProjectSwitcherItem } from "@/modules/workspace/ProjectRail";
import { CoordinatorMenu } from "./CoordinatorMenu";

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
    async (invitees: ProjectSwitcherItem[]) => {
      const inviter = projects.find((p) => p.id === activeProjectId);
      if (!inviter || invitees.length === 0) return;
      const g = await createGroupChat(
        {
          projectId: inviter.id,
          sessionId: "",
          root: inviter.root,
          name: inviter.name,
        },
        invitees.map((i) => ({ projectId: i.id, root: i.root, name: i.name })),
        `${inviter.name} ↔ ${invitees.map((i) => i.name).join(", ")}`,
      );
      // createGroupChat resolves the inviter's CURRENT active session on
      // flush; the sessionId passed here is a placeholder replaced in-store.
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
            className={cn(
              // Twin of the AI mini window's DOCKED box: same width, same
              // height formula, same bottom anchor, same card styling.
              "fixed z-40 flex w-[min(34rem,calc(100vw-2rem))] flex-col overflow-hidden",
              "rounded-2xl border border-border/60 bg-card text-[12px] shadow-lg",
              "right-2 bottom-[calc(var(--kai-input-bar-h,0px)+84px)] h-[min(42rem,calc(100vh-var(--kai-input-bar-h,0px)-92px))]",
            )}
          >
            <PanelHeader
              group={active}
              candidates={projects}
              onEnd={() => void endGroupChat(active.id)}
              // ✕ hands the slot back to the AI mini window.
              onClose={() => {
                setOpenGroupId(null);
                closeGroupFromStack();
              }}
            />
            <Transcript group={active} />
            <Composer group={active} />
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
        />
      ) : null}
    </>
  );
}

function PanelHeader({
  group,
  candidates,
  onEnd,
  onClose,
}: {
  group: GroupChat;
  candidates: ProjectSwitcherItem[];
  onEnd: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
      <div className="flex min-w-0 items-center gap-1.5">
        <HugeiconsIcon icon={Link01Icon} size={13} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{group.name}</span>
        {group.endedAt !== null ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">ended</span>
        ) : (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            · {group.participants.length} projects
            {group.coordinator.kind === "agent" && (
              <span className="rounded bg-primary/15 px-1 py-0.5 text-[9.5px] text-primary">
                {group.participants.find((p) => group.coordinator.kind === "agent" && p.projectId === group.coordinator.projectId)?.name ?? ""} coordinates
              </span>
            )}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {group.endedAt !== null ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={() => void resumeGroupChat(group.id)}
          >
            Resume
          </Button>
        ) : (
          <>
            <ParticipantsMenu group={group} candidates={candidates} />
            <CoordinatorMenu group={group} />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
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
          aria-label="Close group panel"
          onClick={onClose}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={1.75} />
        </Button>
      </div>
    </div>
  );
}

function ParticipantDot({ participant }: { participant: GroupParticipant }) {
  const status = getProjectAgentStatus(participant.projectId);
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

function Transcript({ group }: { group: GroupChat }) {
  const version = useSyncExternalStore(subscribeGroupChats, getGroupStoreVersion, getGroupStoreVersion);
  // Re-read the group each version bump — messages arrays are replaced.
  const live = useMemo(() => getGroup(group.id) ?? group, [group.id, version]);
  const nameFor = useCallback(
    (projectId: string) =>
      live.participants.find((p) => p.projectId === projectId)?.name ?? projectId,
    [live],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2.5">
      {live.messages.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
          Send a message to start coordinating — each project's agent receives
          it in its own session.
        </div>
      ) : (
        live.messages.map((m) =>
          m.from === "system" ? (
            <div key={m.id} className="px-1 text-center text-[10px] italic text-muted-foreground/70">
              {m.text}
            </div>
          ) : (
          <div key={m.id} className="flex flex-col gap-0.5">
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
            <div
              className={cn(
                "whitespace-pre-wrap rounded-lg border px-2.5 py-1.5",
                m.from === "user"
                  ? "border-border/60 bg-muted/40"
                  : "border-border/60 bg-background",
              )}
            >
              {m.text}
            </div>
          </div>
          )
        )
      )}
    </div>
  );
}

function Composer({ group }: { group: GroupChat }) {
  const [text, setText] = useState("");
  const [target, setTarget] = useState<string | "all">("all");
  const [sent, setSent] = useState(false);
  const send = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || group.endedAt !== null) return;
    await sendGroupMessage(group.id, trimmed, target === "all" ? undefined : target);
    setText("");
    setSent(true);
    window.setTimeout(() => setSent(false), 1200);
  }, [text, group, target]);

  if (group.endedAt !== null) {
    return (
      <div className="shrink-0 border-t border-border/60 px-3 py-2 text-center text-[11px] text-muted-foreground">
        Group ended — participants continue independently. Resume to re-open.
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-t border-border/60 px-3 py-2">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-7 min-w-0 max-w-32 items-center gap-1 rounded-md border border-border/60 px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Send to…"
          >
            <span className="truncate">
              {target === "all" ? "All" : group.participants.find((p) => p.projectId === target)?.name ?? target}
            </span>
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
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder="Coordinate your project agents…"
        className="h-7 flex-1 text-[11.5px]"
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7"
        aria-label="Send to group"
        onClick={() => void send()}
      >
        <HugeiconsIcon icon={sent ? SentIcon : SentIcon} size={13} strokeWidth={1.75} />
      </Button>
    </div>
  );
}

function GroupListTray({
  groups,
  activeId,
  onOpen,
}: {
  groups: GroupChat[];
  activeId: string | null;
  onOpen: (id: string) => void;
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
    <button
      type="button"
      onClick={() => onOpen(g.id)}
      title={g.endedAt !== null ? "Resume group chat" : "Open group chat"}
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
      <HugeiconsIcon icon={Link01Icon} size={12} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
      <span className="truncate">{g.name}</span>
    </button>
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
  onCreate: (invitees: ProjectSwitcherItem[]) => void | Promise<void>;
  onOpenGroup: (groupId: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Re-read on every open (the dialog lives outside the version-notify tree).
  const existing = open ? getGroups() : [];
  const candidates = projects.filter((p) => p.id !== activeProjectId);
  const invitees = candidates.filter((p) => picked.includes(p.id));
  const inviterName = projects.find((p) => p.id === activeProjectId)?.name ?? "This project";

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setPicked([]);
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
                      onClick={() => onOpenGroup(g.id)}
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

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={invitees.length === 0}
            onClick={() => void onCreate(invitees)}
          >
            Create group{invitees.length > 0 ? ` (${invitees.length})` : ""}
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
}: {
  group: GroupChat;
  candidates: ProjectSwitcherItem[];
}) {
  const [open, setOpen] = useState(false);
  const live = getGroup(group.id) ?? group;
  const memberIds = new Set(live.participants.map((p) => p.projectId));
  const invitable = candidates.filter((c) => !memberIds.has(c.id));
  void group;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
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

