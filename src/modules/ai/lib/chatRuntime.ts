/**
 * Chat runtime — pure Chat-lifecycle construction, decoupled from the store.
 *
 * Extracted from `store/chatStore.ts`. Everything the runtime needs from the
 * store (active session, live context, keys, model selection, meta patches)
 * arrives through the `ChatRuntimeDeps` port — the runtime itself has NO
 * zustand import and NO import of chatStore, so it is unit-testable without
 * the store (and cannot grow new store cycles).
 *
 * The run-controller registry and the `isActive()` guard live in chatStore;
 * the runtime only calls the injected `abortRunController` when it detects
 * an agent loop, mirroring the pre-extraction behavior exactly.
 */

import { Chat, type UIMessage } from "@ai-sdk/react";
import {
  type ChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import { getModel, getModelContextLimit, type ModelId } from "../config";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { BUILTIN_AGENTS } from "../lib/agents";
import { useAgentsStore } from "../store/agentsStore";
import { usePlanStore } from "../store/planStore";
import type { AgentUsage } from "../lib/agent";
import type { StackInfo } from "../lib/stackDetector";
import { detectStack } from "../lib/stackDetector";
import { createContextAwareTransport } from "../lib/transport";
import { loadShadow, withShadowRedirect } from "../lib/shadow";
import { FileTracker } from "../lib/fileTracker";
import { type ProviderKeys } from "../lib/keyring";
import type { LoopDetectionResult } from "../lib/streamGuard";
import type { ToolContext } from "../tools/tools";

/** Store/ambient state the runtime reads or writes, injected by chatStore. */
export type ChatRuntimeDeps = {
  /** Current agent-meta tokens usage (for context-limit arithmetic). */
  getTokens: () => AgentUsage;
  /** Live context accessors — same shape as `Live` in chatStore. */
  live: {
    getCwd: () => string | null;
    getTerminalContext: () => string | null;
    isActiveTerminalPrivate: () => boolean;
    injectIntoActivePty: (text: string) => boolean;
    getWorkspaceRoot: () => string | null;
    openPreview: (url: string) => boolean;
  };
  /** Keys read lazily per request (key rotation needs no chat rebuild). */
  getKeys: () => ProviderKeys;
  /** Currently selected model id. */
  getSelectedModelId: () => ModelId;
  /** True when this session is the active one (stream-callback guard). */
  isActiveSession: (sessionId: string) => boolean;
  /** Patch agent meta — only called when the session is active. */
  patchAgentMeta: (patch: Partial<AgentMeta>) => void;
  /** Abort the app-owned run controller for a session (loop detection). */
  abortRunController: (sessionId: string) => void;
};

export type AgentRunStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "awaiting-approval"
  | "error";

export type AgentMeta = {
  status: AgentRunStatus;
  step: string | null;
  approvalsPending: number;
  error: string | null;
  tokens: AgentUsage;
  lastInputTokens: number;
  lastCachedTokens: number;
  hitStepCap: boolean;
  /** Raw finish reason from the provider (stop, length, tool-calls, etc.). */
  finishReason: string;
  compactionNotice: { droppedCount: number; at: number } | null;
  /** True while the model is generating a context summary. */
  summarizing: boolean;
  /** Shown after summarization completes. */
  summaryNotice: { at: number } | null;
  /** Rolling output tokens per second, updated during streaming. */
  outputTps: number;
};

const ZERO_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

export const IDLE_META: AgentMeta = {
  status: "idle",
  step: null,
  approvalsPending: 0,
  error: null,
  tokens: ZERO_USAGE,
  lastInputTokens: 0,
  lastCachedTokens: 0,
  hitStepCap: false,
  finishReason: "",
  compactionNotice: null,
  summarizing: false,
  summaryNotice: null,
  outputTps: 0,
};

/**
 * Create a Chat instance synchronously. Stack detection happens in the
 * background and stackInfo will be updated via the getStackInfo callback.
 */
export function makeChatSync(
  sessionId: string,
  deps: ChatRuntimeDeps,
  seedMessages: Map<string, UIMessage[]>,
  resolveErrorDisplay: (raw: unknown) => string,
): Chat<UIMessage> {
  const readCache = new Map<string, { size: number; hash: number }>();

  // The Chat outlives its owning session switch: switching to another
  // session does NOT stop this chat, so its stream callbacks keep firing.
  // Without a guard, a run started in session A would overwrite session B's
  // `agentMeta` (status/step/tokens/error) after the user has switched away.
  const isActive = () => deps.isActiveSession(sessionId);

  // Start stack detection in the background - don't block chat creation
  const workspaceRoot = deps.live.getWorkspaceRoot();
  let stackInfo: StackInfo | null = null;
  if (workspaceRoot) {
    detectStack(workspaceRoot)
      .then((detected) => {
        stackInfo = detected;
      })
      .catch(() => {
        // Stack detection failed silently - continue without it
      });
  }

  const streamStartedAtRef = { current: null as number | null };
  // Chunk-based tok/s for providers that never report `usage` (LM Studio,
  // Ollama, openai-compatible). We accumulate streamed text chars and estimate
  // tokens at ~4 chars/token; `sawUsageOutputTokens` switches off this fallback
  // once the provider reports real usage so API models keep their exact count.
  const chunkStreamStartedAtRef = { current: null as number | null };
  const chunkCharsRef = { current: 0 };
  const sawUsageOutputTokensRef = { current: false };
  // The "context compacted" notice fires on every agent turn once stale reads
  // and large tool results start getting elided — which is noise, not signal.
  // Surface it once per session, then stay quiet.
  const compactionNoticeShown = { current: false };
  // Late-bound ref to the Chat instance so stream callbacks (which are built
  // before the Chat exists) can stop it on loop detection. Assigned right
  // after the Chat is constructed below.
  const chatRef: { current: Chat<UIMessage> | null } = { current: null };

  const toolContext: ToolContext = (() => {
    // Base context from live state, with shadow-session redirection: while
    // a shadow session is active for this project, tools see the shadow
    // tree (cwd + workspace root translated). Real paths pass through when
    // no shadow is active, so behavior is unchanged by default.
    const base = {
      getCwd: () => deps.live.getCwd(),
      getWorkspaceRoot: () => deps.live.getWorkspaceRoot(),
    };
    const redirected = withShadowRedirect(base);
    // Load (don't await) — a shadow created mid-session is picked up on the
    // next tool call via getShadow, which reads the resident map lazily.
    void loadShadow(base.getWorkspaceRoot()).catch(() => undefined);
    return {
      ...redirected,
      getTerminalContext: () => deps.live.getTerminalContext(),
      isActiveTerminalPrivate: () => deps.live.isActiveTerminalPrivate(),
      injectIntoActivePty: (text: string) => deps.live.injectIntoActivePty(text),
      openPreview: (url: string) => deps.live.openPreview(url),
      readCache,
      getSessionId: () => sessionId,
      fileTracker: new FileTracker(),
      getRemainingContextTokens: () => {
        const tokens = deps.getTokens();
        const modelId = deps.getSelectedModelId();
        const limit = getModelContextLimit(getModel(modelId).id);
        const used = tokens.inputTokens + tokens.outputTokens;
        return Math.max(0, limit - used);
      },
    };
  })();

  const transport = createContextAwareTransport({
    getKeys: () => deps.getKeys(),
    toolContext,
    getModelId: () => deps.getSelectedModelId(),
    getCustomInstructions: () =>
      usePreferencesStore.getState().customInstructions,
    getAgentPersona: () => {
      const { activeId, customAgents } = useAgentsStore.getState();
      if (activeId === "__none__") return null;
      const all = [...BUILTIN_AGENTS, ...customAgents];
      const a = all.find((x) => x.id === activeId) ?? BUILTIN_AGENTS[0];
      return { name: a.name, instructions: a.instructions };
    },
    getLive: () => {
      return {
        cwd: deps.live.getCwd(),
        terminalPrivate: deps.live.isActiveTerminalPrivate(),
        workspaceRoot: deps.live.getWorkspaceRoot(),
        activeFile: null,
      };
    },
    getPlanMode: () => usePlanStore.getState().active,
    getLmstudioBaseURL: () => usePreferencesStore.getState().lmstudioBaseURL,
    getLmstudioModelId: () => usePreferencesStore.getState().lmstudioModelId,
    getOpenaiCompatibleBaseURL: () =>
      usePreferencesStore.getState().openaiCompatibleBaseURL,
    getOpenaiCompatibleModelId: () =>
      usePreferencesStore.getState().openaiCompatibleModelId,
    getSessionId: () => sessionId,
    getStackInfo: () => stackInfo,
    // Resolve the effective thinking mode for the *selected* model: a
    // per-model override wins, otherwise the global default applies.
    getThinkingMode: () => {
      const prefs = usePreferencesStore.getState();
      const selectedModelId = deps.getSelectedModelId();
      // The openai-compatible-custom model uses its own dedicated
      // thinking mode so local endpoints (vLLM, Ollama, etc.) can
      // control reasoning effort without a model-specific override.
      if (selectedModelId === "openai-compatible-custom") {
        return prefs.openaiCompatibleThinkingMode ?? "off";
      }
      return (
        prefs.modelThinkingModes[selectedModelId] ??
        prefs.thinkingMode ??
        "off"
      );
    },
    onStep: (step) => {
      if (step === null) {
        streamStartedAtRef.current = null;
        chunkStreamStartedAtRef.current = null;
        chunkCharsRef.current = 0;
        sawUsageOutputTokensRef.current = false;
      }
      if (isActive()) deps.patchAgentMeta({ step });
    },
    onTextDelta: (text: string) => {
      if (!isActive()) return;
      const now = Date.now();
      if (chunkStreamStartedAtRef.current === null) {
        chunkStreamStartedAtRef.current = now;
        chunkCharsRef.current = 0;
      }
      chunkCharsRef.current += text.length;
      // Do not override the usage-based rate for providers that report usage.
      if (sawUsageOutputTokensRef.current) return;
      const elapsedMs = now - chunkStreamStartedAtRef.current;
      const estTokens = chunkCharsRef.current / 4;
      const tps =
        estTokens > 0 && elapsedMs > 0
          ? Math.round(estTokens / (elapsedMs / 1000))
          : 0;
      deps.patchAgentMeta({ outputTps: tps });
    },
    onCompact: (info: { droppedCount: number }) => {
      if (!isActive()) return;
      // Show once per session — elision recurs every turn once the history is
      // large enough, and repeating the notice is just noise.
      if (compactionNoticeShown.current) return;
      compactionNoticeShown.current = true;
      deps.patchAgentMeta({
        compactionNotice: { droppedCount: info.droppedCount, at: Date.now() },
      });
    },
    onLoopDetected: (info: LoopDetectionResult) => {
      if (!isActive()) return;
      // A model stuck repeating itself won't stop on its own — kill the run.
      // The abort controller makes this reliable even when the SDK status has
      // already left streaming/submitted.
      deps.abortRunController(sessionId);
      void chatRef.current?.stop();
      deps.patchAgentMeta({
        status: "error",
        error: info.suggestion ?? "Agent detected in a loop and was stopped.",
      });
    },
    onFinishMeta: (info: { hitStepCap: boolean; finishReason: string }) => {
      if (!isActive()) return;
      deps.patchAgentMeta({
        hitStepCap: info.hitStepCap,
        finishReason: info.finishReason,
      });
    },
    onUsage: (delta: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      lastInputTokens: number;
      lastCachedTokens: number;
    }) => {
      if (!isActive()) return;
      const cur = deps.getTokens();
      const newOutputTokens = cur.outputTokens + delta.outputTokens;
      const now = Date.now();
      // Track stream start on first output tokens.
      let streamStartedAt = streamStartedAtRef.current;
      if (streamStartedAt === null && delta.outputTokens > 0) {
        streamStartedAt = now;
        streamStartedAtRef.current = streamStartedAt;
      }
      // Once the provider reports real usage, the chunk-based estimate is
      // superseded — flip the flag so onTextDelta stops overwriting outputTps.
      if (delta.outputTokens > 0) {
        sawUsageOutputTokensRef.current = true;
      }
      const elapsedMs = streamStartedAt !== null ? now - streamStartedAt : 0;
      const outputTps =
        streamStartedAt !== null && newOutputTokens > 0 && elapsedMs > 0
          ? Math.round(
              (newOutputTokens / (elapsedMs / 1000)),
            )
          : 0;
      deps.patchAgentMeta({
        tokens: {
          inputTokens: cur.inputTokens + delta.inputTokens,
          outputTokens: newOutputTokens,
          cachedInputTokens: cur.cachedInputTokens + delta.cachedInputTokens,
        },
        lastInputTokens: delta.lastInputTokens,
        lastCachedTokens: delta.lastCachedTokens,
        outputTps,
      });
    },
  }) as unknown as ChatTransport<UIMessage>;

  const initialMessages = seedMessages.get(sessionId);
  seedMessages.delete(sessionId);

  const chat = new Chat<UIMessage>({
    id: sessionId,
    transport,
    messages: initialMessages,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onError: (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      // Suppress stale approval errors — these fire when a tool call was
      // cleaned up (stop/restart/steering) but the AI SDK's internal
      // approval matching still references the old ID. Not actionable.
      // Two variants:
      //  - "Tool call X not found for approval request Y"
      //  - "Tool approval response references unknown approvalId: Y"
      if (
        msg.includes("not found for approval request") ||
        msg.includes("unknown approvalId") ||
        msg.includes("No matching tool-approval-request")
      ) {
        console.debug("[kai] suppressed stale approval error:", msg);
        return;
      }
      // Surface RetryError details. The AI SDK wraps provider errors in
      // RetryError with an `errors` array. The top-level message is generic
      // ("Failed after 3 attempts. Last error: Provider returned an error"),
      // but the underlying APICallError has the actual status code, response
      // body, and URL. Extract those so the user sees actionable info.
      if (!isActive()) return;
      // Log the raw error BEFORE reducing it to a display string. The stack
      // (and, in dev builds, React's attached `componentStack`) is the only
      // way to diagnose render-loop errors like React #185 ("Maximum update
      // depth exceeded"), which surface here as a bare minified message.
      // console.error is bridged into the on-disk log by lib/logging.ts, so
      // the details survive even if the console is closed.
      console.error(
        "[kai] agent error:",
        e,
        (e as { componentStack?: unknown }).componentStack ?? "",
      );
      const display = resolveErrorDisplay(e);
      deps.patchAgentMeta({
        status: "error",
        error: display,
      });
    },
  });
  chatRef.current = chat;
  return chat;
}
