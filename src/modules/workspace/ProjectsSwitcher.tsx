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
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Folder01Icon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { getProjectModel, getProjectPersona, getSessionAgentMeta, type AgentRunStatus } from "@/modules/ai/store/chatStore";
import type { SessionMeta } from "@/modules/ai/lib/sessions";
import { getModel } from "@/modules/ai/config";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import { getSessionPreferences } from "@/modules/ai/store/sessionPreferences";

export type ProjectSwitcherItem = {
  id: string;
  root: string;
  name: string;
  status: "idle" | "running" | "awaiting" | "error";
  active: boolean;
};

function StatusDot({ status }: { status: AgentRunStatus | ProjectSwitcherItem["status"] }) {
  return <span className={cn(
    "size-1.5 shrink-0 rounded-full",
    (status === "running" || status === "thinking" || status === "streaming") && "bg-emerald-500",
    (status === "awaiting" || status === "awaiting-approval") && "bg-amber-500",
    status === "error" && "bg-destructive",
    status === "idle" && "bg-muted-foreground/30",
  )} />;
}

export function ProjectsSwitcher({
  projects,
  sessions,
  onSwitch,
  onSwitchSession,
  onNewSession,
  onArchiveSession,
  onRestoreSession,
  onAdd,
  onClose,
}: {
  projects: ProjectSwitcherItem[];
  sessions: SessionMeta[];
  onSwitch: (id: string) => void;
  onSwitchSession: (projectId: string, sessionId: string) => void;
  onNewSession: (projectId: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onRestoreSession: (projectId: string, sessionId: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(projects.map((p) => p.id)));
  const [showArchived, setShowArchived] = useState(false);
  // Sessions arrive via the projects-menu context; guard against a wiring
  // that hasn't supplied them yet (mid-HMR, missed provider prop). Crashing
  // here takes out the header.
  const safeSessions = Array.isArray(sessions) ? sessions : [];
  const running = projects.filter((p) => p.status === "running").length;
  const waiting = projects.filter((p) => p.status === "awaiting").length;
  const customAgents = useAgentsStore((s) => s.customAgents);
  const allAgents = useAgentsStore.getState().all();
  void customAgents;

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
          {running + waiting > 0 ? (
            <span className={cn("absolute right-0 top-0 size-1.5 rounded-full", waiting > 0 ? "bg-amber-500" : "bg-emerald-500")} />
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(34rem,80vh)] w-80 overflow-y-auto p-1">
        <DropdownMenuLabel className="flex items-center justify-between px-2 py-1 text-[11px] font-normal text-muted-foreground">
          <span>Projects · agents keep running</span>
          <Button variant="ghost" size="icon" className="size-5" onClick={() => onAdd()} title="Open project">
            <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={1.75} />
          </Button>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {projects.map((project) => {
          const projectSessions = safeSessions.filter((session) => {
            const preferences = getSessionPreferences(session.id);
            return preferences.projectId === project.id &&
              (showArchived || !preferences.archivedAt || getSessionAgentMeta(session.id).status !== "idle");
          });
          const isExpanded = expanded.has(project.id) || project.active;
          return (
            <div key={project.id} className="mb-0.5">
              <DropdownMenuItem
                onSelect={() => onSwitch(project.id)}
                className={cn("group flex items-center gap-1.5 px-1.5 py-1", project.active && "bg-accent/40")}
              >
                <button
                  type="button"
                  className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
                  aria-label={isExpanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleExpanded(project.id);
                  }}
                >
                  <HugeiconsIcon icon={isExpanded ? ArrowDown01Icon : ArrowRight01Icon} size={10} />
                </button>
                <HugeiconsIcon icon={Folder01Icon} size={12} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-xs" title={project.root}>
                  <span className={cn(project.active && "font-medium")}>{project.name}</span>
                </span>
                <StatusDot status={project.status} />
                {project.status !== "idle" ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {project.status === "running" ? "running" : project.status === "awaiting" ? "approval" : "error"}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="rounded p-0.5 text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                  title={`Close project ${project.name} and stop its agents/terminals`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onClose(project.id);
                  }}
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={1.75} />
                </button>
              </DropdownMenuItem>
              {isExpanded ? (
                <div className="ml-6 border-l border-border/40 pl-1">
                  {projectSessions.map((session) => {
                    const preferences = getSessionPreferences(session.id);
                    const status = getSessionAgentMeta(session.id).status;
                    const model = getModel(preferences.modelId ?? getProjectModel(project.id)).label;
                    const personaId = preferences.personaId ?? getProjectPersona(project.id);
                    const persona = personaId && personaId !== "__none__"
                      ? allAgents.find((agent) => agent.id === personaId)?.name
                      : null;
                    return (
                      <DropdownMenuItem
                        key={session.id}
                        onSelect={() => preferences.archivedAt
                          ? onRestoreSession(project.id, session.id)
                          : onSwitchSession(project.id, session.id)}
                        className="group flex items-center gap-1.5 px-1.5 py-1 text-[11px]"
                      >
                        <StatusDot status={status} />
                        <span className="min-w-0 flex-1 truncate" title={session.title}>{session.title}</span>
                        {persona || model ? (
                          <span className="max-w-20 shrink-0 truncate text-[9px] text-muted-foreground/70" title={[persona, model].filter(Boolean).join(" · ")}>
                            {persona ?? model}
                          </span>
                        ) : null}
                        {preferences.archivedAt && status === "idle" ? (
                          <span className="shrink-0 text-[9px] text-muted-foreground">archived</span>
                        ) : null}
                        {!preferences.archivedAt ? (
                          <button
                            type="button"
                            className="rounded px-1 text-[9px] text-muted-foreground opacity-0 hover:bg-accent group-hover:opacity-100"
                            title="Archive session (keeps its transcript; a running agent continues)"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              onArchiveSession(session.id);
                            }}
                          >
                            archive
                          </button>
                        ) : null}
                      </DropdownMenuItem>
                    );
                  })}
                  <DropdownMenuItem
                    onSelect={() => onNewSession(project.id)}
                    className="gap-1.5 px-1.5 py-1 text-[10px] text-muted-foreground"
                  >
                    <HugeiconsIcon icon={Add01Icon} size={10} />
                    New agent session
                  </DropdownMenuItem>
                </div>
              ) : null}
            </div>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onAdd()} className="gap-2 py-1 text-xs">
          <HugeiconsIcon icon={Add01Icon} size={13} />
          Open another project
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setShowArchived((value) => !value)} className="py-1 text-[10px] text-muted-foreground">
          {showArchived ? "Hide archived sessions" : "Show archived sessions"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
