/**
 * MCP server management tools — let the agent register MCP servers the same
 * way the Settings UI does, so they persist (kai-mcp.json), connect through
 * mcpManager (tools flow into later runs), and appear live in the MCP Servers
 * UI (Settings → MCP + Extensions view) via the store's cross-window sync.
 *
 * Before this existed, agents improvised: editing config files on disk (the
 * store never reloads external edits and its autoSave can clobber them) or
 * spawning the server manually via bash — an unregistered process with no
 * status, no tools, and nothing in the UI.
 */

import { tool } from "ai";
import { z } from "zod";
import { newMcpServerId } from "../lib/mcp";
import { mcpManager } from "../lib/mcpManager";
import { useMcpStore } from "../store/mcpStore";
import type { ToolContext } from "./context";

/** How long to wait for the connect to settle before reporting "connecting". */
const CONNECT_POLL_MS = 250;
const CONNECT_WAIT_MS = 32_000; // manager's own timeout is 30s + margin

const TRANSPORTS = ["stdio", "sse", "http"] as const;

const transportSchema = z.enum(TRANSPORTS);

export function buildMcpTools(_ctx: ToolContext) {
  return {
    mcp_add_server: tool({
      description:
        "Register an MCP server so it connects and appears in the MCP Servers UI (Settings → MCP / Extensions). This is the ONLY correct way to add an MCP server — never edit config files on disk and never run the server manually via bash_run (an unregistered process is invisible to the app and its tools never load). The server's tools become available to you automatically on the next user message. If the server needs environment secrets (API keys), ask the user — do NOT invent values.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe(
            "Short unique name; its tools will be exposed as <name>__<tool>.",
          ),
        transport: transportSchema,
        command: z
          .string()
          .optional()
          .describe("stdio: executable to run (required for stdio)."),
        args: z.array(z.string()).optional().describe("stdio: CLI arguments."),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("stdio: extra environment variables."),
        cwd: z.string().optional().describe("stdio: working directory."),
        url: z
          .string()
          .optional()
          .describe("sse/http: server URL (required for sse/http)."),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("sse/http: extra request headers."),
        enabled: z
          .boolean()
          .optional()
          .describe("Connect on register (default true)."),
      }),
      needsApproval: true,
      execute: async (input, _options) => {
        const { name, transport } = input;
        if (!name.trim()) return { error: "name is required" };

        if (transport === "stdio" && !input.command?.trim()) {
          return { error: "stdio transport requires a command" };
        }
        if (transport !== "stdio" && !input.url?.trim()) {
          return { error: `${transport} transport requires a url` };
        }

        const store = useMcpStore.getState();
        // Idempotency: same name (case-insensitive) updates the existing
        // server instead of creating a duplicate entry.
        const existing = store.servers.find(
          (s) => s.name.toLowerCase() === name.trim().toLowerCase(),
        );

        const config = {
          id: existing?.id ?? newMcpServerId(),
          name: name.trim(),
          transport,
          ...(input.command ? { command: input.command } : {}),
          ...(input.args ? { args: input.args } : {}),
          ...(input.env
            ? { env: input.env as Record<string, string> }
            : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.url ? { url: input.url } : {}),
          ...(input.headers
            ? { headers: input.headers as Record<string, string> }
            : {}),
          enabled: input.enabled ?? true,
        };

        // Same store path the Settings UI takes: persist to kai-mcp.json,
        // broadcast to the Settings webview, connect via mcpManager in the
        // main window. Status flows to both windows via cross-window sync.
        if (existing) store.updateServer(config);
        else store.addServer(config);

        if (!config.enabled) {
          return {
            ok: true,
            name: config.name,
            id: config.id,
            status: "disabled",
            note: "Registered but not enabled — the user can toggle it in the MCP Servers UI.",
          };
        }

        // addServer/updateServer connect fire-and-forget; poll the manager
        // until the connect settles so the user gets the real outcome.
        const deadline = Date.now() + CONNECT_WAIT_MS;
        for (;;) {
          await new Promise((r) => setTimeout(r, CONNECT_POLL_MS));
          const status = mcpManager.getStatus(config.id);
          if (status.status !== "connecting" || Date.now() > deadline) {
            const stillConnecting = status.status === "connecting";
            if (status.status === "error") {
              return {
                ok: true,
                name: config.name,
                id: config.id,
                status: status.status,
                error: status.error,
                note: "Registered in the MCP Servers UI but failed to connect — the user can see the error there and retry.",
              };
            }
            return {
              ok: true,
              name: config.name,
              id: config.id,
              status: status.status,
              toolCount: status.toolCount,
              ...(stillConnecting
                ? {
                    note: "Still connecting (possibly waiting for OAuth sign-in or a slow start) — check the MCP Servers UI for the live status.",
                  }
                : {
                    note: "Its tools are available to you from the next user message.",
                  }),
            };
          }
        }
      },
    }),

    mcp_list_servers: tool({
      description:
        "List registered MCP servers with their live connection status and tool counts. Use this before adding a server to avoid duplicates, or to check whether a server connected successfully.",
      inputSchema: z.object({}),
      needsApproval: false,
      execute: async () => {
        const { servers } = useMcpStore.getState();
        return {
          servers: servers.map((s) => ({
            name: s.name,
            transport: s.transport,
            enabled: s.enabled,
            status: mcpManager.getStatus(s.id).status,
            toolCount: mcpManager.getStatus(s.id).toolCount,
            error: mcpManager.getStatus(s.id).error,
          })),
        };
      },
    }),
  } as const;
}
