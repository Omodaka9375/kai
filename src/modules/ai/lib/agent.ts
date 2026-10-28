import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type LanguageModel,
  type ModelMessage,
  type UIMessage,
} from "ai";
import {
  DEFAULT_MODEL_ID,
  getModel,
  getModelContextLimit,
  LMSTUDIO_DEFAULT_BASE_URL,
  MAX_AGENT_STEPS,
  NO_VISION_NOTICE,
  providerNeedsKey,
  SYSTEM_PROMPT,
  THINKING_BUDGET_ANTHROPIC,
  THINKING_BUDGET_GOOGLE,
  THINKING_EFFORT_OPENAI,
  THINKING_EFFORT_OPENROUTER,
  THINKING_EFFORT_DEEPSEEK,
  THINKING_EFFORT_GROQ,
  THINKING_EFFORT_XAI,
  type ModelId,
  type ProviderId,
  type ThinkingMode,
} from "../config";
import { buildTools, type ToolContext } from "../tools/tools";
import { compactModelMessagesDetailed } from "./compact";
import {
  modelCanSee,
  swapImagePartsToText,
  countInlineImageParts,
} from "../extraction";
import type { ProviderKeys } from "./keyring";
import { createProxyFetch } from "./proxyFetch";
import { normalizeForProvider } from "./providerNormalize";
import { createDsmlMiddleware } from "./dsmlMiddleware";
import {
  getRulePacksForStack,
  formatRulePacksForPrompt,
  type StackInfo,
} from "./stackDetector";
export type { StackInfo };
import { fenceSystemPrompt } from "./fence";
import { stripInternalMeta, withToolGuard, withToolRedaction } from "./toolFencing";
import { presentationFor } from "./toolPresentations";
import { appendSessionEvent, buildTurnEvent } from "./sessionEvents";
import { withCentralToolGuards } from "./toolGuards";
import { auditAppend, AUDIT_KINDS } from "./audit";
import {
  getGlobalStreamGuard,
  toolLoopFingerprint,
  type LoopDetectionResult,
} from "./streamGuard";

const localProxyFetch = createProxyFetch({ allowPrivateNetwork: true });

/**
 * Hybrid fetch for cloud providers: tries native fetch first (handles large
 * bodies like image uploads efficiently), falls back to proxyFetch on CORS
 * or network errors. This avoids the IPC bottleneck of serializing multi-MB
 * request bodies as number arrays through Tauri.
 */
const cloudFetch: typeof fetch = async (input, init) => {
  try {
    return await globalThis.fetch(input, init);
  } catch (e) {
    // Native fetch failed (likely CORS) — retry through Rust proxy.
    // Only retry on TypeError (network/CORS), not on AbortError or others.
    if (e instanceof TypeError) {
      return localProxyFetch(input, init);
    }
    throw e;
  }
};

// Live step status labels come from the toolPresentations registry
// (`status` field) — no more TOOL_LABELS duplicated alongside the card label.

export type BuildModelOptions = {
  modelIdOverride?: string;
  lmstudioBaseURL?: string;
  openaiCompatibleBaseURL?: string;
};

const MODEL_CACHE_CAP = 8;
const modelCache = new Map<string, LanguageModel>();

function touchModelCache(key: string, model: LanguageModel): void {
  if (modelCache.has(key)) modelCache.delete(key);
  modelCache.set(key, model);
  while (modelCache.size > MODEL_CACHE_CAP) {
    const oldest = modelCache.keys().next().value;
    if (!oldest || oldest === key) break;
    modelCache.delete(oldest);
  }
}

