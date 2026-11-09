import { generateText, stepCountIs } from "ai";
import { DEFAULT_MODEL_ID, getModel, type ModelId } from "../config";
import { buildLanguageModel } from "../lib/agent";
import type { ProviderKeys } from "../lib/keyring";
import type { ToolContext } from "../tools/context";
import { buildFsTools } from "../tools/fs";
import { buildSearchTools } from "../tools/search";
import { withToolRedaction, withToolGuard } from "../lib/toolFencing";
import { createFenceState, fence, fenceSystemPrompt } from "../lib/fence";
import { SUBAGENTS, type SubagentType } from "./registry";

const SUBAGENT_MAX_STEPS_DEFAULT = 24;

/**
 * Final-report directive for the WRAP-UP pass. A subagent that burns its whole
 * working budget on tool calls used to return "(no output)" — the loop stops
 * after the last tool step and `result.text` is empty, so 20 minutes of
 * investigation were silently discarded ("subagents that go far deliver
 * nothing"). When the run ends without a deliverable text, ONE extra model
 * call with NO tools replays the gathered conversation and forces the model
 * to write its report. Bounded by construction: no tools = no further forking.
 */
const WRAPUP_PROMPT =
  "Your working budget is now exhausted. Write your final report immediately, based on everything you gathered so far: your findings, conclusions, and explicitly what you could NOT finish or verify. Plain text, no tool calls (none are available). Do not apologize for the budget - deliver what you have.";

type Args = {
  type: SubagentType;
  prompt: string;
  keys: ProviderKeys;
  modelId: ModelId;
  toolContext: ToolContext;
  openaiCompatibleBaseURL?: string;
  openaiCompatibleModelId?: string;
  onStep?: (label: string) => void;
  abortSignal?: AbortSignal;
  maxSteps?: number;
};

type RunResult = {
  summary: string;
  stepCount: number;
  durationMs: number;
  /** True when the run ended WITHOUT a final text (budget exhausted on tool
   *  calls, or the model narrated mid-work) and a wrap-up pass produced the
   *  report. The parent can use this to decide a narrower re-spawn. */
  truncated: boolean;
};

export async function runSubagent({
  type,
  prompt,
  keys,
  modelId,
  toolContext,
  openaiCompatibleBaseURL,
  openaiCompatibleModelId,
  onStep,
  abortSignal,
  maxSteps,
}: Args): Promise<RunResult> {
  const def = SUBAGENTS[type];
  if (!def) throw new Error(`unknown subagent type: ${type}`);

  const readOnly: Record<string, unknown> = {
    ...buildFsTools(toolContext),
    ...buildSearchTools(toolContext),
  };
  const tools: Record<string, unknown> = {};
  for (const t of def.tools) {
    if (t in readOnly) tools[t] = readOnly[t];
  }
  // Subagent tools are built directly (no withToolGuard upstream), so redaction
  // has to be applied here too — otherwise a read_file from inside a subagent
  // reaches the provider completely unscrubbed.
  const redactedTools = withToolRedaction(tools);
  // Fence the subagent's tool results with its OWN nonce set: an injected
  // README saying "ignore your rules" reaches the sub-model inside a trust
  // boundary it was told never to obey. The parent's fence nonces are
  // different on purpose — a subagent nonce can't impersonate parent fences.
  const fenceState = createFenceState();
  const guardedTools = withToolGuard(redactedTools, fenceState, null);

  // Resolve model id for local providers that use a user-configured model name.
  const m = getModel(modelId);
  let resolvedModelId = m.id;
  if (m.id === "openai-compatible-custom" && openaiCompatibleModelId?.trim()) {
    resolvedModelId = openaiCompatibleModelId.trim();
  }

  const model = await buildLanguageModel(
    m.provider,
    keys,
    resolvedModelId,
    { openaiCompatibleBaseURL },
  );

  const effectiveMaxSteps = maxSteps ?? SUBAGENT_MAX_STEPS_DEFAULT;
  const start = Date.now();
  const result = await generateText({
    model,
    system: def.systemPrompt + "\n\n" + fenceSystemPrompt(fenceState),
    prompt,
    tools: guardedTools as Parameters<typeof generateText>[0]["tools"],
    stopWhen: stepCountIs(effectiveMaxSteps),
    abortSignal,
    onStepFinish: (step) => {
      if (!onStep) return;
      const last = step.toolCalls?.[step.toolCalls.length - 1];
      if (last) onStep(`${type}: ${last.toolName}`);
    },
  });

  const stepCount = result.steps?.length ?? 0;
  let text = (result.text ?? "").trim();
  // Deliverable guarantee: text missing (the loop ended on a tool step) OR the
  // budget was exhausted (the last narration is a mid-work fragment, not a
  // report) both trigger the no-tools wrap-up. `response.messages` carries the
  // full gathered conversation — tool calls and results included — so the
  // wrap-up sees everything the subagent learned and cannot run more tools.
  const exhausted = stepCount >= effectiveMaxSteps;
  if ((!text || exhausted) && !abortSignal?.aborted) {
    onStep?.(`${type}: final report`);
    try {
      const wrap = await generateText({
        model,
        system: def.systemPrompt + "\n\n" + fenceSystemPrompt(fenceState),
        messages: [
          ...(result.response?.messages ?? []),
          { role: "user", content: WRAPUP_PROMPT },
        ],
        abortSignal,
      });
      const wrapText = (wrap.text ?? "").trim();
      if (wrapText) text = wrapText;
    } catch {
      // Wrap-up is best-effort: deliver whatever the main run produced.
    }
  }

  return {
    summary: fence("tool", fenceState.nonces.tool, text || "(no output)"),
    stepCount,
    durationMs: Date.now() - start,
    truncated: exhausted || !text,
  };
}

export const DEFAULT_SUBAGENT_MODEL: ModelId = DEFAULT_MODEL_ID;
