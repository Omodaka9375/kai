import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  loadMcpServers,
  newMcpServerId,
  saveMcpServers,
  type McpServerConfig,
} from "../lib/mcp";
import {
  mcpManager,
  type McpConnectionStatus,
  type McpServerStatus,
} from "../lib/mcpManager";

const CHANGED_EVENT = "Kai://ai-mcp-changed";

type McpState = {
  hydrated: boolean;
  servers: McpServerConfig[];
  /** Live connection status per server id. */
  statuses: Record<string, McpServerStatus>;

  hydrate: () => Promise<void>;
  addServer: (server: McpServerConfig) => void;
  updateServer: (server: McpServerConfig) => void;
  removeServer: (id: string) => void;
  toggleServer: (id: string) => void;
  /** Connects all enabled servers. */
  connectAll: () => Promise<void>;
  /** Disconnects all servers. */
  disconnectAll: () => Promise<void>;
  /** Reconnect a single server. */
  reconnect: (id: string) => Promise<void>;
};

let initialized = false;

function broadcast(): void {
  void emit(CHANGED_EVENT);
}

export const useMcpStore = create<McpState>((set, get) => {
  // Listen for status updates from the manager.
  mcpManager.onStatusChange((serverId, status) => {
    set((s) => ({
      statuses: { ...s.statuses, [serverId]: status },
    }));
  });

  return {
    hydrated: false,
    servers: [],
    statuses: {},

    hydrate: async () => {
      if (initialized) return;
      initialized = true;
      const servers = await loadMcpServers();
      set({ servers, hydrated: true });

      // Auto-connect enabled servers on startup.
      void mcpManager.connectAll(servers);

      void listen(CHANGED_EVENT, async () => {
        const fresh = await loadMcpServers();
        set({ servers: fresh });
      });
    },

    addServer: (server) => {
      const next = [...get().servers, server];
      set({ servers: next });
      void saveMcpServers(next).then(broadcast);
      if (server.enabled) {
        void mcpManager.connect(server);
      }
    },

    updateServer: (server) => {
      const next = get().servers.map((s) =>
        s.id === server.id ? server : s,
      );
      set({ servers: next });
      void saveMcpServers(next).then(broadcast);
      // Reconnect if enabled, disconnect if disabled.
      if (server.enabled) {
        void mcpManager.connect(server);
      } else {
        void mcpManager.disconnect(server.id);
      }
    },

    removeServer: (id) => {
      const next = get().servers.filter((s) => s.id !== id);
      set({ servers: next });
      void saveMcpServers(next).then(broadcast);
      void mcpManager.disconnect(id);
    },

    toggleServer: (id) => {
      const server = get().servers.find((s) => s.id === id);
      if (!server) return;
      const updated = { ...server, enabled: !server.enabled };
      get().updateServer(updated);
    },

    connectAll: async () => {
      await mcpManager.connectAll(get().servers);
    },

    disconnectAll: async () => {
      await mcpManager.disconnectAll();
    },

    reconnect: async (id: string) => {
      const server = get().servers.find((s) => s.id === id);
      if (!server) return;
      await mcpManager.connect(server);
    },
  };
});

export { newMcpServerId };
export type { McpConnectionStatus, McpServerStatus };
