import { cn } from "@/lib/utils";
import { useAgentOrchestratorStore } from "../store/agentOrchestratorStore";
import { motion } from "motion/react";
import { useCallback, useState } from "react";
import type { AgentType } from "../lib/agent-orchestrator";

const AGENT_TYPE_COLORS: Record<AgentType, string> = {
  codex: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  pi: "bg-green-500/20 text-green-400 border-green-500/30",
  hermes: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  claude: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  custom: "bg-muted/50 text-muted-foreground border-border/60",
};

const AGENT_TYPE_ICONS: Record<AgentType, string> = {
  codex: "🤖",
  pi: "🦊",
  hermes: "🦅",
  claude: "🤖",
  custom: "⚙️",
};

const AGENT_STATUS_COLORS: Record<AgentProcess["status"], string> = {
  idle: "bg-gray-500/20 text-gray-400",
  starting: "bg-yellow-500/20 text-yellow-400 animate-pulse",
  running: "bg-green-500/20 text-green-400",
  paused: "bg-orange-500/20 text-orange-400",
  completed: "bg-blue-500/20 text-blue-400",
  error: "bg-red-500/20 text-red-400",
  stopped: "bg-gray-500/20 text-gray-500",
};

const AGENT_MODE_BADGES: Record<AgentProcess["mode"], { label: string; color: string; icon: string }> = {
  orchestrator: { label: "ORCHESTRATOR", color: "bg-amber-500/20 text-amber-400 border-amber-500/30", icon: "👑" },
  worker: { label: "WORKER", color: "bg-sky-500/20 text-sky-400 border-sky-500/30", icon: "⚙️" },
  subagent: { label: "SUB-AGENT", color: "bg-violet-500/20 text-violet-400 border-violet-500/30", icon: "🔗" },
};

type AgentProcess = import("../lib/agent-orchestrator").AgentProcess;

