import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  coordinatorPendingCount,
  delegateCoordination,
  isPersonaParticipantId,
  reclaimCoordination,
  type GroupChat,
} from "../store/groupChatStore";
import { cn } from "@/lib/utils";

/**
 * Phase 2: hand coordination to a participant's agent (or take it back).
 * These buttons are the ONLY entry to delegation — an agent can never seize
 * the coordinator role (see groupChatStore trust boundary). Delegating arms
 * the preamble injection in AgentRunBridge; the delegate agent then drives
 * the group via send_to_project / project_status.
 */
export function CoordinatorMenu({ group }: { group: GroupChat }) {
  const [open, setOpen] = useState(false);
  const isAgentCoord = group.coordinator.kind === "agent";
  const coordSession =
    group.coordinator.kind === "agent" ? group.coordinator.sessionId : "";
  const pending = isAgentCoord ? coordinatorPendingCount(coordSession) : 0;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 shrink-0 gap-1 rounded-full border border-border/60 px-2.5 text-[11px]"
          title="Who coordinates this group"
        >
          {isAgentCoord ? "Delegated" : "You coordinate"}
          {pending > 0 ? (
            <span className="size-1.5 animate-pulse rounded-full bg-primary" />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 gap-0 p-1 text-xs">
        <div className="px-2 pb-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Delegate coordination to…
        </div>
        {group.participants.map((p) => {
          const active =
            isAgentCoord &&
            group.coordinator.kind === "agent" &&
            group.coordinator.projectId === p.projectId;
          // Personas can never take the coordinator role (no session, no
          // bridge — see delegateCoordination's guard). Hide the button
          // rather than showing one that does nothing.
          if (isPersonaParticipantId(p.projectId)) {
            return (
              <div
                key={p.projectId}
                className="flex w-full items-center justify-between rounded px-2 py-1.5 opacity-50"
                title="Personas cannot coordinate a group"
              >
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="text-[9.5px]">persona</span>
              </div>
            );
          }
          return (
            <button
              key={p.projectId}
              type="button"
              disabled={active}
              onClick={() => {
                setOpen(false);
                void delegateCoordination(group.id, p.projectId);
              }}
              className={cn(
                "flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-accent disabled:opacity-40",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {active ? (
                <span className="text-[9.5px] text-primary">coordinating</span>
              ) : null}
            </button>
          );
        })}
        {isAgentCoord ? (
          <>
            <div className="my-1 h-px bg-border/60" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void reclaimCoordination(group.id);
              }}
              className="w-full rounded px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Take coordination back
            </button>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
