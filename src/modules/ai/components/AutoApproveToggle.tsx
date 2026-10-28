import { cn } from "@/lib/utils";
import { useChatStore, type AutoApproveMode } from "../store/chatStore";

const LABELS: Record<AutoApproveMode, string> = {
  off: "Ask",
  all: "Allow",
};

const DOTS: Record<AutoApproveMode, string> = {
  off: "bg-muted-foreground/50",
  all: "bg-emerald-500",
};

const TOOLTIPS: Record<AutoApproveMode, string> = {
  off: "Ask before every approval-required tool call",
  all: "Allow every tool call without asking (elevation, screen capture, and signed commits still ask)",
};

/** Compact cycling toggle for auto-approve mode. Two states: Ask / Allow. */
export function AutoApproveToggle({ className }: { className?: string }) {
  const mode = useChatStore((s) => s.autoApprove);
  const cycle = useChatStore((s) => s.cycleAutoApprove);

  return (
    <button
      type="button"
      onClick={cycle}
      title={TOOLTIPS[mode]}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-[10.5px] transition-colors",
        "hover:bg-muted/60 text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", DOTS[mode])} />
      <span className="font-medium">{LABELS[mode]}</span>
    </button>
  );
}