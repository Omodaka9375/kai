import { create } from "zustand";
import { emit, listen } from "@tauri-apps/api/event";
import { native } from "../lib/native";
import type { AgentProcess, AgentTask, AgentType } from "../lib/agent-orchestrator";
import { generateAgentId, generateTaskId } from "../lib/agent-orchestrator";

const CHANGED_EVENT = "Kai://agent-orchestrator-changed";
const ORCHESTRATOR_EVENT = "Kai://agent-orchestrator-update";
const PERSISTENCE_FILE = "kai-agent-orchestrator.json";

type AgentOrchestratorState = {
  hydrated: boolean;
  agents: AgentProcess[];
  tasks: AgentTask[];
  activeOrchestratorId: string | null;
  
  // Actions
  hydrate: () => Promise<void>;
  spawnAgent: (
    type: AgentType,
    name: string,
    cwd: string,
    mode?: "orchestrator" | "worker" | "subagent",
    customCommand?: string,
  ) => Promise<AgentProcess>;
  stopAgent: (id: string) => Promise<void>;
  removeAgent: (id: string) => void;
  sendToAgent: (id: string, input: string) => Promise<void>;
  createTask: (description: string, assignedTo?: string) => AgentTask;
  updateTask: (taskId: string, updates: Partial<AgentTask>) => void;
  setOrchestrator: (id: string | null) => void;
  updateAgentStatus: (id: string, status: AgentProcess["status"]) => void;
  updateAgentLogs: (id: string, logs: string[]) => void;
  // Persistence
  saveToDisk: () => Promise<void>;
  loadFromDisk: () => Promise<void>;
};

let initialized = false;

export const useAgentOrchestratorStore = create<AgentOrchestratorState>((set, get) => ({
  hydrated: false,
  agents: [],
  tasks: [],
  activeOrchestratorId: null,
  
  hydrate: async () => {
    if (initialized) return;
    initialized = true;

    // Listen for orchestrator events
    void listen(ORCHESTRATOR_EVENT, (_event) => {
      // Event handling would go here
    });

    // Load from disk on startup
    await get().loadFromDisk();
    set({ hydrated: true });
  },
  
  spawnAgent: async (type, name, cwd, mode = "worker", customCommand) => {
    const id = generateAgentId();
    const now = new Date().toISOString();

    const agent: AgentProcess = {
      id,
      type,
      name,
      status: "starting",
      mode,
      cwd,
      command: customCommand || buildCommand(type, cwd),
      logs: [`[${now}] Starting ${type} agent: ${name}`],
      lastOutput: "",
      createdAt: now,
    };
    
    set((state) => ({
      agents: [...state.agents, agent],
      activeOrchestratorId: mode === "orchestrator" ? id : state.activeOrchestratorId,
    }));
    
    // Persist to disk
    await get().saveToDisk();
    void emit(CHANGED_EVENT);
    return agent;
  },
  
  stopAgent: async (id) => {
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === id ? { ...a, status: "stopped", stoppedAt: new Date().toISOString() } : a,
      ),
    }));
    await get().saveToDisk();
    void emit(CHANGED_EVENT);
  },
  
  removeAgent: (id) => {
    set((state) => ({
      agents: state.agents.filter((a) => a.id !== id),
      activeOrchestratorId: state.activeOrchestratorId === id ? null : state.activeOrchestratorId,
    }));
    void get().saveToDisk();
    void emit(CHANGED_EVENT);
  },
  
  sendToAgent: async (id, input) => {
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === id
          ? {
              ...a,
              logs: [...a.logs, `[${new Date().toISOString()}] Sent: ${input}`],
            }
          : a,
      ),
    }));
    await get().saveToDisk();
    void emit(CHANGED_EVENT);
  },
  
  createTask: (description, assignedTo) => {
    const task: AgentTask = {
      id: generateTaskId(),
      description,
      status: "pending",
      assignedTo,
      createdAt: new Date().toISOString(),
    };
    
    set((state) => ({
      tasks: [...state.tasks, task],
    }));
    void get().saveToDisk();
    void emit(CHANGED_EVENT);
    return task;
  },
  
  updateTask: (taskId, updates) => {
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId ? { ...t, ...updates, completedAt: updates.status ? new Date().toISOString() : t.completedAt } : t,
      ),
    }));
    void get().saveToDisk();
    void emit(CHANGED_EVENT);
  },
  
  setOrchestrator: (id) => {
    set({ activeOrchestratorId: id });
    void get().saveToDisk();
    void emit(CHANGED_EVENT);
  },
  
  updateAgentStatus: (id, status) => {
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === id ? { ...a, status } : a,
      ),
    }));
    void get().saveToDisk();
    void emit(CHANGED_EVENT);
  },
  
  updateAgentLogs: (id, logs) => {
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === id ? { ...a, logs } : a,
      ),
    }));
    void get().saveToDisk();
    void emit(CHANGED_EVENT);
  },
  
  saveToDisk: async () => {
    try {
      const state = get();
      const data = JSON.stringify({
        agents: state.agents,
        tasks: state.tasks,
        activeOrchestratorId: state.activeOrchestratorId,
        lastUpdated: new Date().toISOString(),
      }, null, 2);
      
      // Get workspace root for persistence path
      const workspaceRoot = await native.workspaceCurrentDir();
      const persistPath = `${workspaceRoot}/${PERSISTENCE_FILE}`;
      
      await native.writeFile(persistPath, data);
    } catch (error) {
      console.warn("[AgentOrchestrator] Failed to save to disk:", error);
    }
  },
  
  loadFromDisk: async () => {
    try {
      const workspaceRoot = await native.workspaceCurrentDir();
      const persistPath = `${workspaceRoot}/${PERSISTENCE_FILE}`;
      
      const result = await native.readFile(persistPath);
      if (result.kind === "text") {
        const data = JSON.parse(result.content);
        set({
          agents: data.agents || [],
          tasks: data.tasks || [],
          activeOrchestratorId: data.activeOrchestratorId || null,
        });
      }
    } catch (error) {
      // File doesn't exist or parse error - start fresh
      console.debug("[AgentOrchestrator] No persisted data found, starting fresh");
    }
  },
}));

function buildCommand(type: AgentType, _cwd: string): string {
  switch (type) {
    case "codex":
      return "codex --yolo";
    case "pi":
      return "pi";
    case "hermes":
      return "hermes";
    case "claude":
      return "claude --print --permission-mode bypassPermissions";
    default:
      return "bash";
  }
}
