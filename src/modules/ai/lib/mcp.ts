import { LazyStore } from "@tauri-apps/plugin-store";

/** Transport type for an MCP server connection. */
export type McpTransport = "stdio" | "sse" | "http";

/** Persisted configuration for a single MCP server. */
export type McpServerConfig = {
  id: string;
  name: string;
  transport: McpTransport;
  /** stdio: executable to run. */
  command?: string;
  /** stdio: CLI arguments. */
  args?: string[];
  /** stdio: extra environment variables. */
  env?: Record<string, string>;
  /** stdio: working directory for the child process. */
  cwd?: string;
  /** sse/http: server URL. */
  url?: string;
  /** sse/http: extra request headers. */
  headers?: Record<string, string>;
  /** Whether the server is enabled (connected on agent runs). */
  enabled: boolean;
};

const STORE_PATH = "Kai-ai-mcp.json";
const KEY_SERVERS = "servers";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

/** Load all MCP server configs from disk. */
export async function loadMcpServers(): Promise<McpServerConfig[]> {
  return (await store.get<McpServerConfig[]>(KEY_SERVERS)) ?? [];
}

/** Persist MCP server configs to disk. */
export async function saveMcpServers(
  servers: McpServerConfig[],
): Promise<void> {
  await store.set(KEY_SERVERS, servers);
  await store.save();
}

/** Generate a unique MCP server config id. */
export function newMcpServerId(): string {
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
