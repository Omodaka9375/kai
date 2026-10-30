import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  Add01Icon,
  Cancel01Icon,
  Folder01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useFileMenuTrigger } from "@/app/fileMenu";
import { SIDEBAR_RAIL_HEIGHT } from "@/modules/sidebar";
import { useProjectRunningTerminals } from "@/modules/terminal/lib/terminalActivity";
import { getProjectAgentStatus } from "@/modules/ai/store/projectStatus";
import {
  getGroupStoreVersion,
  getGroups,
  subscribeGroupChats,
} from "@/modules/ai/store/groupChatStore";
import { useSyncExternalStore } from "react";

export type ProjectSwitcherItem = {
  id: string;
  root: string;
  name: string;
  status: "idle" | "running" | "awaiting" | "error";
  active: boolean;
};

const STATUS_LABEL: Record<ProjectSwitcherItem["status"], string> = {
  idle: "Idle",
  running: "Agent running",
  awaiting: "Needs your input",
  error: "Agent error",
};

function TileStatusDot({
  status,
  projectId,
}: {
  status: ProjectSwitcherItem["status"];
  projectId: string;
}) {
  const runningTerminals = useProjectRunningTerminals(projectId);
  return (
    <span
      className={cn(
        "absolute bottom-1 right-1 size-1.5 rounded-full ring-2 ring-card",
        // NEEDS YOUR INPUT — the only attention-demanding state. Unique
        // violet + pulse so it can't be missed in peripheral vision.
        // This (plus the error dot) replaces the removed OS popups.
        status === "awaiting" && "animate-pulse bg-violet-500",
        status === "error" && "bg-destructive",
        // Steady emerald: agent work happening, no action needed.
        status === "running" && "bg-emerald-500",
        // Idle agent but terminals producing output — sky pulse. ONE dot per
        // tile: terminal activity surfaces only when there is no agent state
        // to show; the tooltip always carries the running-command count.
        status === "idle" && runningTerminals > 0 && "animate-pulse bg-sky-500",
        status === "idle" && runningTerminals === 0 && "bg-muted-foreground/30",
      )}
    />
  );
}

/** Tooltip companion to the dot: appends the running-command count. */
function TerminalRunningText({ projectId }: { projectId: string }) {
  const running = useProjectRunningTerminals(projectId);
  if (running === 0) return null;
  return (
    <span className="text-sky-400">
      {" · "}
      {running} terminal {running === 1 ? "command" : "commands"} running
    </span>
  );
}

/** Always-visible project switcher. Workspaces stay mounted when switched;
 * each entry opens that project's last-active agent session. Session picking
 * deliberately lives in the AI window, not in this rail. */
