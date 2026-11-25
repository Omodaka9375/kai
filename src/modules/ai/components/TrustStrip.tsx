import AlertCircleIcon from "@hugeicons/core-free-icons/AlertCircleIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSyncExternalStore } from "react";
import { useProjectRailItems } from "@/app/projectsMenu";
import {
  getWorkspaceTrustVersion,
  isWorkspaceTrustHydrated,
  isWorkspaceTrusted,
  subscribeWorkspaceTrust,
  trustWorkspace,
} from "@/modules/workspace/workspaceTrust";

/**
 * Untrusted-project banner (2026-11-25 per-project trust toggle): the AI
 * window of a project the user has not yet trusted shows this strip above
 * the transcript. One click trusts the project: Allow mode becomes
 * effective again and the <untrusted-project> prompt notice disappears.
 *
 * Vocabulary: "Trust this project" - not "Allow" (that is the Ask/Allow
 * pill's word) and not "Verify" (that implies KAI checked the repo; trust
 * is the USER's call).
 */
export function TrustStrip() {
  const items = useProjectRailItems();
  const activeItem = items.find((i) => i.active) ?? null;
  useSyncExternalStore(subscribeWorkspaceTrust, getWorkspaceTrustVersion);
  const hydrated = isWorkspaceTrustHydrated();
  // Defer until the registry loads so the strip never flashes on boot for
  // already-trusted projects.
  if (!hydrated || !activeItem) return null;
  if (isWorkspaceTrusted(activeItem.id)) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5">
      <HugeiconsIcon
        icon={AlertCircleIcon}
        size={13}
        strokeWidth={1.75}
        className="shrink-0 text-amber-600 dark:text-amber-400"
      />
      <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
        Untrusted project
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
        Ask mode is enforced; rules files from this repo are treated as untrusted.
      </span>
      <button
        type="button"
        onClick={() => trustWorkspace(activeItem.id)}
        className="shrink-0 rounded border border-amber-500/50 bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 transition-colors hover:bg-amber-500/25 dark:text-amber-300"
      >
        Trust this project
      </button>
    </div>
  );
}
