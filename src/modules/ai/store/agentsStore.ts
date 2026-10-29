import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  BUILTIN_AGENTS,
  loadAgents,
  newAgentId,
  NONE_AGENT_ID,
  saveActiveAgentId,
  saveActiveAgentIdFor,
  saveCustomAgents,
  type Agent,
} from "../lib/agents";
import { setProjectModel, getActiveProjectRuntime, useChatStore } from "./chatStore";
import { setSessionPreferences } from "./sessionPreferences";

const CHANGED_EVENT = "Kai://ai-agents-changed";

type AgentsState = {
  hydrated: boolean;
  customAgents: Agent[];
  activeId: string;
  /** Current workspace root (normalized, forward-slash) for per-project selection. */
  root: string | null;
  /** All agents, builtin first. */
  all: () => Agent[];
  hydrate: () => Promise<void>;
  /** Track the open project; applies its saved agent (legacy global as fallback). */
  setRoot: (root: string | null) => void;
  setActiveId: (id: string) => void;
  upsert: (agent: Agent) => void;
  remove: (id: string) => void;
};

let initialized = false;

function broadcast(): void {
  void emit(CHANGED_EVENT);
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  hydrated: false,
  customAgents: [],
  activeId: NONE_AGENT_ID,
  root: null,
  all: () => [...BUILTIN_AGENTS, ...get().customAgents],
  hydrate: async () => {
    if (initialized) return;
    initialized = true;
    const { custom, activeId, activeAgentIds } = await loadAgents();
    // Apply the current project's saved agent on hydrate (root may already be set).
    const root = get().root;
    const perProject = root ? activeAgentIds[root] : undefined;
    set({
      customAgents: custom,
      activeId: perProject ?? activeId,
      hydrated: true,
    });

    void listen(CHANGED_EVENT, async () => {
      const fresh = await loadAgents();
      // Remote change (e.g. another window): prefer this window's per-project
      // entry, then the legacy global the other window just wrote.
      const r = get().root;
      const saved = r ? fresh.activeAgentIds[r] : undefined;
      set({
        customAgents: fresh.custom,
        activeId: saved ?? fresh.activeId,
      });
    });
  },
  setRoot: (root) => {
    if (get().root === root) return;
    set({ root });
    // Re-apply the new project's saved agent; legacy global as fallback.
    void loadAgents().then(({ activeAgentIds, activeId }) => {
      if (get().root !== root) return; // switched again while loading
      const saved = root ? activeAgentIds[root] : undefined;
      set({ activeId: saved ?? activeId });
    });
  },
  setActiveId: (id) => {
    const sessionId = useChatStore.getState().activeSessionId;
    if (sessionId) setSessionPreferences(sessionId, { personaId: id });
    set({ activeId: id });
    const project = getActiveProjectRuntime();
    if (project) {
      setProjectModel(project.id, useChatStore.getState().selectedModelId, id);
    }
    const root = get().root;
    if (root) {
      void saveActiveAgentIdFor(root, id).then(broadcast);
    } else {
      void saveActiveAgentId(id).then(broadcast);
    }
  },
  upsert: (agent) => {
    if (agent.builtIn) return;
    const list = get().customAgents;
    const idx = list.findIndex((a) => a.id === agent.id);
    const next =
      idx === -1 ? [...list, agent] : list.map((a) => (a.id === agent.id ? agent : a));
    set({ customAgents: next });
    void saveCustomAgents(next).then(broadcast);
  },
  remove: (id) => {
    const list = get().customAgents.filter((a) => a.id !== id);
    set({ customAgents: list });
    let active = get().activeId;
    if (active === id) {
      active = NONE_AGENT_ID;
      set({ activeId: active });
      const root = get().root;
      if (root) void saveActiveAgentIdFor(root, active);
      else void saveActiveAgentId(active);
    }
    void saveCustomAgents(list).then(broadcast);
  },
}));

export { newAgentId };