import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
// loadMcpServers (lib/mcp) touches ONLY plugin-store — NOT mcpManager. The
// Assistant panel was deliberately kept free of the AI runtime (see prefs.ts
// header); useMcpStore would drag mcpManager + the MCP SDK client back in and
// re-slow the panel open. We only need id/name/enabled to draw the list.
import { loadMcpServers, type McpServerConfig } from "@/modules/ai/lib/mcp";
import {
  TIER_HINTS,
  TIER_LABELS,
  TOOL_CATALOG,
  toolsInTier,
  type ToolTier,
} from "@/modules/assistant/toolCatalog";

type Props = {
  allowedTools: string[];
  mcpAllowedServers: string[];
  onChange: (next: {
    allowedTools: string[];
    mcpAllowedServers: string[];
  }) => void;
  disabled?: boolean;
};

const TIER_ORDER: ToolTier[] = ["read", "write", "execute"];

/**
 * Chips-dropdown for the assistant's tool allowlist.
 *
 * The trigger chip summarizes state at a glance ("14 of 25 tools · 2 MCP");
 * the popover is a grouped checklist — three risk tiers, each with a master
 * toggle, plus one checkbox per installed MCP server. Selection is persisted
 * verbatim (no "allow-all" sentinel): what you see checked is exactly the
 * name set runAssistantTurn filters against.
 */
export function ToolAllowlistPicker({
  allowedTools,
  mcpAllowedServers,
  onChange,
  disabled,
}: Props) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void loadMcpServers().then(setServers).catch(() => setServers([]));
  }, []);

  const allowed = useMemo(() => new Set(allowedTools), [allowedTools]);
  const enabledCount = allowed.size + mcpAllowedServers.length;
  const totalCount = TOOL_CATALOG.length + servers.length;

  const toggleTool = (name: string, on: boolean) => {
    const next = new Set(allowed);
    if (on) next.add(name);
    else next.delete(name);
    onChange({ allowedTools: [...next], mcpAllowedServers });
  };

  const toggleTier = (tier: ToolTier, on: boolean) => {
    const names = toolsInTier(tier);
    const next = new Set(allowed);
    for (const n of names) {
      if (on) next.add(n);
      else next.delete(n);
    }
    onChange({ allowedTools: [...next], mcpAllowedServers });
  };

  const toggleServer = (id: string, on: boolean) => {
    const next = new Set(mcpAllowedServers);
    if (on) next.add(id);
    else next.delete(id);
    onChange({ allowedTools, mcpAllowedServers: [...next] });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-7 gap-1.5 px-2.5 text-xs font-normal"
        >
          {enabledCount === 0 ? (
            <span className="text-muted-foreground">No tools</span>
          ) : (
            <span>
              {enabledCount} of {totalCount}
              <span className="text-muted-foreground">
                {" "}
                · {mcpAllowedServers.length} MCP
              </span>
            </span>
          )}
          <HugeiconsIcon
            icon={ChevronDown}
            size={12}
            className="text-muted-foreground"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[420px] p-0"
        // Popover inside the settings window scrolled column: keep it
        // scrollable itself rather than overflow-clipped.
        style={{ maxHeight: "70vh", overflowY: "auto" }}
      >
        <div className="px-3 pb-1.5 pt-2.5">
          <div className="text-xs font-medium">Tools the assistant may call</div>
          <div className="text-[10.5px] leading-relaxed text-muted-foreground">
            Applied on the next message — no restart. Tools that only make
            sense in the desktop app (terminal, screen, radio…) are never
            offered here.
          </div>
        </div>

        {TIER_ORDER.map((tier) => {
          const names = toolsInTier(tier);
          const on = names.filter((n) => allowed.has(n)).length;
          return (
            <div key={tier} className="border-t border-border/60 px-3 py-2">
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox
                  checked={on === names.length || (on > 0 ? "indeterminate" : false)}
                  onCheckedChange={(v) => toggleTier(tier, v === true)}
                  disabled={disabled}
                />
                <span className="text-[11.5px] font-medium">
                  {TIER_LABELS[tier]}
                </span>
                <Badge
                  variant="secondary"
                  className={cn(
                    "h-4 px-1.5 text-[9.5px] font-normal",
                    on === 0 && "text-muted-foreground",
                  )}
                >
                  {on}/{names.length}
                </Badge>
              </label>
              <div className="mt-0.5 pl-6 text-[10px] leading-snug text-muted-foreground">
                {TIER_HINTS[tier]}
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 pl-6">
                {TOOL_CATALOG.filter((t) => t.tier === tier).map((t) => (
                  <label
                    key={t.name}
                    title={t.blurb}
                    className="flex cursor-pointer items-center gap-1.5"
                  >
                    <Checkbox
                      checked={allowed.has(t.name)}
                      onCheckedChange={(v) => toggleTool(t.name, v === true)}
                      disabled={disabled}
                      className="h-3.5 w-3.5"
                    />
                    <span className="truncate font-mono text-[10.5px]">
                      {t.name}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}

        <div className="border-t border-border/60 px-3 py-2">
          <div className="text-[11.5px] font-medium">MCP servers</div>
          <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            Grant whole servers (all their current tools). Manage servers in
            Settings → MCP.
          </div>
          {servers.length === 0 ? (
            <div className="mt-1.5 pl-0.5 text-[10.5px] italic text-muted-foreground">
              No MCP servers installed.
            </div>
          ) : (
            <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1">
              {servers.map((s) => (
                <label
                  key={s.id}
                  title={`${s.transport}${s.enabled ? "" : " · disabled globally"}`}
                  className="flex cursor-pointer items-center gap-1.5"
                >
                  <Checkbox
                    checked={mcpAllowedServers.includes(s.id)}
                    onCheckedChange={(v) => toggleServer(s.id, v === true)}
                    disabled={disabled || !s.enabled}
                    className="h-3.5 w-3.5"
                  />
                  <span
                    className={cn(
                      "truncate text-[10.5px]",
                      !s.enabled && "text-muted-foreground line-through",
                    )}
                  >
                    {s.name}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