export function ProjectRail({
  projects,
  onSwitch,
  onAdd,
  onClose,
  onOpenGroup,
}: {
  projects: ProjectSwitcherItem[];
  onSwitch: (id: string) => void;
  onAdd: () => void | Promise<void>;
  onClose: (id: string) => void;
  /** Open the group-chat panel for a group the arcs reference. */
  onOpenGroup: (groupId: string) => void;
}) {
  const fileMenuTrigger = useFileMenuTrigger();
  return (
    <TooltipProvider
      delayDuration={250}
      // Skip the open delay on immediate re-hover (e.g. after a project
      // switch makes the tile the pointer is over change identity): the
      // tooltip then appears instantly instead of lagging 250ms behind.
      skipDelayDuration={100}
    >
      <aside
        aria-label="Open projects"
        className="flex w-12 shrink-0 flex-col border-r border-border/60 bg-card"
      >
        <div className="flex h-10 shrink-0 items-center justify-center border-b border-border/60">
          {fileMenuTrigger}
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto p-1.5">
          {/* Cross-project group-chat connector arcs — thin lines between
              participant tiles, one arc per (group, other-project) edge.
              Rendered inside the scroll container so they scroll with tiles.
              Clicking an arc opens the group panel (via the parent). */}
          <GroupArcs
            projects={projects}
            onOpenGroup={onOpenGroup}
          />
          {projects.map((project) => (
            <div key={project.id} className="group relative w-full">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Switch to ${project.name}`}
                    aria-current={project.active ? "page" : undefined}
                    onClick={() => onSwitch(project.id)}
                    className={cn(
                      "relative flex size-9 w-full items-center justify-center rounded-lg border outline-none transition-colors",
                      "focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-0",
                      project.active
                        ? "border-border/70 bg-accent text-foreground"
                        : "border-transparent text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                    )}
                  >
                    {project.active ? (
                      <span className="absolute -left-1.5 h-4 w-0.5 rounded-r bg-foreground/70" />
                    ) : null}
                    <HugeiconsIcon
                      icon={Folder01Icon}
                      size={17}
                      strokeWidth={project.active ? 2 : 1.75}
                      // Subtle per-project hue so tiles stay recognizable at a
                      // glance. Low saturation/lightness keeps it on-theme.
                      style={{ color: projectIconColor(project.id) }}
                    />
                    <TileStatusDot status={project.status} projectId={project.id} />
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  sideOffset={8}
                  className="w-96 flex-col items-start gap-2 px-3.5 py-2.5 text-left"
                >
                  <div className="font-medium leading-4">{project.name}</div>
                  <div className="w-full break-all font-mono text-[10px] leading-4 text-background/70">
                    {project.root}
                  </div>
                  <div className="w-full whitespace-nowrap border-t border-background/15 pt-1.5 text-[10px] text-background/70">
                    {STATUS_LABEL[project.status]}
                    <TerminalRunningText projectId={project.id} />
                  </div>
                </TooltipContent>
              </Tooltip>
              {projects.length > 1 ? (
                <button
                  type="button"
                  aria-label={`Close ${project.name}`}
                  title={`Close ${project.name}`}
                  onClick={() => onClose(project.id)}
                  className="absolute -right-0.5 -top-0.5 hidden size-3.5 items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground hover:text-destructive group-hover:flex group-focus-within:flex"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={9} strokeWidth={2} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <div
          style={{ height: SIDEBAR_RAIL_HEIGHT }}
          className="flex shrink-0 items-center justify-center border-t border-border/60"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Open another project"
                onClick={() => void onAdd()}
                className="flex size-9 w-full items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <HugeiconsIcon icon={Add01Icon} size={17} strokeWidth={1.75} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>Open another project</TooltipContent>
          </Tooltip>
        </div>
      </aside>
    </TooltipProvider>
  );
}

/**
 * SVG connector arcs between tiles of projects that share a group chat.
 * Purely derived from the group store + rail item order; each arc is a
 * leftward bulging curve hugging the rail's left edge between two tiles.
 * Click opens the group panel; the arc animates while either endpoint's
 * agent is busy.
 */
function GroupArcs({
  projects,
  onOpenGroup,
}: {
  projects: ProjectSwitcherItem[];
  onOpenGroup: (groupId: string) => void;
}) {
  const version = useSyncExternalStore(subscribeGroupChats, getGroupStoreVersion, getGroupStoreVersion);
  void version; // re-render on every group-store change
  // Compute edges: for every live group, for every participant pair present
  // in the rail, one edge keyed by the two tile indexes.
  const tileIndexOf = new Map(projects.map((p, i) => [p.id, i]));
  type Edge = { key: string; groupId: string; name: string; a: number; b: number; busy: boolean };
  const edges: Edge[] = [];
  for (const group of getGroups()) {
    if (group.endedAt !== null) continue;
    const idxs = group.participants
      .map((p) => tileIndexOf.get(p.projectId))
      .filter((v): v is number => v !== undefined)
      .sort((x, y) => x - y);
    if (idxs.length < 2) continue;
    const first = idxs[0]!;
    const last = idxs[idxs.length - 1]!;
    const busy = group.participants.some(
      (p) => tileIndexOf.has(p.projectId) && isProjectAgentBusy(p.projectId),
    );
    edges.push({
      key: `${group.id}:${first}-${last}`,
      groupId: group.id,
      name: group.name,
      a: first,
      b: last,
      busy,
    });
  }
  if (edges.length === 0) return null;
  // Tile geometry: p-1.5 (6px) + gap-1 (4px between tiles) + size-9 (36px).
  const TILE = 36;
  const GAP = 4;
  const PAD = 6;
  const yFor = (i: number) => PAD + i * (TILE + GAP) + TILE / 2;
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ width: 12 }}
    >
      {edges.map((e) => {
        const y1 = yFor(e.a);
        const y2 = yFor(e.b);
        const mid = (y1 + y2) / 2;
        const d = `M 11 ${y1} C 2 ${mid}, 2 ${mid}, 11 ${y2}`;
        return (
          <g key={e.key} className="pointer-events-auto cursor-pointer">
            <title>{`${e.name} — group chat`}</title>
            <path
              d={d}
              fill="none"
              strokeWidth={1.5}
              stroke={groupArcColor(e.groupId)}
              strokeOpacity={e.busy ? 0.95 : 0.55}
              className="transition-[stroke-opacity,stroke-dasharray] duration-300"
              strokeDasharray={e.busy ? "3 3" : undefined}
            />
            {/* Wider invisible hit area */}
            <path
              d={d}
              fill="none"
              strokeWidth={9}
              stroke="transparent"
              onClick={() => onOpenGroup(e.groupId)}
            />
          </g>
        );
      })}
    </svg>
  );
}

function isProjectAgentBusy(projectId: string): boolean {
  const s = getProjectAgentStatus(projectId);
  return s === "streaming" || s === "thinking";
}

/** Deterministic, subtle per-project icon hue: hash -> hsl(h, 45%, 55%).
 *  Same hash scheme as groupArcColor but muted — enough to tell projects
 *  apart at a glance without fighting the theme. Dark mode lightens a touch. */
function projectIconColor(projectId: string): string {
  let h = 0;
  for (let i = 0; i < projectId.length; i++) {
    h = (h * 31 + projectId.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360} 45% 52%)`;
}

/** Deterministic arc hue per group id: hash -> hsl(h, 70%, 55%) so concurrent
 *  groups get visually distinct connector colors without a stored palette. */
function groupArcColor(groupId: string): string {
  let h = 0;
  for (let i = 0; i < groupId.length; i++) {
    h = (h * 31 + groupId.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360} 70% 55%)`;
}

