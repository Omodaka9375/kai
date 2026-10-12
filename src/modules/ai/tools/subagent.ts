import { tool } from "ai";
import { z } from "zod";
import { runSubagent } from "../agents/runSubagent";
import { SUBAGENTS, type SubagentType } from "../agents/registry";
import { useChatStore } from "../store/chatStore";
import type { ToolContext } from "./context";

const TYPE_KEYS = Object.keys(SUBAGENTS) as [SubagentType, ...SubagentType[]];

export function buildSubagentTools(ctx: ToolContext) {
  return {
    run_subagent: tool({
      description: `Spawn an isolated subagent with its own restricted toolset and a fresh message history. Use when you need to delegate a self-contained read-only investigation (large search, code review, security audit) without polluting your own context. The subagent returns a single text summary; pick a 'type' that matches its job.

Types:
${TYPE_KEYS.map((k) => `- ${k}: ${SUBAGENTS[k].description}`).join("\n")}

Asks for user approval unless auto-approve is enabled (subagents are read-only by design — the approval gates the spawn + model spend, not file safety).`,
      inputSchema: z.object({
        type: z.enum(TYPE_KEYS),
        prompt: z
          .string()
          .describe(
            "Self-contained instruction. The subagent has no memory of prior conversation — include all relevant context.",
          ),
        description: z
          .string()
          .optional()
          .describe("Short label shown in the chat UI for the spawn card."),
      }),
      needsApproval: true,
      execute: async ({ type, prompt, description }, options) => {
        const abortSignal = options?.abortSignal;
        const { apiKeys, selectedModelId, patchAgentMeta } =
          useChatStore.getState();
        const prefs = await import("@/modules/settings/preferences").then(
          (m) => m.usePreferencesStore.getState(),
        );
        try {
          const r = await runSubagent({
            type,
            prompt,
            keys: apiKeys,
            modelId: selectedModelId,
            toolContext: ctx,
            lmstudioBaseURL: prefs.lmstudioBaseURL || undefined,
            openaiCompatibleBaseURL: prefs.openaiCompatibleBaseURL || undefined,
            openaiCompatibleModelId: prefs.openaiCompatibleModelId || undefined,
            lmstudioModelId: prefs.lmstudioModelId || undefined,
            onStep: (label) => patchAgentMeta({ step: label }),
            abortSignal,
            maxSteps: prefs.subagentMaxSteps,
          });
          return {
            type,
            description,
            summary: r.summary,
            stepCount: r.stepCount,
            durationMs: r.durationMs,
          };
        } catch (e) {
          return { error: String(e), type };
        }
      },
    }),
  } as const;
}
