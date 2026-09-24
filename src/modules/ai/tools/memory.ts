/**
 * Auto-Memory tool — lets the agent persist knowledge across sessions.
 */

import { tool } from "ai";
import { z } from "zod";
import { consumeEditedToolInput } from "../lib/toolInputOverrides";
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
      needsApproval: true,
      execute: async ({ entry }, options) => {
        // The approval card may have let the user edit the entry — the
        // edited text replaces the model's proposal verbatim.
        const edited = consumeEditedToolInput(options?.toolCallId ?? "");
        const finalEntry =
          edited && typeof edited.entry === "string"
            ? edited.entry.trim()
            : entry.trim();
        if (!finalEntry) {
          return { error: "empty entry — nothing to save" };
        }
        // Memory keys off the REAL project root (not the detached copy's) so
        // knowledge survives a merge/discard and stays consistent across a
        // shadow session. See ToolContext.getRealWorkspaceRoot.
        const root =
          ctx.getRealWorkspaceRoot?.() ?? ctx.getWorkspaceRoot();
        if (!root) return { error: "no workspace root — cannot save memory" };
        const sessionId = ctx.getSessionId();
        try {
          await appendToMemory(root, finalEntry, sessionId ?? undefined);
          return {
            ok: true,
            saved_to: "~/.kai/memory/<hash>/MEMORY.md",
            ...(edited ? { edited: true } : {}),
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  } as const;
}
