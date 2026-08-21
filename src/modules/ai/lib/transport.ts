import type { UIMessage } from "@ai-sdk/react";
import { convertToModelMessages } from "ai";
import { getModel, getModelContextLimit, type ModelId } from "../config";
import {
  runAgentStream,
  type AgentUsageDelta,
  type StackInfo,
} from "./agent";
import { compactModelMessagesDetailed } from "./compact";
import type { ProviderKeys } from "./keyring";
import { mcpManager } from "./mcpManager";
import { buildSessionState } from "./sessionState";
import type { ToolContext } from "../tools/tools";
import { useChatStore } from "../store/chatStore";
import { useGoalsStore } from "../store/goalsStore";
import { IS_WINDOWS, IS_MAC, IS_LINUX } from "@/lib/platform";

import { extensionRegistry } from "./extensions";
import { agentBus } from "./eventBus";
import { createFenceState } from "./fence";
import { loadProjectRules, formatRulesForPrompt, type ProjectRules } from "./projectRules";
import { cleanOldCheckpoints } from "./checkpoints";
import { getRelevantFiles, formatRelevantFiles } from "./relevance";
import { loadProjectMemoryCached } from "./memory";

type RulesCacheEntry = { rules: ProjectRules | null; mtime: number };
const projectRulesCache = new Map<string, RulesCacheEntry>();

async function readProjectRules(workspaceRoot: string | null): Promise<ProjectRules | null> {
  if (!workspaceRoot) return null;
  const cached = projectRulesCache.get(workspaceRoot);
  if (cached && Date.now() - cached.mtime < 30_000) return cached.rules;
  try {
    const rules = await loadProjectRules(workspaceRoot);
    projectRulesCache.set(workspaceRoot, { rules, mtime: Date.now() });
    return rules;
  } catch {
    projectRulesCache.set(workspaceRoot, { rules: null, mtime: Date.now() });
    return null;
  }
}

type LiveSnapshot = {
  cwd: string | null;
  terminalPrivate: boolean;
  workspaceRoot: string | null;
  activeFile: string | null;
};

type Deps = {
  getKeys: () => ProviderKeys;
  toolContext: ToolContext;
  getModelId: () => ModelId;
  getCustomInstructions: () => string;
  getAgentPersona: () => { name: string; instructions: string } | null;
  getLive: () => LiveSnapshot;
  getLmstudioBaseURL?: () => string | undefined;
  getLmstudioModelId?: () => string | undefined;
  getOpenaiCompatibleBaseURL?: () => string | undefined;
  getOpenaiCompatibleModelId?: () => string | undefined;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta) => void;
  onCompact?: (info: { droppedCount: number }) => void;
  onFinishMeta?: (info: { hitStepCap: boolean; finishReason: string }) => void;
  getPlanMode?: () => boolean;
  getSessionId?: () => string | null;
  getStackInfo?: () => StackInfo | null;
  getThinkingMode?: () => string;
};

type SendOptions = {
  messages: UIMessage[];
  abortSignal?: AbortSignal;
  [k: string]: unknown;
};

/** Per-session fence state cache. Created once per session, never rotated. */
const fenceStateCache = new Map<string, import("./fence").FenceState>();

function getFenceState(sessionId: string): import("./fence").FenceState {
  let state = fenceStateCache.get(sessionId);
  if (!state) {
    state = createFenceState();
    fenceStateCache.set(sessionId, state);
  }
  return state;
}

/** Clear fence state when a session is deleted. */
export function clearFenceState(sessionId: string): void {
  fenceStateCache.delete(sessionId);
}