export async function buildLanguageModel(
  provider: ProviderId,
  keys: ProviderKeys,
  resolvedModelId: string,
  options: BuildModelOptions = {},
): Promise<LanguageModel> {
  if (providerNeedsKey(provider) && !keys[provider]) {
    throw new Error(
      `No API key configured for ${provider}. Open Settings → AI to add one.`,
    );
  }
  const key = keys[provider] ?? "";
  const lmstudioURL = options.lmstudioBaseURL ?? LMSTUDIO_DEFAULT_BASE_URL;
  const compatURL = options.openaiCompatibleBaseURL ?? "";
  const cacheKey = `${provider} ${key} ${resolvedModelId} ${lmstudioURL} ${compatURL}`;
  const hit = modelCache.get(cacheKey);
  if (hit) return hit;

  let built: LanguageModel;
  switch (provider) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      built = createOpenAI({ apiKey: key, fetch: cloudFetch })(resolvedModelId);
      break;
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      built = createAnthropic({ apiKey: key, fetch: cloudFetch })(resolvedModelId);
      break;
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      built = createGoogleGenerativeAI({ apiKey: key, fetch: cloudFetch })(resolvedModelId);
      break;
    }
    case "xai": {
      const { createXai } = await import("@ai-sdk/xai");
      built = createXai({ apiKey: key, fetch: cloudFetch })(resolvedModelId);
      break;
    }
    case "cerebras": {
      const { createCerebras } = await import("@ai-sdk/cerebras");
      built = createCerebras({ apiKey: key, fetch: cloudFetch })(resolvedModelId);
      break;
    }
    case "deepseek": {
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "deepseek",
        baseURL: "https://api.deepseek.com",
        apiKey: key,
        fetch: cloudFetch,
      })(resolvedModelId);
      break;
    }
    case "mistral": {
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "mistral",
        baseURL: "https://api.mistral.ai/v1",
        apiKey: key,
        fetch: cloudFetch,
      })(resolvedModelId);
      break;
    }
    case "groq": {
      const { createGroq } = await import("@ai-sdk/groq");
      built = createGroq({ apiKey: key, fetch: cloudFetch })(resolvedModelId);
      break;
    }
    case "openrouter": {
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: key,
        headers: {
          "HTTP-Referer": "https://Kai.ai",
          "X-Title": "Kai",
        },
        fetch: cloudFetch,
      })(resolvedModelId);
      break;
    }
    case "zai": {
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "zai",
        baseURL: "https://api.z.ai/api/paas/v4",
        apiKey: key,
        fetch: cloudFetch,
      })(resolvedModelId);
      break;
    }
    case "openai-compatible": {
      if (!compatURL) {
        throw new Error(
          "OpenAI-compatible provider has no base URL. Set it in Settings → Models.",
        );
      }
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "openai-compatible",
        baseURL: compatURL,
        apiKey: key || undefined,
        fetch: localProxyFetch,
      })(resolvedModelId);
      break;
    }
    case "lmstudio": {
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "lmstudio",
        baseURL: lmstudioURL,
        fetch: localProxyFetch,
      })(resolvedModelId);
      break;
    }
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${_exhaustive as ProviderId}`);
    }
  }
  touchModelCache(cacheKey, built);
  return built;
}

export function buildConfiguredLanguageModel(
  modelId: ModelId,
  keys: ProviderKeys,
  lmstudioBaseURL?: string,
  lmstudioModelId?: string,
  openaiCompatibleBaseURL?: string,
  openaiCompatibleModelId?: string,
): Promise<LanguageModel> {
  const m = getModel(modelId);
  let resolvedId: string = m.id;
  if (m.id === "lmstudio-local") {
    if (!lmstudioModelId?.trim()) {
      throw new Error(
        "LM Studio: no model id set. Open Settings → Models and enter the model id loaded in LM Studio.",
      );
    }
    resolvedId = lmstudioModelId.trim();
  } else if (m.id === "openai-compatible-custom") {
    if (!openaiCompatibleModelId?.trim()) {
      throw new Error(
        "OpenAI-compatible: no model id set. Open Settings → Models.",
      );
    }
    resolvedId = openaiCompatibleModelId.trim();
  }
  return buildLanguageModel(m.provider, keys, resolvedId, {
    lmstudioBaseURL,
    openaiCompatibleBaseURL,
  });
}

const PLAN_MODE_PROMPT = `## PLAN MODE — ACTIVE
Mutating tools (write_file, edit, multi_edit, create_directory) will queue their changes for the user to review as a single diff. Do NOT execute bash_run or bash_background while plan mode is active — restrict yourself to reads (read_file, grep, glob, list_directory) and the queued mutations. After queueing the full set of edits, stop and return a brief summary; do not continue acting until the user has accepted/rejected.`;

export function buildStableSystem(
  _modelId: ModelId,
  persona: { name: string; instructions: string } | null,
  customInstructions: string | undefined,
  projectMemory: string | null,
  stackInfo?: StackInfo | null,
): string {
  const base = SYSTEM_PROMPT;
  const personaBlock = persona?.instructions.trim()
    ? `\n\n## ACTIVE AGENT — ${persona.name}\n${persona.instructions.trim()}`
    : "";
  const customBlock = customInstructions?.trim()
    ? `\n\n## USER CUSTOM INSTRUCTIONS — follow unless they conflict with safety rules above\n${customInstructions.trim()}`
    : "";
  const memoryBlock =
    projectMemory && projectMemory.trim().length > 0
      ? `\n\n## PROJECT — Kai.md\n${projectMemory.trim()}`
      : "";

  // Add stack detection and rule packs if available
  let stackBlock = "";
  if (stackInfo) {
    const rulePacks = getRulePacksForStack(stackInfo);
    const formattedPacks = formatRulePacksForPrompt(rulePacks);
    if (formattedPacks) {
      stackBlock = `\n\n${formattedPacks}`;
    }
  }

  return `${base}${memoryBlock}${personaBlock}${customBlock}${stackBlock}`;
}