export function AgentOrchestratorPanel({ onClose }: { onClose?: () => void }) {
  const agents = useAgentOrchestratorStore((s) => s.agents);
  const tasks = useAgentOrchestratorStore((s) => s.tasks);
  const spawnAgent = useAgentOrchestratorStore((s) => s.spawnAgent);
  const stopAgent = useAgentOrchestratorStore((s) => s.stopAgent);
  const sendToAgent = useAgentOrchestratorStore((s) => s.sendToAgent);

  const [newAgentType, setNewAgentType] = useState<AgentType>("codex");
  const [newAgentName, setNewAgentName] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [inputText, setInputText] = useState("");

  const handleSpawnAgent = useCallback(async () => {
    if (!newAgentName.trim()) return;
    
    await spawnAgent(
      newAgentType,
      newAgentName.trim(),
      process.cwd(),
      "worker",
    );
    
    setNewAgentName("");
  }, [newAgentType, newAgentName, spawnAgent]);

  const handleStopAgent = useCallback(async (id: string) => {
    await stopAgent(id);
  }, [stopAgent]);

  const handleSendToAgent = useCallback(async (id: string) => {
    if (!inputText.trim()) return;
    await sendToAgent(id, inputText);
    setInputText("");
  }, [inputText, sendToAgent]);

  const activeAgent = selectedAgentId ? agents.find((a) => a.id === selectedAgentId) : null;

  const activeAgentsCount = agents.filter((a) => a.status === "running").length;
  const pendingTasksCount = tasks.filter((t) => t.status === "pending").length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className={cn(
        "rounded-xl border border-border/60 bg-card text-[12px]",
        "shadow-[0_8px_24px_rgba(0,0,0,0.3)]",
        "ring-1 ring-black/5 dark:ring-white/5",
        "p-4",
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-border/60">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-foreground">
            Agent Orchestrator
          </h3>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-green-400 font-medium">
            Active: {activeAgentsCount}/{agents.length}
          </span>
          <span className="text-yellow-400 font-medium">
            Pending: {pendingTasksCount}
          </span>
          {onClose && (
            <button
              onClick={onClose}
              className="ml-2 px-2 py-1 text-[10px] rounded bg-muted hover:bg-muted/80 text-muted-foreground transition-colors"
            >
              Close
            </button>
          )}
        </div>
      </div>

      {/* Spawn New Agent */}
      <div className="mb-4 p-3 rounded-lg bg-muted/40 border border-border/40">
        <p className="text-muted-foreground mb-2 text-[11px] font-medium">
          Spawn New Agent
        </p>
        <div className="flex gap-2">
          <select
            value={newAgentType}
            onChange={(e) => setNewAgentType(e.target.value as AgentType)}
            className="bg-card text-foreground px-2.5 py-1.5 rounded-md border border-border/60 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="codex">Codex</option>
            <option value="pi">Pi</option>
            <option value="hermes">Hermes</option>
            <option value="claude">Claude</option>
            <option value="custom">Custom</option>
          </select>
          <input
            type="text"
            value={newAgentName}
            onChange={(e) => setNewAgentName(e.target.value)}
            placeholder="Agent name"
            className="flex-1 bg-card text-foreground px-2.5 py-1.5 rounded-md border border-border/60 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground"
          />
          <button
            onClick={handleSpawnAgent}
            className="px-3 py-1.5 bg-primary/80 hover:bg-primary text-primary-foreground rounded-md text-xs font-medium transition-colors"
          >
            Spawn
          </button>
        </div>
      </div>

      {/* Agent List */}
      <div className="mb-4">
        <p className="text-muted-foreground mb-2 text-[11px] font-medium">
          Active Agents
        </p>
        <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
          {agents.length === 0 ? (
            <p className="text-muted-foreground italic text-xs py-2">
              No agents running...
            </p>
          ) : (
            agents.map((agent) => (
              <div
                key={agent.id}
                onClick={() => setSelectedAgentId(agent.id)}
                className={cn(
                  "p-2.5 rounded-lg border cursor-pointer transition-all",
                  AGENT_TYPE_COLORS[agent.type],
                  selectedAgentId === agent.id && "ring-2 ring-primary/50",
                  "hover:opacity-90",
                )}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs">{AGENT_TYPE_ICONS[agent.type]}</span>
                    <span className="font-medium text-[11px]">{agent.name}</span>
                    <span className="text-[10px] opacity-70">({agent.type})</span>
                    {/* Mode Badge */}
                    <span
                      className={cn(
                        "px-1.5 py-0.5 rounded text-[9px] font-bold border flex items-center gap-0.5",
                        AGENT_MODE_BADGES[agent.mode].color,
                      )}
                      title={`${agent.mode.charAt(0).toUpperCase() + agent.mode.slice(1)} agent`}
                    >
                      <span>{AGENT_MODE_BADGES[agent.mode].icon}</span>
                      <span>{AGENT_MODE_BADGES[agent.mode].label}</span>
                    </span>
                  </div>
                  <span
                    className={cn(
                      "px-1.5 py-0.5 rounded text-[10px] font-medium",
                      AGENT_STATUS_COLORS[agent.status],
                    )}
                  >
                    {agent.status}
                  </span>
                </div>
                <div className="text-[10px] opacity-70 mt-1 truncate">
                  {agent.cwd}
                </div>
                {agent.status === "running" && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleStopAgent(agent.id);
                    }}
                    className="mt-2 px-2 py-0.5 bg-destructive/20 hover:bg-destructive/30 text-destructive rounded text-[10px] transition-colors"
                  >
                    Stop
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Agent Details Panel */}
      {activeAgent && (
        <div className="mb-4 p-3 rounded-lg bg-muted/40 border border-border/40">
          <h4 className="font-medium text-foreground mb-2 text-xs">
            {activeAgent.name} Details
          </h4>
          
          <div className="grid grid-cols-2 gap-2 text-xs mb-3">
            <div>
              <span className="text-muted-foreground">Type:</span>{" "}
              <span className="text-foreground">{activeAgent.type}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Status:</span>{" "}
              <span className={cn("font-medium", AGENT_STATUS_COLORS[activeAgent.status])}>
                {activeAgent.status}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Mode:</span>{" "}
              <span className="text-foreground">{activeAgent.mode}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Started:</span>{" "}
              <span className="text-foreground font-mono">
                {activeAgent.startedAt
                  ? new Date(activeAgent.startedAt).toLocaleTimeString()
                  : "N/A"}
              </span>
            </div>
          </div>

          <div className="mb-3">
            <p className="text-muted-foreground text-xs mb-1">Recent Logs:</p>
            <div className="bg-card/50 p-2 rounded max-h-24 overflow-y-auto text-[10px] font-mono text-muted-foreground border border-border/40">
              {activeAgent.logs.slice(-5).map((log, i) => (
                <div key={i} className="truncate">
                  {log}
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Send message to agent..."
              className="flex-1 bg-card text-foreground px-2.5 py-1.5 rounded-md border border-border/60 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleSendToAgent(activeAgent.id);
                }
              }}
            />
            <button
              onClick={() => void handleSendToAgent(activeAgent.id)}
              className="px-3 py-1.5 bg-primary/80 hover:bg-primary text-primary-foreground rounded-md text-xs font-medium transition-colors"
            >
              Send
            </button>
          </div>
        </div>
      )}

      {/* Tasks Section */}
      {tasks.length > 0 && (
        <div>
          <p className="text-muted-foreground mb-2 text-[11px] font-medium">
            Tasks
          </p>
          <div className="space-y-2">
            {tasks.map((task) => (
              <div
                key={task.id}
                className="p-2 rounded-lg bg-muted/40 border border-border/40"
              >
                <div className="flex items-center justify-between">
                  <span className="text-foreground text-xs">{task.description}</span>
                  <span
                    className={cn(
                      "px-1.5 py-0.5 rounded text-[10px] font-medium",
                      task.status === "completed"
                        ? "bg-green-500/20 text-green-400"
                        : task.status === "failed"
                          ? "bg-red-500/20 text-red-400"
                          : "bg-yellow-500/20 text-yellow-400",
                    )}
                  >
                    {task.status}
                  </span>
                </div>
                {task.assignedTo && (
                  <div className="text-[10px] text-muted-foreground mt-1">
                    Assigned to: {task.assignedTo}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
}