export function createContextAwareTransport(deps: Deps) {
  const run = async (options: SendOptions) => {
    const sessionId = deps.getSessionId?.() ?? "unknown";
    const modelId = deps.getModelId() ?? "unknown";
    agentBus.emit("agent:start", { sessionId });
    // Fire extension hooks (fire-and-forget, errors logged internally).
    for (const ext of extensionRegistry.getAll()) {
      if (ext.onAgentStart) void ext.onAgentStart({ sessionId, modelId });
    }

    let extensionStepCount = 0;

    const live = deps.getLive();
    const projectRules = await readProjectRules(live.workspaceRoot);
    const projectMemory = projectRules ? formatRulesForPrompt(projectRules) : null;
    // Load auto-memory (agent-written persistent project knowledge).
    const autoMemory = await loadProjectMemoryCached(live.workspaceRoot);
    const autoMemoryBlock = autoMemory?.trim()
      ? `\n\n## AUTO MEMORY — Agent-written project knowledge\n${autoMemory.trim()}`
      : "";
    const effectiveMemory = [projectMemory, autoMemoryBlock].filter(Boolean).join("\n") || null;
    // Clean old checkpoints (>1h) in background — fire-and-forget.
    if (live.workspaceRoot) void cleanOldCheckpoints(live.workspaceRoot);
    const envBlock = formatEnvBlock(live);
    // Add smart file context — discover potentially relevant files.
    const lastUserText = extractLastUserText(options.messages);
    const relevantFiles =
      lastUserText && live.workspaceRoot
        ? getRelevantFiles(lastUserText, deps.toolContext.fileTracker, [])
        : [];
    const relevantBlock = formatRelevantFiles(relevantFiles);
    const envWithRelevance = [envBlock, relevantBlock].filter(Boolean).join("\n") || null;
    // ── Context summarization ───────────────────────────────────────
    // Check if the conversation is approaching the context limit. If so,
    // summarize older messages and replace the history before running.
    // Run summarization on the clean messages (before env injection) so
    // the trimmed set can be fed back to the Chat as originalMessages.
    const summarized = await maybeSummarize(
      options.messages,
      deps,
      options.abortSignal,
    );
    const didSummarize = summarized !== options.messages;
    const messagesForRun = envWithRelevance
      ? injectEnvIntoLastUser(summarized, envWithRelevance)
      : summarized;
    // Gather MCP tools from all connected servers.
    const mcpTools = mcpManager.getActiveTools();
    const mcpSummary = mcpManager.getConnectedServerSummaries();

    // If auto-approve is 'all', tell the model it has full autonomy.
    const autoApprove = useChatStore.getState().autoApprove;
    const autoApproveHint =
      autoApprove === "all"
        ? "\n\n## AUTO-APPROVE MODE — ACTIVE\nAll tool calls (file edits, shell commands, etc.) are pre-approved and execute immediately. Do NOT stop to ask for permission or narrate what you're about to do — just call the tools directly. Chain all actions in a single turn until the task is complete."
        : autoApprove === "edits"
          ? "\n\n## AUTO-APPROVE MODE — EDITS ONLY\nFile mutations (write_file, edit, multi_edit, create_directory) are pre-approved. Shell commands still require approval. Do not stop to ask permission for file edits — just call the tool."
          : "";
    const effectiveCustomInstructions =
      (deps.getCustomInstructions() || "") + autoApproveHint;

    const result = await runAgentStream({
      keys: deps.getKeys(),
      modelId: deps.getModelId(),
      customInstructions: effectiveCustomInstructions,
      agentPersona: deps.getAgentPersona(),
      toolContext: deps.toolContext,
      onStep: (step) => {
        if (step !== null) extensionStepCount++;
        deps.onStep?.(step);
      },
      onUsage: deps.onUsage,
      onCompact: deps.onCompact,
      onFinishMeta: (info) => {
        deps.onFinishMeta?.(info);
        const finishReason = info.finishReason;
        agentBus.emit("agent:end", { sessionId, stepCount: extensionStepCount, finishReason });
        for (const ext of extensionRegistry.getAll()) {
          if (ext.onAgentEnd) void ext.onAgentEnd({ sessionId, modelId, stepCount: extensionStepCount, finishReason });
        }
      },
      lmstudioBaseURL: deps.getLmstudioBaseURL?.(),
      lmstudioModelId: deps.getLmstudioModelId?.(),
      openaiCompatibleBaseURL: deps.getOpenaiCompatibleBaseURL?.(),
      openaiCompatibleModelId: deps.getOpenaiCompatibleModelId?.(),
      planMode: deps.getPlanMode?.(),
      projectMemory: effectiveMemory,
      goalContext: useGoalsStore.getState().activeGoalId ?? undefined,
      stackInfo: deps.getStackInfo?.(),
      thinkingMode: deps.getThinkingMode?.() ?? "off",
      uiMessages: messagesForRun,
      abortSignal: options.abortSignal,
      mcpTools: Object.keys(mcpTools).length > 0 ? mcpTools : undefined,
      mcpSummary: mcpSummary.length > 0 ? mcpSummary : undefined,
      fenceState: getFenceState(sessionId),
    });
    // When summarization trimmed the history, pass the trimmed set as
    // originalMessages so the Chat instance adopts it. Otherwise the Chat
    // keeps the full pre-summary history, and every subsequent step
    // re-triggers summarization.
    return result.toUIMessageStream({
      originalMessages: didSummarize ? summarized : options.messages,
    });
  };

  return {
    sendMessages: run,
    async reconnectToStream(): Promise<null> {
      return null;
    },
  };
}

