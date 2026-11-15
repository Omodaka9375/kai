import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HugeiconsIcon } from "@hugeicons/react";
import Alert02Icon from "@hugeicons/core-free-icons/Alert02Icon";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { useMcpStore } from "@/modules/ai/store/mcpStore";

/**
 * Statusbar warning pill for MCP servers that are DOWN: enabled in config
 * but in `error` state (failed connect, connect timeout, or a stdio process
 * that died mid-session — mcpManager.markServerDead). Hidden entirely while
 * everything is healthy; a warning chip must not become permanent chrome.
 * Click deep-links to Settings → MCP where reconnect lives.
 */
export function McpStatusPill() {
  const servers = useMcpStore((s) => s.servers);
  const statuses = useMcpStore((s) => s.statuses);

  const down = servers.filter(
    (s) => s.enabled && statuses[s.id]?.status === "error",
  );
  if (down.length === 0) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void openSettingsWindow("mcp")}
          aria-label={`${down.length} MCP server${down.length > 1 ? "s" : ""} down — open MCP settings`}
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 transition-colors hover:bg-amber-500/25 dark:text-amber-400"
        >
          <HugeiconsIcon icon={Alert02Icon} size={11} strokeWidth={2} />
          <span>
            MCP: {down.length} down
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-[11px] leading-relaxed">
        <div className="space-y-1">
          {down.map((s) => {
            const error = statuses[s.id]?.error;
            return (
              <div key={s.id}>
                <span className="font-medium">{s.name}</span>
                {error ? <span className="block opacity-80">{error}</span> : null}
              </div>
            );
          })}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
