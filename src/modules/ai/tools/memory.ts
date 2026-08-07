/**
 * Auto-Memory tool — lets the agent persist knowledge across sessions.
 */

import { tool } from "ai";
import { z } from "zod";
import { appendToMemory } from "../lib/memory";
import { type ToolContext } from "./context";

export function buildMemoryTools(ctx: ToolContext) {
  return {
    save_memory: tool({
      description:
        "Save a piece of knowledge to the project's persistent memory. This memory is loaded into every future session. Use this when you learn something that will be useful in later conversations: build commands, project conventions, debugging discoveries, architectural decisions, user preferences. Write concisely — the memory file is loaded into the context window on every session start.",
      inputSchema: z.object({
        entry: z
          .string()
          .describe(
            "The knowledge to persist. Write in markdown. Be concise — this is loaded into context every session.",
          ),
      }),
      execute: async ({ entry }) => {
        const root = ctx.getWorkspaceRoot();
        if (!root) return { error: "no workspace root — cannot save memory" };
        const sessionId = ctx.getSessionId();
        try {
          await appendToMemory(root, entry, sessionId ?? undefined);
          return { ok: true, saved_to: "<workspace>/.kai/memory/<hash>/MEMORY.md" };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  } as const;
}