function injectEnvIntoLastUser(
  messages: UIMessage[],
  envBlock: string,
): UIMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const parts = m.parts as ReadonlyArray<{ type: string; text?: string }>;
    let textIdx = -1;
    for (let j = 0; j < parts.length; j++) {
      if (parts[j].type === "text") {
        textIdx = j;
        break;
      }
    }
    const nextParts =
      textIdx === -1
        ? [{ type: "text", text: envBlock }, ...parts]
        : parts.map((p, idx) =>
            idx === textIdx
              ? { ...p, text: `${envBlock}\n\n${p.text ?? ""}` }
              : p,
          );
    const out = messages.slice();
    out[i] = { ...m, parts: nextParts } as UIMessage;
    return out;
  }
  return messages;
}

/** Extract text from the last user message for relevance matching. */
function extractLastUserText(messages: UIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const parts = m.parts as ReadonlyArray<{ type: string; text?: string }>;
    return parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!)
      .join("\n")
      .slice(0, 2000);
  }
  return null;
}

function formatEnvBlock(live: LiveSnapshot): string | null {
  const lines: string[] = [];
  const os = IS_WINDOWS ? "windows" : IS_MAC ? "macos" : IS_LINUX ? "linux" : "unknown";
  const shell = IS_WINDOWS ? "powershell" : "bash";
  lines.push(`os: ${os}`);
  lines.push(`shell: ${shell}`);
  if (live.workspaceRoot) lines.push(`workspace_root: ${live.workspaceRoot}`);
  if (live.cwd) lines.push(`active_terminal_cwd: ${live.cwd}`);
  if (live.activeFile) lines.push(`active_file: ${live.activeFile}`);
  if (live.terminalPrivate) lines.push("active_terminal_mode: private");
  return `<env>\n${lines.join("\n")}\n</env>`;
}

// ── Context summarization ─────────────────────────────────────────────

/** Number of trailing user/assistant message pairs to keep verbatim
 *  when compacting the conversation history. */
const SUMMARY_KEEP_TAIL_PAIRS = 6;

/** Minimum estimated tokens before summarization is worth considering.
 *  Below this, even a 32K-context model has enough room — summarization
 *  overhead would be larger than the savings. */
const MIN_TOKEN_ESTIMATE_FOR_SUMMARY = 16_000;

async function maybeSummarize(
  messages: UIMessage[],
  deps: Deps,
  _abortSignal?: AbortSignal,
): Promise<UIMessage[]> {
  const modelId = deps.getModelId();
  const contextLimit = getModelContextLimit(getModel(modelId).id);

  // Run the fast compaction check on the model-message form to see if we
  // need summarization (avoids duplicating byte-counting logic).
  const modelMsgs = await convertToModelMessages(messages);
  const compact = compactModelMessagesDetailed(modelMsgs, contextLimit);
  if (!compact.needsSummarization) return messages;

  // Gate on actual token volume — skip summarization if the conversation
  // is too small for it to be worth the overhead.
  const tokenEstimate = JSON.stringify(modelMsgs).length / 4;
  if (tokenEstimate < MIN_TOKEN_ESTIMATE_FOR_SUMMARY) return messages;

  const fileSnapshot = deps.toolContext.fileTracker.getSnapshot();
  const stateBlock = buildSessionState({
    messages,
    fileSnapshot,
    sessionId: deps.getSessionId?.() ?? null,
  });

  // Trim to the last N message pairs, prepend the session state snapshot.
  const cutoff = findUIMessageTailCutoff(messages, SUMMARY_KEEP_TAIL_PAIRS);
  const tail = messages.slice(cutoff);

  const summaryMessage: UIMessage = {
    id: `summary-${Date.now()}`,
    role: "assistant",
    parts: [{ type: "text", text: stateBlock }],
  };

  const trimmed = [summaryMessage, ...tail];

  // Persistence is handled by AgentRunBridge which fires on every
  // messages change, including after summarization replaces history.
  return trimmed;
}

/** Find tail cutoff index in UIMessage[] (counts user messages as pairs). */
function findUIMessageTailCutoff(
  messages: UIMessage[],
  keepPairs: number,
): number {
  let pairs = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") pairs++;
    if (pairs >= keepPairs) return i;
  }
  return 0;
}

// ── Misc ──────────────────────────────────────────────────────────────

export const CONTEXT_BLOCK_RE =
  /^<terminal-context[^>]*>[\s\S]*?<\/terminal-context>\n*/;

export function stripContextBlock(text: string): string {
  return text.replace(CONTEXT_BLOCK_RE, "");
}
