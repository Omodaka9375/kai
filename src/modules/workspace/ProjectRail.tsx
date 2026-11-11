import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  FolderAddIcon,
  PencilEdit01Icon,
  RefreshIcon,
  Upload04Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useFileMenuTrigger } from "@/app/fileMenu";
import { useProjectsMenu, useProjectRailItems } from "@/app/projectsMenu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { SIDEBAR_RAIL_HEIGHT } from "@/modules/sidebar";
import { useProjectRunningTerminals } from "@/modules/terminal/lib/terminalActivity";
import { ProjectIconPicker } from "./ProjectIconPicker";
import { projectIconCss, useProjectIcon } from "./projectIcons";

export type ProjectSwitcherItem = {
  id: string;
  root: string;
  name: string;
  status: "idle" | "running" | "awaiting" | "error";
  /** Unseen agent-side news in this project (watch fired / agent replied
   *  while another project was active). Cleared on switch. */
  hasNews?: boolean;
  active: boolean;
  /** Custom tile glyph (hugeicons export name) and/or color preset key.
   * Both optional: absent = folder glyph / deterministic auto hue. */
  icon?: string;
  color?: string;
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
  hasNews,
}: {
  status: ProjectSwitcherItem["status"];
  projectId: string;
  hasNews?: boolean;
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
        // UNSEEN NEWS in a background project (watch fired / agent replied
        // while the user was elsewhere): amber pulse ranks below "needs your
        // input" but above routine running/idle — "something happened
        // there, look when you can".
        hasNews && status !== "awaiting" && status !== "error" && "animate-pulse bg-amber-500",
        // Steady emerald: agent work happening, no action needed.
        !hasNews && status === "running" && "bg-emerald-500",
        // Idle agent but terminals producing output — emerald PULSE, the
        // same work-in-progress color family as the steady agent dot above
        // (color sync 2026-10-31: "something is happening in this project"
        // is green everywhere — steady = agent run, pulse = terminal
        // command producing output; the sky dot was the only outlier).
        // ONE dot per tile: terminal activity surfaces only when there is
        // no agent state to show; the tooltip always carries the count.
        !hasNews &&
          status === "idle" &&
          runningTerminals > 0 &&
          "animate-pulse bg-emerald-500",
        !hasNews &&
          status === "idle" &&
          runningTerminals === 0 &&
          "bg-muted-foreground/30",
      )}
    />
  );
}

/** Tooltip companion to the dot: appends the running-command count.
 *  Emerald to match the pulsing terminal dot (color sync 2026-10-31). */
function TerminalRunningText({ projectId }: { projectId: string }) {
  const running = useProjectRunningTerminals(projectId);
  if (running === 0) return null;
  return (
    <span className="text-emerald-400">
      {" · "}
      {running} terminal {running === 1 ? "command" : "commands"} running
    </span>
  );
}

/** The tile's glyph: a custom hugeicons glyph when the project has one
 * (resolved lazily - non-curated names arrive with the code-split pack and
 * render the folder until then), else the folder. Custom colors ride the
 * same muted hsl(45% 52%) family as the original auto hash. */
function TileGlyph({ project, active }: { project: ProjectSwitcherItem; active: boolean }) {
  const icon = useProjectIcon(project.icon);
  return (
    <HugeiconsIcon
      icon={icon ?? Folder01Icon}
      size={17}
      strokeWidth={active ? 2 : 1.75}
      style={{ color: projectIconCss(project.color, project.id) }}
    />
  );
}

/** Always-visible project switcher. Workspaces stay mounted when switched;
 * each entry opens that project's last-active agent session. Session picking
 * deliberately lives in the AI window, not in this rail. */
