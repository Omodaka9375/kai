import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { McpServerConfig } from "./mcp";
import { createProxyFetch } from "./proxyFetch";

// ── Tauri stdio transport ──────────────────────────────────────────────────

type McpStdioEvent =
  | { kind: "message"; data: string }
  | { kind: "exit"; code: number | null }
  | { kind: "error"; message: string };

/**
 * Custom MCP transport that bridges a stdio MCP server spawned by the Rust
 * backend through Tauri IPC. Implements the interface expected by
 * `createMCPClient`.
 */
class TauriStdioTransport {
  private sessionId: number | null = null;
  private config: McpServerConfig;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    const channel = new Channel<McpStdioEvent>();
    channel.onmessage = (event) => {
      switch (event.kind) {
        case "message":
          try {
            const parsed = JSON.parse(event.data);
            this.onmessage?.(parsed);
          } catch {
            // Ignore non-JSON lines (e.g. stderr leaking into stdout).
          }
          break;
        case "exit":
          this.onclose?.();
          break;
        case "error":
          this.onerror?.(new Error(event.message));
          break;
      }
    };

    this.sessionId = await invoke<number>("mcp_stdio_open", {
      command: this.config.command ?? "",
      args: this.config.args ?? [],
      env: this.config.env ?? null,
      cwd: this.config.cwd ?? null,
      onMessage: channel,
    });
  }

  async send(message: unknown): Promise<void> {
    if (this.sessionId === null) {
      throw new Error("TauriStdioTransport not started");
    }
    await invoke("mcp_stdio_send", {
      id: this.sessionId,
      message: JSON.stringify(message),
    });
  }

  async close(): Promise<void> {
    if (this.sessionId !== null) {
      await invoke("mcp_stdio_close", { id: this.sessionId }).catch(
        () => {},
      );
      this.sessionId = null;
    }
  }
}

// ── Connection status ──────────────────────────────────────────────────────

export type McpConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export type McpServerStatus = {
  status: McpConnectionStatus;
  error: string | null;
  toolCount: number;
};

// ── MCP Client Manager ────────────────────────────────────────────────────

type ManagedClient = {
  client: MCPClient;
  config: McpServerConfig;
  status: McpServerStatus;
  tools: Record<string, unknown>;
  /** Instructions/prompts fetched from the server (e.g. skill.md content). */
  instructions: string | null;
};

type StatusCallback = (
  serverId: string,
  status: McpServerStatus,
) => void;

/**
 * Manages MCP client connections for all configured servers. Keeps clients
 * alive across agent turns and provides aggregated tools.
 */
class McpClientManager {
  private clients = new Map<string, ManagedClient>();
  private statusListeners = new Set<StatusCallback>();

  onStatusChange(cb: StatusCallback): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  private notify(id: string, status: McpServerStatus) {
    for (const cb of this.statusListeners) cb(id, status);
  }

  /** Connection timeout (ms). MCP servers that don't respond within this
   *  window are marked as errored instead of hanging indefinitely. */
  static CONNECTION_TIMEOUT_MS = 30_000;

