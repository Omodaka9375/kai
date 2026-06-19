import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { AGENT_ICONS } from "@/modules/ai/components/AgentSwitcher";
import {
  BUILTIN_AGENTS,
  type Agent,
  type AgentIconId,
} from "@/modules/ai/lib/agents";
import { newMcpServerId, type McpServerConfig, type McpTransport } from "@/modules/ai/lib/mcp";
import {
  isValidHandle,
  normalizeHandle,
  type Snippet,
} from "@/modules/ai/lib/snippets";
import { newAgentId, useAgentsStore } from "@/modules/ai/store/agentsStore";
import { useMcpStore } from "@/modules/ai/store/mcpStore";
import {
  newSnippetId,
  useSnippetsStore,
} from "@/modules/ai/store/snippetsStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setCustomInstructions } from "@/modules/settings/store";
import {
  Add01Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  Edit02Icon,
  SparklesIcon,
  WifiConnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

const ICON_OPTIONS: AgentIconId[] = [
  "coder",
  "architect",
  "reviewer",
  "security",
  "designer",
  "spark",
];

export function AgentsSection() {
  const customInstructions = usePreferencesStore((s) => s.customInstructions);
  const customAgents = useAgentsStore((s) => s.customAgents);
  const activeAgentId = useAgentsStore((s) => s.activeId);
  const setActiveAgentId = useAgentsStore((s) => s.setActiveId);
  const upsertAgent = useAgentsStore((s) => s.upsert);
  const removeAgent = useAgentsStore((s) => s.remove);
  const hydrateAgents = useAgentsStore((s) => s.hydrate);

  const allAgents = useMemo(() => {
    return BUILTIN_AGENTS.map((b) => {
      const overridden = customAgents.find((c) => c.id === b.id);
      return overridden ? { ...overridden, builtIn: true } : b;
    }).concat(customAgents.filter((c) => !BUILTIN_AGENTS.some((b) => b.id === c.id)));
  }, [customAgents]);

  const snippets = useSnippetsStore((s) => s.snippets);
  const upsertSnippet = useSnippetsStore((s) => s.upsert);
  const removeSnippet = useSnippetsStore((s) => s.remove);
  const hydrateSnippets = useSnippetsStore((s) => s.hydrate);

  const mcpServers = useMcpStore((s) => s.servers);
  const mcpStatuses = useMcpStore((s) => s.statuses);
  const addMcpServer = useMcpStore((s) => s.addServer);
  const updateMcpServer = useMcpStore((s) => s.updateServer);
  const removeMcpServer = useMcpStore((s) => s.removeServer);
  const toggleMcpServer = useMcpStore((s) => s.toggleServer);
  const hydrateMcp = useMcpStore((s) => s.hydrate);

  useEffect(() => {
    void hydrateAgents();
    void hydrateSnippets();
    void hydrateMcp();
  }, [hydrateAgents, hydrateSnippets, hydrateMcp]);

  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
  const [editingMcp, setEditingMcp] = useState<McpServerConfig | null>(null);

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="Agents"
        description="Personas and snippets the AI uses. Switch agents from the input bar."
      />

      <CustomInstructionsBlock value={customInstructions} />

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label>Agents</Label>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-[11px]"
            onClick={() =>
              setEditingAgent({
                id: newAgentId(),
                name: "New agent",
                description: "",
                instructions: "",
                icon: "spark",
                builtIn: false,
              })
            }
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
            New agent
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {allAgents.map((a) => {
            const isOverridden = a.builtIn && customAgents.some((c) => c.id === a.id);
            return (
              <AgentCard
                key={a.id}
                agent={a}
                active={a.id === activeAgentId}
                onActivate={() => setActiveAgentId(a.id)}
                onEdit={() => setEditingAgent(a)}
                onDelete={a.builtIn ? (isOverridden ? () => removeAgent(a.id) : null) : () => removeAgent(a.id)}
                isReset={a.builtIn && isOverridden}
              />
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <Label>Snippets</Label>
            <span className="text-[10.5px] text-muted-foreground">
              Reusable instructions you can drop into any prompt with{" "}
              <code className="rounded bg-muted/50 px-1 font-mono">
                #handle
              </code>
              .
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-[11px]"
            onClick={() =>
              setEditingSnippet({
                id: newSnippetId(),
                handle: "",
                name: "",
                description: "",
                content: "",
              })
            }
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
            New snippet
          </Button>
        </div>

        {snippets.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-6 text-center text-[11px] text-muted-foreground">
            No snippets yet. Create one and insert it with{" "}
            <code className="font-mono">#handle</code> in the AI input.
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {snippets.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2"
              >
                <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                  #{s.handle}
                </code>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12px] font-medium">
                    {s.name}
                  </span>
                  {s.description ? (
                    <span className="truncate text-[10.5px] text-muted-foreground">
                      {s.description}
                    </span>
                  ) : null}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => setEditingSnippet(s)}
                  title="Edit"
                >
                  <HugeiconsIcon
                    icon={Edit02Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 text-muted-foreground hover:text-destructive"
                  onClick={() => removeSnippet(s.id)}
                  title="Delete"
                >
                  <HugeiconsIcon
                    icon={Delete02Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* MCP Servers */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <Label>MCP Servers</Label>
            <span className="text-[10.5px] text-muted-foreground">
              Connect to external tool servers via the Model Context Protocol.
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

      <AgentEditorDialog
        agent={editingAgent}
        existing={customAgents}
        onClose={() => setEditingAgent(null)}
        onSave={(a) => {
          upsertAgent(a);
          setEditingAgent(null);
        }}
      />
      <SnippetEditorDialog
        snippet={editingSnippet}
        existing={snippets}
        mcpServers={mcpServers}
        onClose={() => setEditingSnippet(null)}
        onSave={(s) => {
          upsertSnippet(s);
          setEditingSnippet(null);
        }}
      />
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

function AgentCard({
  agent,
  active,
  onActivate,
  onEdit,
  onDelete,
  isReset,
}: {
  agent: Agent;
  active: boolean;
  onActivate: () => void;
  onEdit: (() => void) | null;
  onDelete: (() => void) | null;
  isReset?: boolean;
}) {
  const Icon = AGENT_ICONS[agent.icon] ?? SparklesIcon;
  return (
    <div
      className={cn(
        "group relative flex flex-col gap-1.5 rounded-lg border bg-card/60 px-3 py-2.5 transition-colors",
        active
          ? "border-foreground/30 ring-1 ring-foreground/10"
          : "border-border/60 hover:border-border",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/40">
          <HugeiconsIcon icon={Icon} size={14} strokeWidth={1.5} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
            {agent.name}
            {agent.builtIn ? (
              <span className="rounded bg-muted/50 px-1 py-0.5 text-[9px] tracking-wide text-muted-foreground uppercase">
                {isReset ? "Customized" : "Built-in"}
              </span>
            ) : null}
          </span>
          <span className="line-clamp-2 text-[10.5px] leading-relaxed text-muted-foreground">
            {agent.description}
          </span>
        </div>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-1">
        <Button
          size="sm"
          variant={active ? "default" : "outline"}
          onClick={onActivate}
          className="h-6 gap-1 px-2 text-[10.5px]"
        >
          {active ? (
            <>
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                size={10}
                strokeWidth={2}
              />
              Active
            </>
          ) : (
            "Use agent"
          )}
        </Button>
        <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {onEdit ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              onClick={onEdit}
              title="Edit"
            >
              <HugeiconsIcon icon={Edit02Icon} size={11} strokeWidth={1.75} />
            </Button>
          ) : null}
          {onDelete ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-6 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
              title={isReset ? "Reset to default" : "Delete"}
            >
              <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.75} />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AgentEditorDialog({
  agent,
  existing,
  onClose,
  onSave,
}: {
  agent: Agent | null;
  existing: Agent[];
  onClose: () => void;
  onSave: (a: Agent) => void;
}) {
  const [draft, setDraft] = useState<Agent | null>(agent);
  useEffect(() => setDraft(agent), [agent]);
  if (!draft) return null;

  const isNew = !existing.some((a) => a.id === draft.id);
  const canSave =
    draft.name.trim().length > 0 && draft.instructions.trim().length > 0;

  return (
    <Dialog open={!!agent} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {isNew ? "New agent" : "Edit agent"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 max-h-[60vh] overflow-y-auto pr-1 scrollbar-thin">
          <div className="flex gap-2">
            <div className="flex flex-col gap-1">
              <Label>Icon</Label>
              <div className="flex flex-wrap gap-1">
                {ICON_OPTIONS.map((id) => {
                  const Icon = AGENT_ICONS[id] ?? SparklesIcon;
                  const active = draft.icon === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setDraft({ ...draft, icon: id })}
                      className={cn(
                        "flex size-7 items-center justify-center rounded-md border transition-colors",
                        active
                          ? "border-foreground/40 bg-accent"
                          : "border-border/60 hover:bg-accent/40",
                      )}
                    >
                      <HugeiconsIcon icon={Icon} size={13} strokeWidth={1.75} />
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <Label>Name</Label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="h-8 text-[12px]"
                placeholder="e.g. Test Engineer"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Description</Label>
            <Input
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
              placeholder="One line — shown in the agent picker"
              className="h-8 text-[12px]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Instructions</Label>
            <Textarea
              value={draft.instructions}
              onChange={(e) =>
                setDraft({ ...draft, instructions: e.target.value })
              }
              placeholder="Persona & rules. Appended to Kai's core system prompt."
              className="min-h-40 resize-y text-[12px] leading-relaxed"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSave}
            onClick={() => onSave({ ...draft, builtIn: false })}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SnippetEditorDialog({
  snippet,
  existing,
  mcpServers,
  onClose,
  onSave,
}: {
  snippet: Snippet | null;
  existing: Snippet[];
  mcpServers: McpServerConfig[];
  onClose: () => void;
  onSave: (s: Snippet) => void;
}) {
  const [draft, setDraft] = useState<Snippet | null>(snippet);
  useEffect(() => setDraft(snippet), [snippet]);
  if (!draft) return null;

  const handleErr = !draft.handle
    ? "Required."
    : !isValidHandle(draft.handle)
      ? "Lowercase letters, digits, and dashes only."
      : existing.some((s) => s.id !== draft.id && s.handle === draft.handle)
        ? "Already in use."
        : null;
  const canSave =
    !handleErr &&
    draft.name.trim().length > 0 &&
    draft.content.trim().length > 0;

  return (
    <Dialog open={!!snippet} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {existing.some((s) => s.id === draft.id)
              ? "Edit snippet"
              : "New snippet"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 max-h-[60vh] overflow-y-auto pr-1 scrollbar-thin">
          <div className="flex gap-2">
            <div className="flex w-32 flex-col gap-1">
              <Label>Handle</Label>
              <div className="relative">
                <span className="absolute top-1/2 left-2 -translate-y-1/2 font-mono text-[11.5px] text-muted-foreground">
                  #
                </span>
                <Input
                  value={draft.handle}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      handle: normalizeHandle(e.target.value),
                    })
                  }
                  placeholder="review"
                  className="h-8 pl-5 font-mono text-[11.5px]"
                />
              </div>
              {handleErr ? (
                <span className="text-[10px] text-destructive">
                  {handleErr}
                </span>
              ) : null}
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <Label>Name</Label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="e.g. Pre-merge review checklist"
                className="h-8 text-[12px]"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Description</Label>
            <Input
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
              placeholder="One line — shown in the # picker"
              className="h-8 text-[12px]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Content</Label>
            <Textarea
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              placeholder="Inserted into the prompt as a <snippet> block when you use #handle."
              className="min-h-40 max-h-64 resize-y overflow-y-auto break-words font-mono text-[11.5px] leading-relaxed"
            />
          </div>
          {mcpServers.length > 0 && (
            <div className="flex flex-col gap-1">
              <Label>MCP Servers</Label>
              <div className="flex flex-wrap gap-1.5">
                {mcpServers.map((s) => {
                  const active = draft.mcpServerIds?.includes(s.id) ?? false;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        const ids = draft.mcpServerIds ?? [];
                        const next = active
                          ? ids.filter((id) => id !== s.id)
                          : [...ids, s.id];
                        setDraft({ ...draft, mcpServerIds: next });
                      }}
                      className={cn(
                        "rounded-md border px-2 py-1 text-[11px] transition-colors",
                        active
                          ? "border-foreground/40 bg-accent font-medium"
                          : "border-border/60 text-muted-foreground hover:bg-accent/40",
                      )}
                    >
                      {s.name || "Unnamed"}
                    </button>
                  );
                })}
              </div>
              <span className="text-[10px] text-muted-foreground">
                Select servers whose tools should activate when this skill is used.
              </span>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => onSave(draft)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  // Use array state internally so duplicate/empty keys don't collide.
  const [rows, setRows] = useState<{ key: string; value: string }[]>(() =>
    Object.entries(env).map(([key, value]) => ({ key, value })),
  );

  // Sync rows → parent Record on every change (filtering empty keys).
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

function CustomInstructionsBlock({ value }: { value: string }) {
  const [draft, setDraft] = useState(value);
  const hadFirstSync = useRef(false);

  useEffect(() => {
    if (!hadFirstSync.current) {
      hadFirstSync.current = true;
      setDraft(value);
    }
  }, [value]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>Custom instructions</Label>
        {/* {savedTick > 0 ? (
          <span className="text-[10px] text-muted-foreground">Saved</span>
        ) : null} */}
        {draft && (
          <Button size="xs" onClick={() => void setCustomInstructions(draft)}>
            Save
          </Button>
        )}
      </div>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="e.g. Always reply in concise bullet points. Prefer pnpm over npm. My machine is an M-series Mac."
        className="min-h-[100px] resize-y bg-card/60 font-sans text-[12px] leading-relaxed border border-border"
      />
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