// OpenAI / Gemini / DeepSeek apply prefix caching automatically; only
// Anthropic needs explicit breakpoints. Mark the stable system prefix and
// the rotating conversation tail.
function applyCacheBreakpoints(
  messages: ModelMessage[],
  provider: ProviderId,
): ModelMessage[] {
  if (provider !== "anthropic" || messages.length === 0) return messages;
  const marker = {
    anthropic: { cacheControl: { type: "ephemeral" as const } },
  };
  const withMarker = (m: ModelMessage): ModelMessage => ({
    ...m,
    providerOptions: { ...(m.providerOptions ?? {}), ...marker },
  });
  const out = messages.slice();
  out[0] = withMarker(out[0]);
  const lastIdx = out.length - 1;
  if (lastIdx > 0) out[lastIdx] = withMarker(out[lastIdx]);
  return out;
}

export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

export type AgentUsageDelta = AgentUsage & {
  lastInputTokens: number;
  lastCachedTokens: number;
};

const EMPTY_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

export type RunAgentOptions = {
  keys: ProviderKeys;
  modelId?: ModelId;
  customInstructions?: string;
  agentPersona?: { name: string; instructions: string } | null;
  toolContext: ToolContext;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta) => void;
  /** Fires on every streamed text delta. Lets the caller track live tok/s even
   *  when the provider does not report `usage` (LM Studio, Ollama,
   *  openai-compatible) — those emit text chunks but zero output tokens. */
  onTextDelta?: (text: string) => void;
  onCompact?: (info: { droppedCount: number }) => void;
  onFinishMeta?: (info: { hitStepCap: boolean; finishReason: string }) => void;
  onLoopDetected?: (info: LoopDetectionResult) => void;
  lmstudioBaseURL?: string;
  lmstudioModelId?: string;
  openaiCompatibleBaseURL?: string;
  openaiCompatibleModelId?: string;
  /** User-set vision override for custom endpoints (Settings → Models).
   *  "on"/"off" beat the model-name heuristic; "auto" (default) uses it. */
  customVisionOverride?: import("../config").VisionOverride | null;
  planMode?: boolean;
  projectMemory?: string | null;
  stackInfo?: StackInfo | null;
  thinkingMode?: string;
  uiMessages: UIMessage[];
  abortSignal?: AbortSignal;
  /** Extra tools from MCP servers, already namespaced. */
  mcpTools?: Record<string, unknown>;
  /** Human-readable summary of connected MCP servers for the system prompt. */
  mcpSummary?: { name: string; tools: string[]; instructions: string | null }[];
  /** Fence state for prompt-injection defense. Created per session. */
  fenceState?: import("./fence").FenceState;
  /** Current auto-approve setting ("off"|"all"), journaled with the turn so
   *  "did the agent run unattended?" is answerable from the event log. */
  autoApprove?: string;
};

/**
 * Remove assistant messages that contain incomplete tool-call parts — parts
 * that never received a tool result (output-available/output-error) or had
 * their approval resolved (approval-responded). The entire message is dropped,
 * not just the tool part, because retaining orphaned text from a message
 * whose tool call was stripped would corrupt the conversation: the model
 * appears to have said something but no action followed, which causes models
 * to leak raw tool-call XML syntax as text and spiral into loops.
 *
 * This happens when the user stops the agent mid-tool-call, toggles
 * auto-approve off while a tool is pending, or when edit retries fail.
 */
function stripIncompleteToolCalls(messages: UIMessage[]): UIMessage[] {
  if (messages.length === 0) return messages;

  const COMPLETE_STATES = new Set([
    "output-available",
    "output-error",
    "approval-responded",
  ]);

  // A tool part with an EMPTY tool name ("tool-") or empty/missing
  // toolCallId is a malformed error part (the SDK emits it when a tool call
  // fails to parse/resolve). Its empty id converts to tool_call_id: "" and
  // the provider rejects the entire request ("tool messages must include a
  // non-empty string tool_call_id") — and because the poison part lives in
  // the PERSISTED history, every retry re-sends it and the session is
  // permanently unrecoverable. Drop the whole message at the UI layer
  // BEFORE conversion, matching the orphaned-tool-call treatment above.
  const hasMalformedToolPart = (m: UIMessage): boolean => {
    for (const p of m.parts) {
      const ptype = (p as { type?: string }).type ?? "";
      if (!ptype.startsWith("tool-")) continue;
      const toolName = ptype.slice("tool-".length);
      const callId = (p as { toolCallId?: unknown }).toolCallId;
      if (toolName === "" || typeof callId !== "string" || callId === "") {
        return true;
      }
    }
    return false;
  };

  // Scan ALL assistant messages, not just the last — failed edit retries
  // and dismissed approvals can leave orphaned tool calls anywhere.
  const out = messages.filter((m) => {
    if (m.role !== "assistant") return true;
    if (hasMalformedToolPart(m)) return false;
    for (const p of m.parts) {
      const ptype = (p as { type?: string }).type ?? "";
      if (!ptype.startsWith("tool-") && ptype !== "dynamic-tool") continue;
      const state = (p as { state?: string }).state;
      if (state == null || !COMPLETE_STATES.has(state)) return false;
    }
    return true;
  });
  return out;
}