  /** Connect to a single MCP server. */
  async connect(config: McpServerConfig): Promise<void> {
    // Disconnect existing connection for this id first.
    await this.disconnect(config.id);

    const status: McpServerStatus = {
      status: "connecting",
      error: null,
      toolCount: 0,
    };
    this.notify(config.id, status);

    try {
      let client: MCPClient;

      if (config.transport === "stdio") {
        const transport = new TauriStdioTransport(config);
        client = await withTimeout(
          createMCPClient({ transport: transport as never }),
          McpClientManager.CONNECTION_TIMEOUT_MS,
          `MCP server "${config.name}" did not respond within ${McpClientManager.CONNECTION_TIMEOUT_MS / 1000}s`,
        );
      } else {
        // SSE or HTTP — route through the Rust backend via proxyFetch to
        // bypass WebView2 fetch quirks, CORS, and private-network blocks.
        const mcpFetch = createProxyFetch({ allowPrivateNetwork: true });
        client = await withTimeout(
          createMCPClient({
            transport: {
              type: config.transport,
              url: config.url ?? "",
              headers: config.headers,
              fetch: mcpFetch,
            },
          }),
          McpClientManager.CONNECTION_TIMEOUT_MS,
          `MCP server "${config.name}" did not respond within ${McpClientManager.CONNECTION_TIMEOUT_MS / 1000}s`,
        );
      }

      const tools = await withTimeout(
        client.tools(),
        McpClientManager.CONNECTION_TIMEOUT_MS,
        `MCP server "${config.name}" timed out listing tools`,
      );
      const toolCount = Object.keys(tools).length;

      // Try to fetch server-provided instructions/prompts.
      // Defense: validate returned data shape and cap total length to prevent
      // a malicious MCP server from injecting unbounded text into the system prompt.
      const MAX_INSTRUCTIONS_LEN = 8_000;
      const MAX_PROMPTS = 5;
      let instructions: string | null = null;
      try {
        const prompts = await (client as any).experimental_listPrompts?.();
        if (prompts && Array.isArray(prompts) && prompts.length > 0) {
          const safePrompts = prompts.slice(0, MAX_PROMPTS);
          for (const p of safePrompts) {
            if (!p || typeof p.name !== "string") continue;
            try {
              const detail = await (client as any).experimental_getPrompt?.({
                name: p.name,
              });
              if (!detail || !Array.isArray(detail.messages)) continue;
              const text = detail.messages
                .filter((m: unknown): m is { content: { text: string } } => {
                  if (!m || typeof m !== "object") return false;
                  const msg = m as Record<string, unknown>;
                  return (
                    msg.content != null &&
                    typeof msg.content === "object" &&
                    typeof (msg.content as Record<string, unknown>).text === "string"
                  );
                })
                .map((m: { content: { text: string } }) => m.content.text)
                .join("\n");
              if (text.trim()) {
                const chunk = text.trim();
                instructions = (instructions ? instructions + "\n\n" : "") + chunk;
                if (instructions.length >= MAX_INSTRUCTIONS_LEN) {
                  instructions = instructions.slice(0, MAX_INSTRUCTIONS_LEN);
                  break;
                }
              }
            } catch { /* prompt fetch failed, skip */ }
          }
        }
      } catch { /* prompts not supported by this server */ }

      const managed: ManagedClient = {
        client,
        config,
        status: { status: "connected", error: null, toolCount },
        tools,
        instructions,
      };
      this.clients.set(config.id, managed);
      this.notify(config.id, managed.status);
    } catch (e) {
      const errStatus: McpServerStatus = {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        toolCount: 0,
      };
      this.clients.set(config.id, {
        client: null!,
        config,
        status: errStatus,
        tools: {},
        instructions: null,
      });
      this.notify(config.id, errStatus);
    }
  }

  /** Disconnect a single MCP server. */
  async disconnect(id: string): Promise<void> {
    const managed = this.clients.get(id);
    if (!managed) return;
    try {
      await managed.client?.close();
    } catch {
      // Ignore close errors.
    }
    this.clients.delete(id);
    this.notify(id, {
      status: "disconnected",
      error: null,
      toolCount: 0,
    });
  }

  /** Connect all enabled servers from a config list. */
  async connectAll(configs: McpServerConfig[]): Promise<void> {
    const enabled = configs.filter((c) => c.enabled);
    await Promise.allSettled(enabled.map((c) => this.connect(c)));
  }

  /** Disconnect all active servers. */
  async disconnectAll(): Promise<void> {
    const ids = [...this.clients.keys()];
    await Promise.allSettled(ids.map((id) => this.disconnect(id)));
  }

  /** Get the merged tool map from all connected servers (namespaced). */
  getActiveTools(): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const [, managed] of this.clients) {
      if (managed.status.status !== "connected") continue;
      const prefix = sanitizeName(managed.config.name);
      for (const [name, tool] of Object.entries(managed.tools)) {
        merged[`${prefix}__${name}`] = tool;
      }
    }
    return merged;
  }

  /** Get tools for specific server IDs only. */
  getToolsForServers(serverIds: string[]): Record<string, unknown> {
    const idSet = new Set(serverIds);
    const merged: Record<string, unknown> = {};
    for (const [id, managed] of this.clients) {
      if (!idSet.has(id)) continue;
      if (managed.status.status !== "connected") continue;
      const prefix = sanitizeName(managed.config.name);
      for (const [name, tool] of Object.entries(managed.tools)) {
        merged[`${prefix}__${name}`] = tool;
      }
    }
    return merged;
  }

  /** Get status for a specific server. */
  getStatus(id: string): McpServerStatus {
    return (
      this.clients.get(id)?.status ?? {
        status: "disconnected",
        error: null,
        toolCount: 0,
      }
    );
  }

  /** Get all current statuses. */
  getAllStatuses(): Map<string, McpServerStatus> {
    const out = new Map<string, McpServerStatus>();
    for (const [id, managed] of this.clients) {
      out.set(id, managed.status);
    }
    return out;
  }

  /** List connected server names (for system prompt). */
  getConnectedServerSummaries(): { name: string; tools: string[]; instructions: string | null }[] {
    const out: { name: string; tools: string[]; instructions: string | null }[] = [];
    for (const [, managed] of this.clients) {
      if (managed.status.status !== "connected") continue;
      out.push({
        name: managed.config.name,
        tools: Object.keys(managed.tools),
        instructions: managed.instructions,
      });
    }
    return out;
  }
}

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30) || "mcp";
}

/** Race a promise against a timeout. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Singleton manager instance. */
export const mcpManager = new McpClientManager();
