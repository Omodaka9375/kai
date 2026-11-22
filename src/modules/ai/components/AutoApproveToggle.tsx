import Shield01Icon from "@hugeicons/core-free-icons/Shield01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import { useChatStore, type AutoApproveMode } from "../store/chatStore";

const COLORS: Record<AutoApproveMode, string> = {
  // Ask is AMBER (attention needed - the agent will stop and ask), Allow
  // stays EMERALD (free to run). Matches the Workspaces card SessionApprovePill
  // and the Stop square in the todo strip so the agent-control cluster
  // speaks one color language: green = auto-running, amber = needs a human.
  off: "text-amber-600 dark:text-amber-400",
  all: "text-emerald-600 dark:text-emerald-400",
};

const TOOLTIPS: Record<AutoApproveMode, string> = {
  off: "Ask mode: ask before every approval-required tool call (click to switch to Allow)",
  all: "Allow mode: allow tool calls without asking (click to switch to Ask)",
};

const ARIA_LABELS: Record<AutoApproveMode, string> = {
  off: "Ask mode (click to switch to Allow)",
  all: "Allow mode (click to switch to Ask)",
};

/** Compact single-icon cycling toggle for auto-approve mode (Ask / Allow). */
export function AutoApproveToggle({ className }: { className?: string }) {
  const mode = useChatStore((s) => s.autoApprove);
  const cycle = useChatStore((s) => s.cycleAutoApprove);

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={ARIA_LABELS[mode]}
      title={TOOLTIPS[mode]}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md p-1 transition-colors hover:bg-muted/60",
        COLORS[mode],
        className,
      )}
    >
      <HugeiconsIcon icon={Shield01Icon} size={14} strokeWidth={2} />
    </button>
  );
}