/**
 * Remove persisted internal tool metadata (`_effect`, `_outputWarning*`)
 * from tool-result parts before history reaches the model.
 *
 * `withToolGuard` KEEPS these fields on the transcript so a finished card
 * can re-render its outcome (COMMITTED / PARTIAL / ROLLED_BACK) from
 * persisted data alone. Fresh calls are serialized through the per-tool
 * `toModelOutput`, which strips them — but HISTORY replay converts with
 * `convertToModelMessages` WITHOUT tool defs, so the SDK would otherwise
 * resend the raw persisted object. This mirrors that strip at the UI layer.
 */
function stripModelInternalMeta(messages: UIMessage[]): UIMessage[] {
  let touched = false;
  const out = messages.map((m) => {
    if (m.role !== "assistant") return m;
    let partsTouched = false;
    const parts = m.parts.map((p) => {
      const ptype = (p as { type?: string }).type ?? "";
      if (!ptype.startsWith("tool-") && ptype !== "dynamic-tool") return p;
      const state = (p as { state?: string }).state;
      if (state !== "output-available") return p;
      const output = (p as { output?: unknown }).output;
      if (
        output == null ||
        typeof output !== "object" ||
        Array.isArray(output)
      )
        return p;
      const keys = output as Record<string, unknown>;
      if (
        !("_effect" in keys) &&
        !("_outputWarnings" in keys) &&
        !("_outputWarningNote" in keys)
      )
        return p;
      partsTouched = true;
      const cleaned = stripInternalMeta(output);
      return { ...(p as object), output: cleaned } as typeof p;
    });
    if (!partsTouched) return m;
    touched = true;
    return { ...m, parts } as UIMessage;
  });
  return touched ? out : messages;
}

/**
 * Strip `data:<mediaType>;base64,` prefixes from file parts in model messages.
 *
 * `convertToModelMessages` copies `FileUIPart.url` (a data-URL) into
 * `FilePart.data` verbatim, but provider SDKs expect raw base64 or a URL
 * object — not a data-URL string. Without this fixup, Anthropic receives
 * invalid base64 and OpenAI double-wraps the prefix.
 */
function stripDataUrlPrefixes(messages: ModelMessage[]): ModelMessage[] {
  const DATA_URL_RE = /^data:[^;]+;base64,/;
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    let touched = false;
    const content = (
      m.content as { type: string; data?: unknown; [k: string]: unknown }[]
    ).filter((part) => {
      // Drop file parts with empty data (e.g. images stripped during session
      // persistence) — providers reject empty base64 payloads.
      if (part.type === "file" && typeof part.data === "string") {
        const raw = part.data.replace(DATA_URL_RE, "");
        if (!raw) { touched = true; return false; }
      }
      return true;
    }).map((part) => {
      if (
        part.type === "file" &&
        typeof part.data === "string" &&
        DATA_URL_RE.test(part.data)
      ) {
        touched = true;
        return { ...part, data: part.data.replace(DATA_URL_RE, "") };
      }
      return part;
    });
    return touched ? ({ ...m, content } as ModelMessage) : m;
  });
}

// The image→text swap for non-vision models now lives in ../extraction
// (swapImagePartsToText) — shared with the Telegram assistant so the two
// never drift. It runs on converted model messages, AFTER `convertToModel
// Messages`; the UI message keeps the image part so the transcript still
// renders the thumbnail.

/**
 * Post-conversion sanitizer, three defenses:
 *  1. Fix non-object tool-call inputs (Anthropic rejects
 *     "Input should be an object" for null/undefined inputs).
 *  2. Drop tool-result parts with an EMPTY tool_call_id — providers reject
 *     the whole request for them ("tool messages must include a non-empty
 *     string tool_call_id") and a single poison result makes the session
 *     unrecoverable. Empty ids can only come from malformed parts, so
 *     dropping (not patching) is correct: there is no matching call to
 *     attribute the result to.
 *  3. Drop tool-CALL parts whose input could not be salvaged and that have
 *     no matching result — nothing references them after their result is
 *     gone, and orphaned calls are rejected by every provider.
 */
