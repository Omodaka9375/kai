import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { startAgentLogStreaming } from "./agentLogStream";

export type AgentType = "codex" | "pi" | "hermes" | "claude" | "custom";

export type AgentStatus =
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "completed"
  | "error"
  | "stopped";

export type AgentMode =
  | "orchestrator" // Main coordinator agent
  | "worker" // Worker agent doing specific tasks
  | "subagent" // Sub-agent spawned by another agent

export type AgentTask = {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  assignedTo?: string; // Agent ID
  result?: string;
  createdAt: string;
  completedAt?: string;
};

export type AgentProcess = {
  id: string;
  type: AgentType;
  name: string;
  status: AgentStatus;
  mode: AgentMode;
  pid?: number;
  surfaceId?: number; // For tmux/cmux integration
  cwd: string;
  command: string;
  logs: string[];
  lastOutput: string;
  createdAt: string;
  startedAt?: string;
  stoppedAt?: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

export type AgentRegistry = {
  agents: AgentProcess[];
  tasks: AgentTask[];
  activeOrchestratorId: string | null;
};

const ORCHESTRATOR_EVENT = "Kai://agent-orchestrator-update";

/** Generate unique agent ID. */
export function generateAgentId(): string {
  return `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Generate unique task ID. */
export function generateTaskId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Build command for different agent types. */
export function buildAgentCommand(
  type: AgentType,
  _cwd: string,
  customCommand?: string,
): string {
  if (customCommand) return customCommand;

  switch (type) {
    case "codex":
      return `codex --yolo`;
    case "pi":
      return `pi`;
    case "hermes":
      return `hermes`;
    case "claude":
      return `claude --print --permission-mode bypassPermissions`;
    case "custom":
      return "bash"; // Default fallback
    default:
      return "bash";
  }
}

/** Spawn an agent process using bash_background. */
export async function spawnAgent(
  type: AgentType,
  name: string,
  cwd: string,
  mode: AgentMode = "worker",
  customCommand?: string,
): Promise<AgentProcess> {
  const id = generateAgentId();
  const command = buildAgentCommand(type, cwd, customCommand);

  const agent: AgentProcess = {
    id,
    type,
    name,
    status: "starting",
    mode,
    cwd,
    command,
    logs: [`[${new Date().toISOString()}] Starting ${type} agent: ${name}`],
    lastOutput: "",
    createdAt: new Date().toISOString(),
  };

  try {
    // Spawn as background process
    const handle = await invoke<number>("shell_bg_spawn", {
      command,
      cwd,
      name: `kai-agent-${name}`,
    });

    agent.pid = handle;
    agent.status = "running";
    agent.startedAt = new Date().toISOString();
    agent.logs.push(`[${new Date().toISOString()}] Process started with PID ${handle}`);

    // Start listening to logs using the new streaming service
    startAgentLogStreaming(handle);

    // Emit update
    await emit(ORCHESTRATOR_EVENT, { type: "agent-spawned", agent });

    return agent;
  } catch (error) {
    agent.status = "error";
    agent.error = String(error);
    agent.logs.push(`[${new Date().toISOString()}] Error: ${String(error)}`);
    throw error;
  }
}

/** Stop an agent process. */
export async function stopAgent(agentId: string): Promise<void> {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  if (agent.pid) {
    await invoke("shell_bg_kill", { handle: agent.pid });
  }

  agent.status = "stopped";
  agent.stoppedAt = new Date().toISOString();
  agent.logs.push(`[${new Date().toISOString()}] Agent stopped`);

  await emit(ORCHESTRATOR_EVENT, { type: "agent-stopped", agentId });
}

/** Send input to an agent. */
export async function sendToAgent(agentId: string, input: string): Promise<void> {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  if (agent.surfaceId) {
    // Send to tmux surface
    await invoke("cmux_send", {
      surface: agent.surfaceId,
      text: input,
    });
    await invoke("cmux_send_key", {
      surface: agent.surfaceId,
      key: "enter",
    });
  } else if (agent.pid) {
    // Try to write to process (may not work for all agents)
    await invoke("shell_session_run", {
      command: input,
      sessionId: agent.id,
    });
  }

  agent.logs.push(`[${new Date().toISOString()}] Sent: ${input}`);
}

/** Get agent by ID. */
export async function getAgent(id: string): Promise<AgentProcess | null> {
  // This would typically query from a store or state management
  // For now, we'll use a simple in-memory approach
  const agents = await listAgents();
  return agents.find((a) => a.id === id) ?? null;
}

/** List all agents. */
export async function listAgents(): Promise<AgentProcess[]> {
  // This would query from persistent storage
  // For now, return empty array - actual implementation would use Zustand store
  return [];
}

/** Create a new task. */
export function createTask(
  description: string,
  assignedTo?: string,
): AgentTask {
  return {
    id: generateTaskId(),
    description,
    status: "pending",
    assignedTo,
    createdAt: new Date().toISOString(),
  };
}

/** Assign task to agent. */
export async function assignTask(
  taskId: string,
  agentId: string,
): Promise<void> {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  await sendToAgent(agentId, `Task: ${taskId}\nPlease work on this task.`);

  // Update task status
  // This would update the task in persistent storage
}

/** Delegate task to another agent. */
export async function delegateTask(
  _fromAgentId: string,
  toAgentId: string,
  taskDescription: string,
): Promise<void> {
  const toAgent = await getAgent(toAgentId);
  if (!toAgent) throw new Error(`Agent ${toAgentId} not found`);

  const delegationMessage = `
## DELEGATED TASK

The orchestrator has assigned you this task:

${taskDescription}

Please work on this and report back when complete.
`;

  await sendToAgent(toAgentId, delegationMessage);
}

/**
 * Create a delegation skill that can be used by the main agent
 * to delegate tasks to other agents.
 */
export function getDelegationInstructions(
  availableAgents: { id: string; name: string; type: AgentType; status: AgentStatus }[],
): string {
  const agentList = availableAgents
    .map((a) => `- **${a.name}** (${a.type}): ${a.status}`)
    .join("\n");

  return `
## AGENT DELEGATION

You have access to the following agents for task delegation:

${agentList}

### How to Delegate

When you need help with a specific task, use the \`delegate_task\` tool:

1. **Choose the right agent**:
   - **Codex**: Best for complex coding tasks, migrations, refactoring
   - **Pi**: Great for frontend, design, UI work
   - **Hermes**: Good for autonomous multi-step tasks
   - **Claude**: Deep integration, good for code review

2. **Provide clear instructions**:
   - What needs to be done
   - Success criteria
   - Any constraints or requirements

3. **Monitor progress**:
   - Check agent status periodically
   - Review results when complete

### Delegation Best Practices

- Delegate one task at a time to each agent
- Provide clear, specific instructions
- Include validation criteria when possible
- Wait for completion before assigning new tasks
- Review results before accepting as complete
`;
}

/** Get orchestrator status. */
export async function getOrchestratorStatus(): Promise<{
  totalAgents: number;
  activeAgents: number;
  pendingTasks: number;
}> {
  const agents = await listAgents();
  const active = agents.filter((a) => a.status === "running").length;

  return {
    totalAgents: agents.length,
    activeAgents: active,
    pendingTasks: 0, // Would need task tracking
  };
}
