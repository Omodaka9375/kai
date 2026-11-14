import { useMemo, useState } from "react";
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
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";
import Link01Icon from "@hugeicons/core-free-icons/Link01Icon";
import StopIcon from "@hugeicons/core-free-icons/StopIcon";
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon";
import UserMultiple02Icon from "@hugeicons/core-free-icons/UserMultiple02Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useAgentsStore } from "../store/agentsStore";
import { BUILTIN_AGENTS } from "../lib/agents";
import {
  addParticipants,
  addPersonaParticipants,
  deleteGroupChat,
  getGroup,
  getGroups,
  isPersonaParticipantId,
  liveGroupForProject,
  participantActivity,
  removeParticipant,
  type GroupChat,
} from "../store/groupChatStore";
import type { ProjectSwitcherItem } from "@/modules/workspace/ProjectRail";
import { ParticipantDot } from "./GroupChatPanelView";

/**
 * Group-chat invitation surfaces, extracted from GroupChatPanelView
 * 2026-11-10 (god-file cleanup): the creation dialog and the members
 * popover are cohesive, store-driven, and only consumed by the panel.
 * Source-pin tests for these two components were repointed to this file
 * (groupChatStore.test.ts, groupChatUx.test.ts, statusbar.test.ts,
 * groupRenderLoop.test.ts customAgents-count pin).
 */