function sanitizeModelMessages(messages: ModelMessage[]): ModelMessage[] {
  type AnyPart = { type: string; input?: unknown; toolCallId?: unknown; [k: string]: unknown };
  const validId = (v: unknown): v is string =>
    typeof v === "string" && v.trim() !== "";

  // Pass 1: fix non-object inputs; drop tool-CALL parts with invalid ids —
  // providers reject the whole request for them ("tool messages must include
  // a non-empty string tool_call_id") and a single poison part makes the
  // session unrecoverable on every retry.
  const fixed = messages.map((m): ModelMessage => {
    if (!Array.isArray(m.content)) return m;
    let touched = false;
    const content = (m.content as AnyPart[])
      .map((part) => {
        if (part.type === "tool-call" && (part.input == null || typeof part.input !== "object")) {
          touched = true;
          return { ...part, input: {} };
        }
        return part;
      })
      .filter((part) => {
        if (part.type === "tool-call" && !validId(part.toolCallId)) {
          touched = true;
          return false; // poison call with empty id
        }
        return true;
      });
    return touched ? ({ ...m, content } as ModelMessage) : m;
  });

  // Pass 2: collect surviving call ids, then drop tool-RESULT parts that are
  // invalid themselves or orphaned (their matching call was dropped above) —
  // every provider rejects results without a matching call.
  const keptCallIds = new Set<string>();
  for (const m of fixed) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as AnyPart[]) {
      if (part.type === "tool-call" && validId(part.toolCallId)) {
        keptCallIds.add(part.toolCallId);
      }
    }
  }
  return fixed.map((m): ModelMessage => {
    if (!Array.isArray(m.content)) return m;
    let touched = false;
    const content = (m.content as AnyPart[]).filter((part) => {
      if (
        part.type === "tool-result" &&
        (!validId(part.toolCallId) || !keptCallIds.has(part.toolCallId))
      ) {
        touched = true;
        return false;
      }
      return true;
    });
    return touched ? ({ ...m, content } as ModelMessage) : m;
  });
}