export function ProjectRail({
  onSwitch,
  onAdd,
  onNewProject,
  onClose,
}: {
  onSwitch: (id: string) => void;
  onAdd: () => void | Promise<void>;
  onNewProject: () => void | Promise<void>;
  onClose: (id: string) => void;
}) {
  const fileMenuTrigger = useFileMenuTrigger();
  // Live items (2026-11-02): the rail subscribes itself — status
  // transitions re-render THIS component only, never the memoized
  // workspaces (previously the items rode the menu context every
  // workspace consumed, so every status bump re-rendered everything).
  const projects = useProjectRailItems();
  // MANUAL ORDER (2026-11-02): drag a project tile onto another to swap
  // its position. The move goes through the menu action (AppShell), so
  // the reorder persists with the open-projects roots order.
  const menu = useProjectsMenu();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // Project whose tile has the icon picker dialog open (null = closed).
  const [iconPickerFor, setIconPickerFor] = useState<string | null>(null);
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
        <div className="relative flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto p-1.5 [scrollbar-width:thin] [-ms-overflow-style:none] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/60">
          {projects.map((project) => (
            <ContextMenu key={project.id}>
              <ContextMenuTrigger asChild>
              <div
                className="group relative w-full"
              draggable
              onDragStart={(e) => {
                setDragId(project.id);
                // FireFox requires data on the drag payload to start a
                // drag at all; the id doubles as the text fallback.
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", project.id);
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === project.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOverId(project.id);
              }}
              onDragLeave={() => setOverId((id) => (id === project.id ? null : id))}
              onDrop={(e) => {
                if (!dragId || dragId === project.id) return;
                e.preventDefault();
                menu?.moveProject(dragId, project.id);
                setDragId(null);
                setOverId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
            >
              {/* Drop indicator: a bright underline on the hovered tile —
                  the visual "it will land here" affordance. */}
              {overId === project.id && dragId !== null && dragId !== project.id ? (
                <span className="pointer-events-none absolute -bottom-0.5 left-1 right-1 h-0.5 rounded-full bg-primary/80" />
              ) : null}
              {dragId === project.id ? (
                <span className="pointer-events-none absolute inset-0 rounded-lg bg-primary/10" />
              ) : null}
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
                    <TileGlyph project={project} active={project.active} />
                    <TileStatusDot status={project.status} projectId={project.id} hasNews={project.hasNews} />
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
                    {project.hasNews ? (
                      <span className="text-amber-400">{" • something new"}</span>
                    ) : null}
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
                  className="absolute -left-0.5 -top-0.5 hidden size-3.5 items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground hover:text-destructive group-hover:flex group-focus-within:flex"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={9} strokeWidth={2} />
                </button>
              ) : null}
              </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48 text-xs">
                <ContextMenuItem onSelect={() => setIconPickerFor(project.id)}>
                  <HugeiconsIcon icon={PencilEdit01Icon} size={14} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
                  Change icon...
                </ContextMenuItem>
                {project.icon || project.color ? (
                  <ContextMenuItem onSelect={() => menu?.changeProjectIcon(project.id, null, null)}>
                    <HugeiconsIcon icon={RefreshIcon} size={14} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
                    Reset to default
                  </ContextMenuItem>
                ) : null}
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </div>
        <div
          style={{ height: SIDEBAR_RAIL_HEIGHT }}
          className="flex shrink-0 items-center justify-center border-t border-border/60"
        >
          {/* The + opens a DROP-UP (the rail sits at the screen's bottom-left
              edge, so up is the only direction with room): New Project
              (create a folder + open it) and Open Project (pick an existing
              folder). Built on the Popover primitive per the multiProject
              contract's no-header-dropdown rule. */}
          <Popover open={addMenuOpen} onOpenChange={setAddMenuOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="Add project"
                    aria-haspopup="menu"
                    aria-expanded={addMenuOpen}
                    onClick={() => setAddMenuOpen(true)}
                    className="flex size-9 w-full items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    <HugeiconsIcon icon={Add01Icon} size={17} strokeWidth={1.75} />
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>Add project</TooltipContent>
            </Tooltip>
            <PopoverContent
              side="top"
              align="start"
              sideOffset={8}
              className="flex w-48 flex-col gap-0 p-1 text-xs"
              // Don't steal focus from the rail — the menu opens on click,
              // not as a typing-context interruption.
              onOpenAutoFocus={(e) => e.preventDefault()}
            >
              <button
                type="button"
                onClick={() => {
                  setAddMenuOpen(false);
                  void onNewProject();
                }}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent hover:text-foreground"
              >
                <HugeiconsIcon icon={FolderAddIcon} size={14} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
                <span>New Project</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setAddMenuOpen(false);
                  void onAdd();
                }}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent hover:text-foreground"
              >
                <HugeiconsIcon icon={Upload04Icon} size={14} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
                <span>Open Project</span>
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </aside>
      {/* Icon picker dialog lives OUTSIDE the aside layout (Radix portals it
          anyway) - keyed to whichever tile was right-clicked. */}
      <ProjectIconPicker
        project={projects.find((p) => p.id === iconPickerFor) ?? null}
        onOpenChange={(open) => {
          if (!open) setIconPickerFor(null);
        }}
        onChange={(icon, color) => {
          if (iconPickerFor) menu?.changeProjectIcon(iconPickerFor, icon, color);
        }}
      />
    </TooltipProvider>
  );
}

