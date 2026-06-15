import type { UIMessage } from "@ai-sdk/react";
import { convertToModelMessages } from "ai";
import { getModel, getModelContextLimit, type ModelId } from "../config";
import {
  buildConfiguredLanguageModel,
  runAgentStream,
  type AgentUsageDelta,
} from "./agent";
import { compactModelMessagesDetailed } from "./compact";
import type { ProviderKeys } from "./keyring";
import { mcpManager } from "./mcpManager";
import { native } from "./native";
import {
  summarizeConversation,
  SUMMARY_KEEP_TAIL_PAIRS,
} from "./summarize";
import type { ToolContext } from "../tools/tools";
import { useChatStore } from "../store/chatStore";
import { IS_WINDOWS, IS_MAC, IS_LINUX } from "@/lib/platform";
import { saveMessages } from "./sessions";
import { extensionRegistry } from "./extensions";
import { agentBus } from "./eventBus";

const Kai_MD_MAX_BYTES = 32 * 1024;
type MemoryCacheEntry = { content: string | null; mtime: number };
const projectMemoryCache = new Map<string, MemoryCacheEntry>();

async function readKaiMd(workspaceRoot: string | null): Promise<string | null> {
  if (!workspaceRoot) return null;
  const path = `${workspaceRoot.replace(/\/$/, "")}/Kai.md`;
  const cached = projectMemoryCache.get(workspaceRoot);
  if (cached && Date.now() - cached.mtime < 30_000) return cached.content;
  try {
    const r = await native.readFile(path);
    if (r.kind !== "text") {
      projectMemoryCache.set(workspaceRoot, { content: null, mtime: Date.now() });
      return null;
    }
    const content =
      r.content.length > Kai_MD_MAX_BYTES
        ? r.content.slice(0, Kai_MD_MAX_BYTES)
        : r.content;
    projectMemoryCache.set(workspaceRoot, { content, mtime: Date.now() });
    return content;
  } catch {
    projectMemoryCache.set(workspaceRoot, { content: null, mtime: Date.now() });
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
};

type SendOptions = {
  messages: UIMessage[];
  abortSignal?: AbortSignal;
  [k: string]: unknown;
};

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
    const projectMemory = await readKaiMd(live.workspaceRoot);
    const envBlock = formatEnvBlock(live);
    let messagesForRun = envBlock
      ? injectEnvIntoLastUser(options.messages, envBlock)
      : options.messages;

    // ── Context summarization ───────────────────────────────────────
    // Check if the conversation is approaching the context limit. If so,
    // summarize older messages and replace the history before running.
    messagesForRun = await maybeSummarize(
      messagesForRun,
      deps,
      options.abortSignal,
    );
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
      projectMemory,
      uiMessages: messagesForRun,
      abortSignal: options.abortSignal,
      mcpTools: Object.keys(mcpTools).length > 0 ? mcpTools : undefined,
      mcpSummary: mcpSummary.length > 0 ? mcpSummary : undefined,
    });
    return result.toUIMessageStream({
      originalMessages: options.messages,
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

/** Minimum messages before summarization can trigger. */
const MIN_MESSAGES_FOR_SUMMARY = 12;

async function maybeSummarize(
  messages: UIMessage[],
  deps: Deps,
  abortSignal?: AbortSignal,
): Promise<UIMessage[]> {
  // Don't summarize tiny conversations.
  if (messages.length < MIN_MESSAGES_FOR_SUMMARY) return messages;

  const modelId = deps.getModelId();
  const contextLimit = getModelContextLimit(getModel(modelId).id);

  // Run the fast compaction check on the model-message form to see if we
  // need summarization (avoids duplicating byte-counting logic).
  const modelMsgs = await convertToModelMessages(messages);
  const compact = compactModelMessagesDetailed(modelMsgs, contextLimit);
  if (!compact.needsSummarization) return messages;

  // Signal the UI.
  useChatStore.getState().patchAgentMeta({ summarizing: true });

  try {
    const model = await buildConfiguredLanguageModel(
      modelId,
      deps.getKeys(),
      deps.getLmstudioBaseURL?.(),
      deps.getLmstudioModelId?.(),
      deps.getOpenaiCompatibleBaseURL?.(),
      deps.getOpenaiCompatibleModelId?.(),
    );

    const fileSnapshot = deps.toolContext.fileTracker.getSnapshot();
    const summary = await summarizeConversation(
      modelMsgs,
      model,
      abortSignal,
      fileSnapshot.length > 0 ? fileSnapshot : undefined,
    );

    // Find the tail cutoff in the UIMessage array.
    const cutoff = findUIMessageTailCutoff(messages, SUMMARY_KEEP_TAIL_PAIRS);
    const tail = messages.slice(cutoff);

    // Build a synthetic "assistant" message that carries the summary so it
    // appears in the conversation history naturally.
    const summaryMessage: UIMessage = {
      id: `summary-${Date.now()}`,
      role: "assistant",
      parts: [
        {
          type: "text",
          text: `> **Context summarized** — earlier messages were compressed.\n\n${summary}`,
        },
      ],
    };

    const trimmed = [summaryMessage, ...tail];

    // Persist the trimmed history so the session stays bounded.
    const sessionId = deps.getSessionId?.();
    if (sessionId) void saveMessages(sessionId, trimmed);

    useChatStore.getState().patchAgentMeta({
      summarizing: false,
      summaryNotice: { at: Date.now() },
    });

    return trimmed;
  } catch (e) {
    // Summarization failed — fall back to the original messages. The
    // existing elision in agent.ts will still help.
    console.warn("[kai] context summarization failed:", e);
    useChatStore.getState().patchAgentMeta({ summarizing: false });
    return messages;
  }
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