export async function runAgentStream(opts: RunAgentOptions) {
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID;
  const model = await buildConfiguredLanguageModel(
    modelId,
    opts.keys,
    opts.lmstudioBaseURL,
    opts.lmstudioModelId,
    opts.openaiCompatibleBaseURL,
    opts.openaiCompatibleModelId,
  );
  const provider = getModel(modelId).provider;

  const mcpBlock = opts.mcpSummary?.length
    ? `\n\n## MCP Tools\nThe following MCP servers are connected. Their tools are available alongside built-in tools (prefixed with servername__).\n${opts.mcpSummary.map((s) => {
        let entry = `- **${s.name}**: ${s.tools.join(", ")}`;
        if (s.instructions) {
          entry += `\n  Instructions: ${s.instructions}`;
        }
        return entry;
      }).join("\n")}`
    : "";

  const fencePrompt = opts.fenceState ? fenceSystemPrompt(opts.fenceState) : "";

  // Resolve vision capability ONCE, before both prompt assembly and the
  // history transform, so the model is never told it can see when the
  // request will strip images (and vice versa). For custom endpoints the
  // registry entry is a placeholder — consult the RUNTIME model name
  // (opts.lmstudioModelId / opts.openaiCompatibleModelId) so a locally-hosted
  // vision model actually receives the image. A user-set override
  // (Settings → Models → Vision) wins over both.
  const runtimeModelName =
    modelId === "lmstudio-local"
      ? opts.lmstudioModelId
      : modelId === "openai-compatible-custom"
        ? opts.openaiCompatibleModelId
        : null;
  const canSee = modelCanSee(
    modelId,
    runtimeModelName,
    opts.customVisionOverride,
  );

  const stableSystem = buildStableSystem(
    modelId,
    opts.agentPersona ?? null,
    opts.customInstructions,
    opts.projectMemory ?? null,
    opts.stackInfo ?? null,
  ) + mcpBlock + fencePrompt + (canSee ? "" : `\n\n${NO_VISION_NOTICE}`);

  const rawHistory = sanitizeModelMessages(
    stripDataUrlPrefixes(
      await convertToModelMessages(
        stripModelInternalMeta(stripIncompleteToolCalls(opts.uiMessages)),
        { ignoreIncompleteToolCalls: true },
      ),
    ),
  );
  // Text-only models (DeepSeek-class, GLM base, …) reject `file` parts.
  // Swap image parts for extracted text (dimensions + OCR) AFTER conversion —
  // the UI messages keep the image so the transcript still shows it. `canSee`
  // was resolved above (shared with prompt assembly).
  let swappedImageParts = 0;
  const history = normalizeForProvider(
    canSee
      ? rawHistory
      : await swapImagePartsToText(rawHistory),
    provider,
  );
  if (!canSee) {
    swappedImageParts = countInlineImageParts(rawHistory);
    if (swappedImageParts > 0) {
      appendSessionEvent(opts.toolContext.getSessionId() ?? "", {
        kind: "vision-ocr",
        swappedParts: swappedImageParts,
      });
    }
  }
  const compact = compactModelMessagesDetailed(
    history,
    getModelContextLimit(getModel(modelId).id),
  );
  const compactedHistory = compact.messages;
  if (compact.compacted) {
    opts.onCompact?.({ droppedCount: compact.droppedCount });
    // Journal the elision — the transcript stores the UN-elided history, so
    // without this line "what did the model actually see" is unrecoverable.
    appendSessionEvent(opts.toolContext.getSessionId() ?? "", {
      kind: "compact",
      droppedCount: compact.droppedCount,
      contextLimit: getModelContextLimit(getModel(modelId).id),
    });
  }

  const systemContent = opts.planMode
    ? `${stableSystem}\n\n${PLAN_MODE_PROMPT}`
    : stableSystem;
  const messages: ModelMessage[] = [{ role: "system", content: systemContent }];
  messages.push(...compactedHistory);

  const finalMessages = applyCacheBreakpoints(messages, provider);

  // Build provider-specific thinking / reasoning options.
  const thinkingMode: ThinkingMode = (opts.thinkingMode ?? "off") as ThinkingMode;
  const modelTags = getModel(modelId).tags;
  const isReasoningModel = modelTags?.includes("reasoning");
  // Custom endpoints (openai-compatible, LM Studio) always allow thinking
  // so users can control reasoning effort for their local models.
  const isCustomEndpoint = modelId === "openai-compatible-custom" || modelId === "lmstudio-local";
  const thinkingProviderOpts: Record<string, Record<string, unknown>> = {};
  if (thinkingMode !== "off" && (isReasoningModel || isCustomEndpoint)) {
    switch (provider) {
      case "anthropic":
        thinkingProviderOpts.anthropic = {
          thinking: {
            type: "enabled" as const,
            budgetTokens: THINKING_BUDGET_ANTHROPIC[thinkingMode],
          },
        };
        break;
      case "openai":
        thinkingProviderOpts.openai = {
          reasoningEffort: THINKING_EFFORT_OPENAI[thinkingMode],
        };
        break;
      case "google":
        thinkingProviderOpts.google = {
          thinkingConfig: {
            thinkingBudget: THINKING_BUDGET_GOOGLE[thinkingMode],
            includeThoughts: true,
          },
        };
        break;
      case "xai":
        // Grok chat endpoint only accepts "low" | "high"; medium maps to
        // "high" (see THINKING_EFFORT_XAI).
        thinkingProviderOpts.xai = {
          reasoningEffort: THINKING_EFFORT_XAI[thinkingMode],
        };
        break;
      case "groq":
        // Groq accepts reasoning_effort natively (and a reasoning-format
        // toggle).
        thinkingProviderOpts.groq = {
          reasoningEffort: THINKING_EFFORT_GROQ[thinkingMode],
        };
        break;
      case "openai-compatible":
      case "lmstudio":
        // OpenAI-compatible endpoints accept `reasoning_effort` natively
        // (vLLM, Ollama, Z.AI, Fireworks, ...). CRITICAL: @ai-sdk's
        // openai-compatible provider reads providerOptions under the NAME
        // passed to createOpenAICompatible (camelCase per v6 — SDK v6
        // still merges the hyphenated "openai-compatible" but warns it is
        // deprecated and will drop it; "lmstudio" is single-token so
        // unchanged) — any other key is silently dropped and the param
        // never sent. See the four-key merge in
        // @ai-sdk/openai-compatible/dist getArgs().
        thinkingProviderOpts[provider === "openai-compatible" ? "openaiCompatible" : provider] = {
          reasoningEffort: THINKING_EFFORT_OPENAI[thinkingMode],
        };
        break;
      case "openrouter":
        // OpenRouter normalizes reasoning across upstreams via its own
        // `reasoning` body param. openai-compatible passes unknown keys
        // under the provider name through to the request body verbatim,
        // so this lands as `"reasoning": {"effort": "..."}`.
        thinkingProviderOpts.openrouter = {
          reasoning: { effort: THINKING_EFFORT_OPENROUTER[thinkingMode] },
        };
        break;
      case "deepseek":
        // DeepSeek accepts `reasoning_effort` (low/high/max; its own
        // mapping sends requested "medium" to actual "high") in OpenAI
        // format. Parsed into reasoning_effort by the compat provider.
        thinkingProviderOpts.deepseek = {
          reasoningEffort: THINKING_EFFORT_DEEPSEEK[thinkingMode],
        };
        break;
      case "zai":
        // Z.AI GLM has no effort levels — the body-level `thinking` toggle
        // (passed through verbatim by the compat provider) is the only
        // control. Mode != off here, so thinking is enabled.
        thinkingProviderOpts.zai = {
          thinking: { type: "enabled" as const },
        };
        break;
    }
  }
  const hasProviderOpts = Object.keys(thinkingProviderOpts).length > 0;

  // Wrap model with DSML middleware to convert DSML tool calls from DeepSeek
  // V4 models (OpenRouter) into proper structured tool calls before the stream
  // completes, so the agent doesn't silently stop mid-thinking.
  const wrappedModel = wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
    middleware: createDsmlMiddleware(),
  });

  // Initialize stream guard for loop detection
  const streamGuard = getGlobalStreamGuard();
  let stepsSeen = 0;
  // Track consecutive identical tool invocations to catch a model stuck in a
  // "spam the same tool" loop. A single tool+args fingerprint repeated 3+ times
  // in a row is a runaway, not progress. Before the hard stop, the 2nd
  // identical call (same args AND identical output) earns the model a nudge —
  // dsh's repeat-tool-reminder pattern: give it one chance to change approach
  // instead of silently killing a run that may just be unlucky.
  const TOOL_LOOP_THRESHOLD = 3;
  const TOOL_LOOP_NUDGE = 2;
  // Minimum step text length that may enter the repetition window (see the
  // gate in onStepFinish — short procedural narration collides trivially).
  const GUARD_MIN_STEP_TEXT = 300;
  let lastToolFingerprint: string | null = null;
  let toolRepeatCount = 0;
  // Set by onStepFinish at TOOL_LOOP_NUDGE, consumed (and cleared) by
  // prepareStep on the next step. The nudge is injected into THAT request
  // only — it rides the model call without being committed to the persisted
  // transcript (same model-visible-ephemeral contract as the <env> block).
  // If the model ignores it and repeats once more, the count reaches
  // TOOL_LOOP_THRESHOLD and the run stops as before.
  let loopNudgeMessage: string | null = null;

  // Build and optionally fence tools for prompt-injection defense.
  //
  // Redaction is applied unconditionally and INNERMOST (see withToolRedaction)
  // — it is not an opt-in defense like fencing, it is the guarantee that
  // credentials never leave the machine. Order: redact → annotate → fence.
  const tools = buildTools(opts.toolContext, opts.mcpTools);
  const redactedTools = withToolRedaction(tools as Record<string, unknown>);
  // Central deny-only guard: the backstop for any tool that skipped its
  // inline security check — notably MCP tools, whose inputs we never see
  // server-side. It wraps the redaction layer so a denial short-circuits
  // BEFORE the real tool body runs; withToolGuard (outermost) then annotates
  // the returned {error} as ROLLED_BACK and fences it like any other result.
  const guardedTools = withCentralToolGuards(
    redactedTools as Record<string, Record<string, unknown>>,
    undefined,
    (name, reason) => {
      auditAppend(AUDIT_KINDS.securityDeny, "tool-guard", `${name}: ${reason}`.slice(0, 200), "");
    },
  );
  // Auto-verify uses getWorkspaceRoot (NOT getRealWorkspaceRoot): in a shadow
  // session the agent's edits land in the detached copy, and verification
  // must run against what the agent actually wrote — not the real tree it
  // hasn't touched yet.
  const fencedTools = opts.fenceState
    ? withToolGuard(
        guardedTools,
        opts.fenceState,
        opts.toolContext.getWorkspaceRoot,
      )
    : guardedTools;

  // Per-turn journal: the assembled context identity (system prompt hash,
  // vision decision, admitted tool names, model+flags). Append-only sidecar
  // evidence for "model-visible ⟺ logged" — see sessionEvents.ts.
  appendSessionEvent(
    opts.toolContext.getSessionId() ?? "",
    buildTurnEvent({
      modelId,
      provider,
      canSee,
      planMode: opts.planMode === true,
      autoApprove: opts.autoApprove ?? "off",
      thinkingMode: String(thinkingMode),
      systemPrompt: systemContent,
      toolNames: Object.keys(fencedTools).sort(),
      mcpServerCount: opts.mcpSummary?.length ?? 0,
      messageCount: finalMessages.length,
    }),
  );

  return streamText({
    model: wrappedModel,
    messages: finalMessages,
    tools: fencedTools,
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
    abortSignal: opts.abortSignal,
    // Inject a pending loop nudge into the immediate next request only.
    // Returning undefined leaves the step untouched (the common case).
    prepareStep: ({ messages: stepMessages }) => {
      const nudge = loopNudgeMessage;
      if (!nudge) return undefined;
      loopNudgeMessage = null;
      return {
        messages: [...stepMessages, { role: "user", content: nudge }],
      };
    },
    ...(hasProviderOpts ? { providerOptions: thinkingProviderOpts } : {}),
    onChunk: (chunk) => {
      // Live token-rate source for providers that don't report usage. A chunk
      // is a text delta; estimate ~4 chars/token (matches the compact.ts
      // approximation). This is the ONLY signal local endpoints emit.
      if (chunk.chunk.type === "text-delta" && chunk.chunk.text) {
        opts.onTextDelta?.(chunk.chunk.text);
      }
    },
    onStepFinish: (step) => {
      stepsSeen++;

      // Check for loop detection on BOTH visible text and reasoning output.
      // A "thinking loop" (model stuck re-deriving the same reasoning with no
      // visible text) is exactly the runaway case the user reported — reasoning
      // can blow past the context window while `step.text` stays empty.
      // GATE: only substantive text enters the similarity window. Short step
      // narrations ("Let me check that.") share almost their entire vocabulary,
      // so word-set Jaccard collide at >=0.85 across unrelated steps and the
      // guard killed healthy runs — which surfaced as "the agent just stops
      // after a tool call" (the stop wipes the error patch, see chatRuntime).
      const loopCandidate =
        step.text || (step as { reasoningText?: string }).reasoningText;
      if (
        loopCandidate &&
        loopCandidate.length >= GUARD_MIN_STEP_TEXT &&
        opts.onLoopDetected
      ) {
        const loopResult = streamGuard.check(loopCandidate);
        if (loopResult.isLooping) {
          opts.onLoopDetected(loopResult);
        }
      }

      // Detect repeated identical tool calls across steps (the "spamming" case
      // where the model re-issues the same command/file over and over). The
      // fingerprint includes tool OUTPUT digests, not just inputs — same args
      // with new output (log tailing, CI polling, re-running a test after an
      // edit) is progress, not a loop, and the old input-only check stopped
      // exactly those runs. Any *different* fingerprint resets the counter.
      const toolFingerprint = toolLoopFingerprint(step);
      if (toolFingerprint) {
        if (toolFingerprint === lastToolFingerprint) {
          toolRepeatCount++;
          // One advisory before the kill: the model already got byte-identical
          // output from a byte-identical call. Tell it to change approach,
          // summarize what it has, or stop — the very next repeat hard-stops.
          if (toolRepeatCount === TOOL_LOOP_NUDGE) {
            const toolName = step.toolCalls?.[0]?.toolName ?? "the same tool";
            appendSessionEvent(opts.toolContext.getSessionId() ?? "", {
              kind: "loop-nudge",
              toolName,
              repeatCount: toolRepeatCount,
            });
            loopNudgeMessage =
              `[kai loop guard] You have now called "${toolName}" ${toolRepeatCount} times in a row with identical arguments and received identical results back. Repeating the exact same call again will not change the outcome. Either change your approach (different arguments, a different tool, or read the result you already have), tell the user what you found and why you are stuck, or finish your turn. The next identical repetition stops this run.`;
          }
          if (toolRepeatCount >= TOOL_LOOP_THRESHOLD && opts.onLoopDetected) {
            opts.onLoopDetected({
              isLooping: true,
              detectedPattern: `Repeated tool: ${step.toolCalls?.[0]?.toolName ?? "?"}`,
              confidence: 0.95,
              suggestion:
                "Agent is repeatedly calling the same tool and getting identical results back. The run was stopped to break the loop.",
            });
          }
        } else {
          lastToolFingerprint = toolFingerprint;
          toolRepeatCount = 1;
        }
      } else {
        lastToolFingerprint = null;
        toolRepeatCount = 0;
      }

      if (opts.onStep) {
        const last = step.toolCalls?.[step.toolCalls.length - 1];
        if (last) {
          const status = presentationFor(last.toolName).status;
          opts.onStep(
            status
              ? status((last.input ?? {}) as Record<string, unknown>)
              : `Calling ${last.toolName}`,
          );
        } else if (step.text) {
          opts.onStep("Writing");
        }
      }
      if (opts.onUsage && step.usage) {
        const u = step.usage;
        const stepInput = u.inputTokens ?? 0;
        const stepCached = u.inputTokenDetails?.cacheReadTokens ?? 0;
        opts.onUsage({
          inputTokens: stepInput,
          outputTokens: u.outputTokens ?? 0,
          cachedInputTokens: stepCached,
          lastInputTokens: stepInput,
          lastCachedTokens: stepCached,
        });
      }
    },
    onFinish: (result) => {
      opts.onStep?.(null);
      // Reset stream guard on finish
      streamGuard.reset();
      const finishReason =
        (result as { finishReason?: string } | undefined)?.finishReason ?? "";
      opts.onFinishMeta?.({
        hitStepCap: stepsSeen >= MAX_AGENT_STEPS,
        finishReason,
      });
    },
  } as Parameters<typeof streamText>[0]);
}

export { EMPTY_USAGE };