export function InvitePicker({
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
  onCreate: (
    invitees: ProjectSwitcherItem[],
    personas: string[],
  ) => void | Promise<void>;
  onOpenGroup: (groupId: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [pickedPersonas, setPickedPersonas] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Dropdown open states (compact layout): each section's list lives in a
  // Popover; the dialog itself stays three rows tall with no scroll boxes.
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [personasOpen, setPersonasOpen] = useState(false);
  // Re-read on every open (the dialog lives outside the version-notify tree).
  const existing = open ? getGroups() : [];
  const candidates = projects.filter((p) => p.id !== activeProjectId);
  const invitees = candidates.filter((p) => picked.includes(p.id));
  // SINGLE MEMBERSHIP (audit M3, Option A): a project already live in
  // another group cannot join this one. Rows render disabled with the
  // owning group's name — prevention beats a refusal after Create.
  const owners = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of candidates) {
      const g = liveGroupForProject(p.id);
      if (g) m.set(p.id, g.name);
    }
    return m;
  }, [candidates, existing.length]);
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
  // Persona FILTER + COUNT (2026-11-01 report: "the invite dropdown shows
  // only 6 of my 10 personas, plus the built-ins"). The list itself always
  // carried every persona — the popover's scroll VIEWPORT fits ~6 rows and
  // the overlay scrollbar is invisible until hovered, so the fold READ as
  // a hard cap. With a double-digit roster the list needs a filter, a
  // taller viewport, and a count row that states the full roster size so
  // a fold can never masquerade as the whole list again.
  const [personaQuery, setPersonaQuery] = useState("");
  const filteredPersonas = useMemo(
    () =>
      personas.filter((p) =>
        p.name.toLowerCase().includes(personaQuery.trim().toLowerCase()),
      ),
    [personas, personaQuery],
  );
  // COMPACT DROPDOWNS (2026-11-02 ask: "dropdowns unbounded and grow
  // endlessly? need usable, compact and tight"): filters appear only when
  // the list actually warrants one (>6 rows), viewports stay short, and the
  // row count states the full list size — the same treatment the persona
  // roster got for its invisible fold.
  const [projectQuery, setProjectQuery] = useState("");
  const filteredProjects = useMemo(
    () =>
      candidates.filter((p) =>
        p.name.toLowerCase().includes(projectQuery.trim().toLowerCase()),
      ),
    [candidates, projectQuery],
  );
  const showProjectFilter = candidates.length > 6;
  const showPersonaFilter = personas.length > 6;
  const projectList = showProjectFilter ? filteredProjects : candidates;
  const personaList = showPersonaFilter ? filteredPersonas : personas;
  const inviterName =
    projects.find((p) => p.id === activeProjectId)?.name ?? "This project";

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setPicked([]);
      setPickedPersonas([]);
      setConfirmDelete(null);
    }
  };

  // COMPACT LAYOUT (2026-11-01): the dialog used to stack three scrolling
  // list boxes (existing groups max-h-40, projects max-h-72, personas
  // max-h-44) — a wall of vertical scrollbars for what is usually a
  // two-click flow. Now each section is a single dropdown trigger row; the
  // list lives in a Popover overlay, and the selection shows as removable
  // chips beside the trigger. The dialog itself stays three rows tall.
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md gap-4 rounded-2xl p-5">
        <DialogHeader className="pr-8">
          <DialogTitle>Start group chat</DialogTitle>
          <DialogDescription>
            Select projects to invite. {inviterName} will coordinate the group.
          </DialogDescription>
        </DialogHeader>

        {existing.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              Your groups
            </span>
            <Popover
              open={groupsOpen}
              onOpenChange={(v) => {
                setGroupsOpen(v);
                if (!v) setConfirmDelete(null);
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full justify-between text-[12px]"
                >
                  <span className="truncate">Open an existing group…</span>
                  <HugeiconsIcon
                    icon={ArrowDown01Icon}
                    size={12}
                    strokeWidth={1.75}
                    className="shrink-0 text-muted-foreground"
                  />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-80 gap-0 p-1 text-xs"
                onOpenAutoFocus={(e) => e.preventDefault()}
              >
                <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                  {existing.map((g) => {
                    const confirming = confirmDelete === g.id;
                    return (
                      <div
                        key={g.id}
                        className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-accent"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setPicked([]);
                            setPickedPersonas([]);
                            setConfirmDelete(null);
                            setGroupsOpen(false);
                            onOpenGroup(g.id);
                          }}
                          title={
                            g.endedAt !== null
                              ? "Resume and open this group"
                              : "Open this group"
                          }
                          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors"
                        >
                          <HugeiconsIcon
                            icon={Link01Icon}
                            size={12}
                            strokeWidth={1.75}
                            className="shrink-0 text-muted-foreground"
                          />
                          <span className="min-w-0 flex-1 truncate text-[12px]">
                            {g.name}
                          </span>
                          {g.endedAt !== null ? (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              ended
                            </span>
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
                                Promise.resolve(deleteGroupChat(g.id)).catch(
                                  (e: unknown) =>
                                    console.error(
                                      "[Kai-groups] delete group failed:",
                                      e,
                                    ),
                                );
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
                            <HugeiconsIcon
                              icon={Delete02Icon}
                              size={11}
                              strokeWidth={1.75}
                            />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">
            Invite projects
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <Popover open={projectsOpen} onOpenChange={setProjectsOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="justify-between gap-2 text-[12px]"
                >
                  <span className="truncate">Select projects…</span>
                  {invitees.length > 0 ? (
                    <span className="rounded bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
                      {invitees.length}
                    </span>
                  ) : null}
                  <HugeiconsIcon
                    icon={ArrowDown01Icon}
                    size={12}
                    strokeWidth={1.75}
                    className="shrink-0 text-muted-foreground"
                  />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-80 gap-0 p-1 text-xs"
                onOpenAutoFocus={(e) => e.preventDefault()}
              >
                <div className="flex flex-col gap-1">
                  {showProjectFilter ? (
                    <div className="pb-1">
                      <Input
                        value={projectQuery}
                        onChange={(e) => setProjectQuery(e.target.value)}
                        placeholder="Filter projects…"
                        aria-label="Filter projects"
                        className="h-7 rounded-md px-2 text-[12px]"
                      />
                    </div>
                  ) : null}
                  <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                  {projectList.length > 0 ? (
                    projectList.map((project) => {
                      const selected = picked.includes(project.id);
                      const ownerName = owners.get(project.id);
                      return (
                        <button
                          key={project.id}
                          type="button"
                          aria-pressed={selected}
                          disabled={!!ownerName}
                          title={
                            ownerName
                              ? `Already in the live group "${ownerName}". End that group first.`
                              : undefined
                          }
                          onClick={() =>
                            setPicked((current) =>
                              current.includes(project.id)
                                ? current.filter((id) => id !== project.id)
                                : [...current, project.id],
                            )
                          }
                          className={cn(
                            "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                            selected
                              ? "bg-accent text-foreground"
                              : "text-muted-foreground",
                            ownerName &&
                              "cursor-not-allowed opacity-50 hover:bg-transparent",
                          )}
                        >
                          <HugeiconsIcon
                            icon={Folder01Icon}
                            size={16}
                            strokeWidth={1.75}
                            className="shrink-0"
                          />
                          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                            {project.name}
                          </span>
                          {ownerName ? (
                            <span
                              className="max-w-28 shrink-0 truncate rounded bg-muted/70 px-1.5 py-px text-[9.5px] text-muted-foreground"
                              title={`In "${ownerName}"`}
                            >
                              in {ownerName}
                            </span>
                          ) : (
                            <span
                              className={cn(
                                "flex size-4 shrink-0 items-center justify-center rounded border",
                                selected
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-border bg-background",
                              )}
                            >
                              {selected ? (
                                <HugeiconsIcon
                                  icon={Tick02Icon}
                                  size={11}
                                  strokeWidth={2.5}
                                />
                              ) : null}
                            </span>
                          )}
                        </button>
                      );
                    })
                  ) : (
                    <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
                      No other projects open — invite an agent persona below
                      instead.
                    </div>
                  )}
                  <div className="px-2 pb-0.5 pt-1 text-[10.5px] text-muted-foreground/70">
                    {projectList.length === candidates.length
                      ? `${candidates.length} project${candidates.length === 1 ? "" : "s"}`
                      : `${projectList.length} of ${candidates.length}`}
                  </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            {invitees.slice(0, 4).map((p2) => (
              <span
                key={p2.id}
                className="flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-foreground"
              >
                <span className="max-w-32 truncate">{p2.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${p2.name}`}
                  onClick={() =>
                    setPicked((current) => current.filter((id) => id !== p2.id))
                  }
                  className="text-muted-foreground/70 transition-colors hover:text-destructive"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={9} strokeWidth={2} />
                </button>
              </span>
            ))}
            {invitees.length > 4 ? (
              <span className="rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                +{invitees.length - 4} more
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">
            Agent personas
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <Popover
              open={personasOpen}
              onOpenChange={(v) => {
                setPersonasOpen(v);
                // Reopen clean: a stale filter would look like personas
                // vanishing between opens (same misread as the fold).
                if (!v) setPersonaQuery("");
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="justify-between gap-2 text-[12px]"
                >
                  <span className="truncate">Add personas…</span>
                  {pickedPersonas.length > 0 ? (
                    <span className="rounded bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
                      {pickedPersonas.length}
                    </span>
                  ) : null}
                  <HugeiconsIcon
                    icon={ArrowDown01Icon}
                    size={12}
                    strokeWidth={1.75}
                    className="shrink-0 text-muted-foreground"
                  />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-80 gap-0 p-1 text-xs"
                onOpenAutoFocus={(e) => e.preventDefault()}
              >
                {showPersonaFilter ? (
                  <div className="pb-1">
                    <Input
                      value={personaQuery}
                      onChange={(e) => setPersonaQuery(e.target.value)}
                      placeholder="Filter personas…"
                      aria-label="Filter personas"
                      className="h-7 rounded-md px-2 text-[12px]"
                    />
                  </div>
                ) : null}
                <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                  {personas.length === 0 ? (
                    <div className="px-3 py-4 text-center text-[12px] text-muted-foreground">
                      No personas defined.
                    </div>
                  ) : personaList.length === 0 ? (
                    <div className="px-3 py-4 text-center text-[12px] text-muted-foreground">
                      No personas match “{personaQuery}”.
                    </div>
                  ) : (
                    personaList.map((persona) => {
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
                            selected
                              ? "bg-accent text-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          <HugeiconsIcon
                            icon={UserMultiple02Icon}
                            size={16}
                            strokeWidth={1.75}
                            className="shrink-0"
                          />
                          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                            {persona.name}
                          </span>
                          <span
                            className={cn(
                              "flex size-4 shrink-0 items-center justify-center rounded border",
                              selected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border bg-background",
                            )}
                          >
                            {selected ? (
                              <HugeiconsIcon
                                icon={Tick02Icon}
                                size={11}
                                strokeWidth={2.5}
                              />
                            ) : null}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
                {personas.length > 0 ? (
                  <div className="px-2 pb-0.5 pt-1 text-[10.5px] text-muted-foreground/70">
                    {filteredPersonas.length === personas.length
                      ? `${personas.length} personas`
                      : `${filteredPersonas.length} of ${personas.length}`}
                  </div>
                ) : null}
              </PopoverContent>
            </Popover>
            {personas
              .filter((a) => pickedPersonas.includes(a.id))
              .slice(0, 4)
              .map((a) => (
                <span
                  key={a.id}
                  className="flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-foreground"
                >
                  <span className="max-w-32 truncate">{a.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${a.name}`}
                    onClick={() =>
                      setPickedPersonas((current) =>
                        current.filter((id) => id !== a.id),
                      )
                    }
                    className="text-muted-foreground/70 transition-colors hover:text-destructive"
                  >
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      size={9}
                      strokeWidth={2}
                    />
                  </button>
                </span>
              ))}
            {pickedPersonas.length > 4 ? (
              <span className="rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                +{pickedPersonas.length - 4} more
              </span>
            ) : null}
          </div>
          <p className="text-[10.5px] leading-relaxed text-muted-foreground/80">
            Personas join without a project — they reply from their own persona
            instructions, using the app's selected model.
          </p>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
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
            Create group
            {invitees.length + pickedPersonas.length > 0
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
export function ParticipantsMenu({
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
  // SINGLE MEMBERSHIP (audit M3, Option A): projects live in ANOTHER group
  // are not invitable here either; the row renders disabled with the owner.
  const invitable = candidates.filter(
    (c) => !memberIds.has(c.id) && !liveGroupForProject(c.id),
  );
  const foreignMembers = useMemo(
    () =>
      candidates
        .filter((c) => !memberIds.has(c.id) && liveGroupForProject(c.id))
        .map((c) => {
          const owner = liveGroupForProject(c.id);
          return { id: c.id, name: c.name, ownerName: owner ? owner.name : "" };
        }),
    [candidates, memberIds],
  );
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
          size="icon"
          variant="ghost"
          className="size-6 shrink-0 rounded-full border border-border/60 text-muted-foreground"
          title="Group participants"
          aria-label="Group participants"
        >
          <HugeiconsIcon
            icon={UserMultiple02Icon}
            size={12}
            strokeWidth={1.75}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-60 max-h-96 gap-0 overflow-y-auto p-1 text-xs"
      >
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
              <ParticipantDot participant={p} groupId={live.id} />
              {participantActivity(p.sessionId, live.id) !== "idle" ? (
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
                  onClick={() =>
                  Promise.resolve(removeParticipant(live.id, p.projectId)).catch(
                    (e: unknown) =>
                      console.error("[Kai-groups] remove participant failed:", e),
                  )
                }
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
                onClick={() =>
                  Promise.resolve(
                    addPersonaParticipants(live.id, [a.id]),
                  ).catch((e: unknown) =>
                    console.error("[Kai-groups] invite persona failed:", e),
                  )
                }
                className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left hover:bg-accent"
              >
                <HugeiconsIcon icon={Add01Icon} size={10} strokeWidth={1.75} />
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <span className="shrink-0 text-[9.5px] text-muted-foreground/70">
                  persona
                </span>
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
                  Promise.resolve(
                    addParticipants(live.id, [
                      { projectId: c.id, root: c.root, name: c.name },
                    ]),
                  ).catch((e: unknown) =>
                    console.error("[Kai-groups] invite project failed:", e),
                  )
                }
                className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left hover:bg-accent"
              >
                <HugeiconsIcon icon={Add01Icon} size={10} strokeWidth={1.75} />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
              </button>
            ))}
          </>
        ) : null}
        {foreignMembers.length > 0 ? (
          <>
            <div className="mt-1 px-2 pb-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              In another group
            </div>
            {foreignMembers.map((c) => (
              <div
                key={c.id}
                title={`Already in the live group "${c.ownerName}". End that group first.`}
                className="flex w-full cursor-not-allowed items-center gap-1.5 rounded px-2 py-1.5 opacity-50"
              >
                <HugeiconsIcon icon={Folder01Icon} size={10} strokeWidth={1.75} />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <span className="max-w-24 shrink-0 truncate text-[9.5px] text-muted-foreground/70">
                  in {c.ownerName}
                </span>
              </div>
            ))}
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
