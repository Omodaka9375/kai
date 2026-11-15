import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HugeiconsIcon } from "@hugeicons/react";
import Alert02Icon from "@hugeicons/core-free-icons/Alert02Icon";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { useLocalModelProbeStore } from "@/modules/ai/lib/localModelProbe";

/**
 * Statusbar warning pill for local-model configuration drift: the
 * configured OpenAI-compatible model id is no longer served by the
 * endpoint (or the endpoint is down entirely). Same contract as
 * McpStatusPill: hidden while healthy or unchecked, amber pill when
 * something is genuinely wrong, click deep-links to Settings → Models.
 */
export function LocalModelStatusPill() {
  const status = useLocalModelProbeStore((s) => s.status);

  if (status.state !== "missing" && status.state !== "unreachable") {
    return null;
  }

  const label =
    status.state === "missing"
      ? `Model "${status.configuredId}" not served by endpoint`
      : "Local model endpoint unreachable";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void openSettingsWindow("models")}
          aria-label={`${label} — open Models settings`}
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 transition-colors hover:bg-amber-500/25 dark:text-amber-400"
        >
          <HugeiconsIcon icon={Alert02Icon} size={11} strokeWidth={2} />
          <span>Model: {status.state === "missing" ? "not found" : "offline"}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-[11px] leading-relaxed">
        <div className="space-y-1">
          <div className="font-medium">{label}</div>
          {status.state === "missing" ? (
            <div>
              The endpoint currently serves: {status.available.slice(0, 8).join(", ")}
              {status.available.length > 8 ? ", …" : ""}
              . Update the model id in Settings → Models.
            </div>
          ) : (
            <div>{status.error}</div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
