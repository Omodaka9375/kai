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
  awaiting: "Approval needed",
  error: "Agent error",
};

function StatusDot({ status }: { status: ProjectSwitcherItem["status"] }) {
  return (
    <span
      className={cn(
        "absolute bottom-1 right-1 size-1.5 rounded-full ring-2 ring-card",
        status === "running" && "bg-emerald-500",
        status === "awaiting" && "bg-amber-500",
        status === "error" && "bg-destructive",
        status === "idle" && "bg-muted-foreground/30",
      )}
    />
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
}: {
  projects: ProjectSwitcherItem[];
  onSwitch: (id: string) => void;
  onAdd: () => void | Promise<void>;
  onClose: (id: string) => void;
}) {
  const fileMenuTrigger = useFileMenuTrigger();
  return (
    <TooltipProvider delayDuration={250}>
      <aside
        aria-label="Open projects"
        className="flex w-12 shrink-0 flex-col border-r border-border/60 bg-card"
      >
        <div className="flex h-10 shrink-0 items-center justify-center border-b border-border/60">
          {fileMenuTrigger}
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto p-1.5">
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
                    <HugeiconsIcon icon={Folder01Icon} size={17} strokeWidth={project.active ? 2 : 1.75} />
                    <StatusDot status={project.status} />
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
