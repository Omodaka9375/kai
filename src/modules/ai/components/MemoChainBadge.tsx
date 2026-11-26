import AiBrain01Icon from "@hugeicons/core-free-icons/AiBrain01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import { isProxyManagedModel } from "../config";

/**
 * Small "durable memory" marker shown next to a model name when that model is
 * toggled for MemoChain (Settings → Models → Durable memory). The per-model
 * toggle itself is invisible in normal chat surfaces — without this badge a
 * user cannot tell whether the selected model routes through the embedded
 * memory handler or KAI's default summarization.
 *
 * Renders NOTHING for non-toggled models — the badge is a signal, not a
 * decoration, so it must not add empty spacing on models without memory.
 */
export function MemoChainBadge({
  modelId,
  className,
  size = 11,
}: {
  modelId: string | null | undefined;
  className?: string;
  /** Icon size; call sites pick 11 (status-bar picker) / 9 (Workspaces card
   *  pill) to match their adjacent model labels. */
  size?: number;
}) {
  if (!isProxyManagedModel(modelId)) return null;
  return (
    <span
      title="Durable memory (MemoChain) — sessions on this model fold overflow history into a verifiable in-app memory capsule."
      className="inline-flex shrink-0"
    >
      <HugeiconsIcon
        icon={AiBrain01Icon}
        size={size}
        strokeWidth={1.75}
        className={cn("text-primary/90", className)}
      />
    </span>
  );
}
