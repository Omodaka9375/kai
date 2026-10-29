import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Add01Icon, Cancel01Icon, Folder01Icon, UserMultiple02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

export type ProjectSwitcherItem = {
  id: string;
  root: string;
  name: string;
  status: "idle" | "running" | "awaiting" | "error";
  active: boolean;
};

export function ProjectsSwitcher({
  projects,
  onSwitch,
  onAdd,
  onClose,
}: {
  projects: ProjectSwitcherItem[];
  onSwitch: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
}) {
  const active = projects.filter((p) => p.status === "running").length;
  const waiting = projects.filter((p) => p.status === "awaiting").length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-0"
          title="Projects and agents"
          aria-label="Projects and agents"
        >
          <HugeiconsIcon icon={UserMultiple02Icon} size={16} strokeWidth={1.75} />
          {active + waiting > 0 ? (
            <span className={cn("absolute right-0 top-0 size-1.5 rounded-full", waiting > 0 ? "bg-amber-500" : "bg-emerald-500")} />
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-1">
        <DropdownMenuLabel className="flex items-center justify-between px-2 py-1 text-[11px] font-normal text-muted-foreground">
          <span>Projects · work continues in background</span>
          <Button variant="ghost" size="icon" className="size-5" onClick={() => onAdd()} title="Open project">
            <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={1.75} />
          </Button>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {projects.map((project) => (
          <DropdownMenuItem
            key={project.id}
            onSelect={() => onSwitch(project.id)}
            className="group flex items-center gap-2 px-2 py-1"
          >
            <span className={cn(
              "size-1.5 shrink-0 rounded-full",
              project.status === "running" && "bg-emerald-500",
              project.status === "awaiting" && "bg-amber-500",
              project.status === "error" && "bg-destructive",
              project.status === "idle" && "bg-muted-foreground/30",
            )} />
            <HugeiconsIcon icon={Folder01Icon} size={13} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs" title={project.root}>
              <span className={cn(project.active && "font-medium")}>{project.name}</span>
            </span>
            {project.status !== "idle" ? (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {project.status === "running" ? "running" : project.status === "awaiting" ? "approval" : "error"}
              </span>
            ) : null}
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
              title={`Close ${project.name}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onClose(project.id);
              }}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={1.75} />
            </button>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onAdd()} className="gap-2 py-1 text-xs">
          <HugeiconsIcon icon={Add01Icon} size={13} />
          Open another project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
