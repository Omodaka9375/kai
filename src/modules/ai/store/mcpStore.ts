import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { isMainWindow } from "@/lib/windowRole";
import {
  loadMcpServers,
  newMcpServerId,
  saveMcpServers,
  type McpServerConfig,
} from "../lib/mcp";
import {
  mcpManager,
  MCP_CONTROL_EVENT,
  type McpConnectionStatus,
  type McpControlAction,
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

/**
 * Ask the main window to act on an MCP server. In the main window this is a
 * direct call; in the Settings webview it's a global event the owner
 * executes (the settings realm cannot spawn server processes — see
 * lib/windowRole.ts).
 */
function requestControl(action: McpControlAction): void {
  if (isMainWindow()) return; // direct calls are made by the callers below.
  void emit(MCP_CONTROL_EVENT, action);
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

      // Cross-window sync: owner executes control requests / broadcasts
      // statuses; mirrors (Settings) apply broadcasts. Safe to call in both
      // realms — each installs only its own side.
      mcpManager.installCrossWindowSync(loadMcpServers);

      if (isMainWindow()) {
        void mcpManager.connectAll(servers);
      } else {
        mcpManager.refreshAllStatuses();
      }

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
        // Explicit add → interactive: remote OAuth servers may open the
        // browser sign-in on this connect.
        if (isMainWindow()) void mcpManager.connect(server, true);
        else requestControl({ kind: "connect", serverId: server.id });
      }
    },

    updateServer: (server) => {
      const next = get().servers.map((s) =>
        s.id === server.id ? server : s,
      );
      set({ servers: next });
      void saveMcpServers(next).then(broadcast);
      // Reconnect if enabled, disconnect if disabled. Explicit edit →
      // interactive (OAuth browser flow allowed).
      if (server.enabled) {
        if (isMainWindow()) void mcpManager.connect(server, true);
        else requestControl({ kind: "reconnect", serverId: server.id });
      } else {
        if (isMainWindow()) void mcpManager.disconnect(server.id);
        else requestControl({ kind: "disconnect", serverId: server.id });
      }
    },

    removeServer: (id) => {
      const next = get().servers.filter((s) => s.id !== id);
      set({ servers: next });
      void saveMcpServers(next).then(broadcast);
      if (isMainWindow()) void mcpManager.disconnect(id);
      else requestControl({ kind: "disconnect", serverId: id });
    },

    toggleServer: (id) => {
      const server = get().servers.find((s) => s.id === id);
      if (!server) return;
      const updated = { ...server, enabled: !server.enabled };
      get().updateServer(updated);
    },

    connectAll: async () => {
      if (isMainWindow()) await mcpManager.connectAll(get().servers);
      else requestControl({ kind: "connectAll" });
    },

    disconnectAll: async () => {
      await mcpManager.disconnectAll();
      // Non-main realms hold no clients; ask the owner too.
      if (!isMainWindow()) requestControl({ kind: "connectAll" });
    },

    reconnect: async (id) => {
      const server = get().servers.find((s) => s.id === id);
      if (!server) return;
      // User-initiated reconnect → interactive (OAuth flow allowed).
      if (isMainWindow()) await mcpManager.connect(server, true);
      else requestControl({ kind: "reconnect", serverId: id });
    },
  };
});

export { newMcpServerId };
export type { McpConnectionStatus, McpServerStatus };