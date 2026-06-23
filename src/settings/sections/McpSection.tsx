import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { newMcpServerId, type McpServerConfig, type McpTransport } from "@/modules/ai/lib/mcp";
import { useMcpStore } from "@/modules/ai/store/mcpStore";
import {
  Add01Icon,
  Delete02Icon,
  Edit02Icon,
  WifiConnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}

export function McpSection() {
  const mcpServers = useMcpStore((s) => s.servers);
  const mcpStatuses = useMcpStore((s) => s.statuses);
  const addMcpServer = useMcpStore((s) => s.addServer);
  const updateMcpServer = useMcpStore((s) => s.updateServer);
  const removeMcpServer = useMcpStore((s) => s.removeServer);
  const toggleMcpServer = useMcpStore((s) => s.toggleServer);
  const hydrateMcp = useMcpStore((s) => s.hydrate);

  useEffect(() => {
    void hydrateMcp();
  }, [hydrateMcp]);

  const [editingMcp, setEditingMcp] = useState<McpServerConfig | null>(null);

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="MCP Servers"
        description="Connect to external tool servers via the Model Context Protocol."
      />

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <Label>MCP Servers</Label>
            <span className="text-[10.5px] text-muted-foreground">
              Connect to external tool servers to expand the AI's capabilities.
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-[11px]"
            onClick={() =>
              setEditingMcp({
                id: newMcpServerId(),
                name: "",
                transport: "stdio",
                command: "",
                args: [],
                enabled: true,
              })
            }
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
            Add server
          </Button>
        </div>

        {mcpServers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-6 text-center text-[11px] text-muted-foreground">
            No MCP servers configured. Add one to give the AI access to external tools.
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {mcpServers.map((s) => {
              const st = mcpStatuses[s.id];
              const statusColor =
                st?.status === "connected"
                  ? "bg-emerald-500"
                  : st?.status === "connecting"
                    ? "bg-amber-500 animate-pulse"
                    : st?.status === "error"
                      ? "bg-destructive"
                      : "bg-muted-foreground/40";
              return (
                <li
                  key={s.id}
                  className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2"
                >
                  <span className={cn("size-1.5 shrink-0 rounded-full", statusColor)} />
                  <HugeiconsIcon
                    icon={WifiConnected01Icon}
                    size={13}
                    strokeWidth={1.75}
                    className="shrink-0 text-muted-foreground"
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12px] font-medium">
                      {s.name || s.command || s.url || "Unnamed server"}
                    </span>
                    <span className="truncate text-[10.5px] text-muted-foreground">
                      {s.transport}{st?.toolCount ? ` · ${st.toolCount} tools` : ""}
                      {st?.error ? ` · ${st.error}` : ""}
                    </span>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => toggleMcpServer(s.id)}
                    title={s.enabled ? "Disable" : "Enable"}
                  >
                    <span className={cn(
                      "size-3 rounded-sm border",
                      s.enabled
                        ? "border-foreground/60 bg-foreground/80"
                        : "border-muted-foreground/40",
                    )} />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => setEditingMcp(s)}
                    title="Edit"
                  >
                    <HugeiconsIcon icon={Edit02Icon} size={12} strokeWidth={1.75} />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    onClick={() => removeMcpServer(s.id)}
                    title="Delete"
                  >
                    <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <McpEditorDialog
        server={editingMcp}
        existing={mcpServers}
        onClose={() => setEditingMcp(null)}
        onSave={(s) => {
          const exists = mcpServers.some((x) => x.id === s.id);
          if (exists) updateMcpServer(s);
          else addMcpServer(s);
          setEditingMcp(null);
        }}
      />
    </div>
  );
}

function McpEditorDialog({
  server,
  existing,
  onClose,
  onSave,
}: {
  server: McpServerConfig | null;
  existing: McpServerConfig[];
  onClose: () => void;
  onSave: (s: McpServerConfig) => void;
}) {
  const [draft, setDraft] = useState<McpServerConfig | null>(server);
  useEffect(() => setDraft(server), [server]);
  if (!draft) return null;

  const isNew = !existing.some((s) => s.id === draft.id);
  const canSave =
    (draft.name.trim().length > 0) &&
    (draft.transport === "stdio"
      ? (draft.command?.trim().length ?? 0) > 0
      : (draft.url?.trim().length ?? 0) > 0);

  return (
    <Dialog open={!!server} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {isNew ? "Add MCP server" : "Edit MCP server"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 max-h-[60vh] overflow-y-auto pr-1 scrollbar-thin">
          <div className="flex gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <Label>Name</Label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="e.g. Filesystem, Database"
                className="h-8 text-[12px]"
              />
            </div>
            <div className="flex w-28 flex-col gap-1">
              <Label>Transport</Label>
              <select
                value={draft.transport}
                onChange={(e) => setDraft({ ...draft, transport: e.target.value as McpTransport })}
                className="h-8 rounded-md border border-border bg-background px-2 text-[12px] outline-none"
              >
                <option value="stdio">stdio</option>
                <option value="sse">SSE</option>
                <option value="http">HTTP</option>
              </select>
            </div>
          </div>
          {draft.transport === "stdio" ? (
            <>
              <div className="flex flex-col gap-1">
                <Label>Command</Label>
                <Input
                  value={draft.command ?? ""}
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  placeholder="e.g. npx, node, python"
                  className="h-8 font-mono text-[12px]"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label>Arguments</Label>
                <Input
                  value={(draft.args ?? []).join(" ")}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      args: e.target.value.split(/\s+/).filter(Boolean),
                    })
                  }
                  placeholder="e.g. -y @modelcontextprotocol/server-filesystem /path"
                  className="h-8 font-mono text-[12px]"
                />
              </div>
              <EnvVarsEditor
                env={draft.env ?? {}}
                onChange={(env) => setDraft({ ...draft, env })}
              />
            </>
          ) : (
            <div className="flex flex-col gap-1">
              <Label>URL</Label>
              <Input
                value={draft.url ?? ""}
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                placeholder="e.g. http://localhost:3000/mcp"
                className="h-8 font-mono text-[12px]"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSave}
            onClick={() => onSave(draft)}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EnvVarsEditor({
  env,
  onChange,
}: {
  env: Record<string, string>;
  onChange: (env: Record<string, string>) => void;
}) {
  const [rows, setRows] = useState<{ key: string; value: string }[]>(() =>
    Object.entries(env).map(([key, value]) => ({ key, value })),
  );

  const flush = (next: { key: string; value: string }[]) => {
    setRows(next);
    const record: Record<string, string> = {};
    for (const r of next) {
      if (r.key.trim()) record[r.key.trim()] = r.value;
    }
    onChange(record);
  };

  const addRow = () => flush([...rows, { key: "", value: "" }]);
  const updateKey = (idx: number, newKey: string) => {
    const next = rows.map((r, i) => (i === idx ? { ...r, key: newKey } : r));
    flush(next);
  };
  const updateValue = (idx: number, newValue: string) => {
    const next = rows.map((r, i) => (i === idx ? { ...r, value: newValue } : r));
    flush(next);
  };
  const removeRow = (idx: number) => {
    flush(rows.filter((_, i) => i !== idx));
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <Label>Environment Variables</Label>
        <button
          type="button"
          onClick={addRow}
          className="flex items-center gap-1 text-[10.5px] text-muted-foreground hover:text-foreground"
        >
          <HugeiconsIcon icon={Add01Icon} size={11} strokeWidth={2} />
          Add
        </button>
      </div>
      {rows.length === 0 ? (
        <span className="text-[10.5px] text-muted-foreground">
          No env vars. Click Add to set API keys or config.
        </span>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((row, idx) => (
            <div key={idx} className="flex items-center gap-1">
              <Input
                value={row.key}
                onChange={(e) => updateKey(idx, e.target.value)}
                placeholder="KEY"
                className="h-7 w-32 font-mono text-[11px]"
              />
              <Input
                type={row.key.toLowerCase().includes("key") || row.key.toLowerCase().includes("secret") || row.key.toLowerCase().includes("token") ? "password" : "text"}
                value={row.value}
                onChange={(e) => updateValue(idx, e.target.value)}
                placeholder="value"
                className="h-7 flex-1 font-mono text-[11px]"
              />
              <button
                type="button"
                onClick={() => removeRow(idx)}
                className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive"
              >
                <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
