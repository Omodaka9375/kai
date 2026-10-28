import type { UIMessage } from "@ai-sdk/react";
import { convertToModelMessages } from "ai";
import { invoke } from "@tauri-apps/api/core";
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
import { appendSessionEvent, sessionEventsClear } from "./sessionEvents";
import type { FileSnapshot } from "./fileTracker";
import type { ToolContext } from "../tools/tools";
import { useChatStore, registerRunController } from "../store/chatStore";
import { IS_WINDOWS, IS_MAC, IS_LINUX } from "@/lib/platform";

import { extensionRegistry } from "./extensions";
import { agentBus } from "./eventBus";
import { createFenceState } from "./fence";
import { clearSessionProvenance } from "./provenance";
import { loadProjectRules, formatRulesForPrompt, type ProjectRules } from "./projectRules";
import { cleanOldCheckpoints, sweepLegacyCheckpoints } from "./checkpoints";
import { getRelevantFiles, formatRelevantFiles } from "./relevance";
import { loadProjectMemoryCached } from "./memory";
import { getShadow } from "./shadow";

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

// ── Verified environment inventory (agent <env> block) ──────────────────
// Probed once per process by the Rust side (fs_env_inventory) and cached in
// Tauri state. Replaces the hardcoded `shell: powershell` — the agent shell
// may be pwsh 7, and the wrong shell assumption poisons every downstream
// quoting/syntax decision. Also kills the 3-6 "what's installed?" probe
// calls each session used to burn.
export type EnvInventory = {
  shell: string;
  shellVersion: string | null;
  tools: Array<{
    name: string;
    present: boolean;
    version: string | null;
    path: string | null;
  }>;
  probeMs: number;
};

let envInventoryCache: EnvInventory | null = null;

export function getCachedEnvInventory(): EnvInventory | null {
  return envInventoryCache;
}

export async function fetchEnvInventory(): Promise<EnvInventory | null> {
  if (envInventoryCache) return envInventoryCache;
  try {
    const inv = await invoke<EnvInventory>("fs_env_inventory");
    envInventoryCache = inv;
    return inv;
  } catch (e) {
    console.warn("[Kai] env inventory probe failed:", e);
    return null;
  }
}

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
  getCustomVisionOverride?: () => import("@/modules/ai/config").VisionOverride | null;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta) => void;
  onTextDelta?: (text: string) => void;
  onCompact?: (info: { droppedCount: number }) => void;
  onFinishMeta?: (info: { hitStepCap: boolean; finishReason: string }) => void;
  onLoopDetected?: (info: import("./streamGuard").LoopDetectionResult) => void;
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
    state = createFenceState(sessionId);
    fenceStateCache.set(sessionId, state);
  }
  return state;
}

/** Clear fence state when a session is deleted. */
export function clearFenceState(sessionId: string): void {
  fenceStateCache.delete(sessionId);
  // The session can't fetch again after deletion — drop its provenance flag.
  clearSessionProvenance(sessionId);
  // …and remove its event journal (per-session data dies with the session).
  // Both delete paths route through here, so one call covers them.
  sessionEventsClear(sessionId);
}

export function createContextAwareTransport(deps: Deps) {
  const run = async (options: SendOptions) => {
    const sessionId = deps.getSessionId?.() ?? "unknown";
    const modelId = deps.getModelId() ?? "unknown";

    // Create + register our own abort controller for this run so the Stop
    // button can always kill it, even when the AI SDK's Chat.stop() is a
    // no-op (status is neither streaming nor submitted). We listen to the
    // SDK's signal too so either path aborts the other.
    const runController = new AbortController();
    if (sessionId !== "unknown") registerRunController(sessionId, runController);
    const sdkSignal = options.abortSignal;
    const forwardAbort = () => runController.abort();
    sdkSignal?.addEventListener("abort", forwardAbort, { once: true });
    const effectiveSignal = runController.signal;

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
    if (live.workspaceRoot) {
      void cleanOldCheckpoints(live.workspaceRoot);
      void sweepLegacyCheckpoints(live.workspaceRoot);
    }
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
      onTextDelta: deps.onTextDelta,
      onCompact: deps.onCompact,
      onLoopDetected: deps.onLoopDetected,
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
      customVisionOverride: deps.getCustomVisionOverride?.() ?? null,
      planMode: deps.getPlanMode?.(),
      projectMemory: effectiveMemory,
      stackInfo: deps.getStackInfo?.(),
      thinkingMode: deps.getThinkingMode?.() ?? "off",
      uiMessages: messagesForRun,
      abortSignal: effectiveSignal,
      autoApprove,
      mcpTools: Object.keys(mcpTools).length > 0 ? mcpTools : undefined,
      mcpSummary: mcpSummary.length > 0 ? mcpSummary : undefined,
      fenceState: getFenceState(sessionId),
    });
    // When summarization trimmed the history, pass the trimmed set as
    // originalMessages so the Chat instance adopts it. Otherwise the Chat
    // keeps the full pre-summary history, and every subsequent step
    // re-triggers summarization.
    // NOTE: we deliberately do NOT unregister `runController` here.
    // `toUIMessageStream()` returns synchronously, before the stream is read,
    // so unregistering now would leave a window where the Stop button can't
    // reach the in-flight run. Instead the controller stays registered until
    // (a) the next run replaces it (registerRunController aborts+overwrites),
    // or (b) the session is deleted (deleteSession). abortRunController also
    // removes it after aborting.
    //
    // The same holds for the `forwardAbort` listener: it must stay attached
    // for the entire streaming phase. Removing it after runAgentStream
    // returns (which resolves as soon as streamText() returns its result
    // object — before the SDK reads a single chunk) disconnected Chat.stop()
    // for the whole run: the SDK aborted its signal into a dead listener and
    // the model kept streaming. The listener is `{ once: true }` and the SDK
    // allocates a fresh AbortController per makeRequest, so there is no leak
    // and no cross-run interference (a late fire on a superseded controller
    // is a no-op).
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
  const base = formatEnvBlockInner(live);
  // Shadow session: tools already resolve against the shadow copy — tell
  // the model so it doesn't warn the user about paths that don't exist in
  // the real tree, and knows merge/discard is the user's call at the end.
  const shadow = getShadow(live.workspaceRoot);
  if (!shadow) return base;
  const note = `\n<shadow-session>\nYou are working in a DETACHED COPY of the project. Your file/shell tools operate on the copy — edits are NOT in the real project until the user merges. Do not tell the user to check the real tree; the merge prompt appears automatically when they finish.\n</shadow-session>`;
  return base ? `${base}${note}` : note;
}

/**
 * A compact, unambiguous local-date string for the agent env block.
 * Format: `YYYY-MM-DD (Weekday, UTC±HH:MM TZ-name)`.
 *   - ISO date: no locale ambiguity (no 10/24 vs 24/10 confusion).
 *   - Weekday: lets the model reason about "today/this week/weekend".
 *   - UTC offset + IANA zone: enough to resolve time-of-day questions and
 *     convert to/from the user's clock, without injecting a volatile wall
 *     time that would churn the block every second.
 * Exported for tests. Intl is always available in the WebView2/WebKit
 * runtimes KAI targets; the try/catch degrades to a plain ISO date if a
 * zone lookup ever throws (e.g. an exotic/missing ICU on a stripped build).
 */
export function envLocalDate(now: Date = new Date()): string {
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  try {
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(now);
    const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    // UTC offset in ±HH:MM form.
    const offsetMin = -now.getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    const offset = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
    return tzName ? `${iso} (${weekday}, ${offset} ${tzName})` : `${iso} (${weekday}, ${offset})`;
  } catch {
    return iso;
  }
}

function formatEnvBlockInner(live: LiveSnapshot): string | null {
  const lines: string[] = [];
  const os = IS_WINDOWS ? "windows" : IS_MAC ? "macos" : IS_LINUX ? "linux" : "unknown";
  // Local date at snapshot time. LLMs have no clock and otherwise guess a
  // stale training-cutoff date when asked "what day is it" or when a task is
  // time-sensitive (cutoffs, "today", "this week"). Computed per build so a
  // long-lived session's env block reflects the real current day.
  lines.push(`local_date: ${envLocalDate()}`);
  // Verified shell from the Rust probe when available — falls back to the
  // old static guess only if the probe never ran.
  const inv = envInventoryCache;
  const shell = inv?.shell ?? (IS_WINDOWS ? "powershell" : "bash");
  lines.push(`os: ${os}`);
  lines.push(`shell: ${shell}${inv?.shellVersion ? ` (${inv.shellVersion})` : ""}`);
  if (inv) {
    const present = inv.tools.filter((t) => t.present);
    const absent = inv.tools.filter((t) => !t.present);
    if (present.length > 0) {
      lines.push(
        `installed: ${present
          .map((t) => (t.version ? `${t.name} ${t.version.split(" ").slice(-1)[0]}` : t.name))
          .join(", ")}`,
      );
    }
    if (absent.length > 0) {
      lines.push(
        `absent: ${absent.map((t) => t.name).join(", ")} (do not probe for these; offer the install instead)`,
      );
    }
  }
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

/**
 * Build the compacted form of a conversation: a deterministic
 * `<session_state>` snapshot (task, files touched, plan, error hints)
 * followed by the last SUMMARY_KEEP_TAIL_PAIRS message pairs. Shared by
 * the automatic threshold path (`maybeSummarize`) and the user-driven
 * `/compact` command — no model call, fully deterministic.
 *
 * Returns null when there is nothing worth compacting (too few pairs or
 * too little content — replacing a short history with a snapshot would
 * LOSE context instead of saving it).
 */
export function summarizeMessagesNow(
  messages: UIMessage[],
  fileSnapshot: FileSnapshot[],
  sessionId: string | null,
): UIMessage[] | null {
  // Nothing to compact if the tail already covers the whole conversation.
  const cutoff = findUIMessageTailCutoff(messages, SUMMARY_KEEP_TAIL_PAIRS);
  if (cutoff <= 0) return null;

  // Trivially small conversations gain nothing — the snapshot block would
  // cost nearly as much as the history it replaces. (The automatic path
  // has its own token threshold; this is the manual floor.)
  let chars = 0;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "text") chars += (p as { text?: string }).text?.length ?? 0;
    }
  }
  if (chars / 4 < 2_000) return null;

  const stateBlock = buildSessionState({ messages, fileSnapshot, sessionId });
  const tail = trimTailToolResults(messages.slice(cutoff));

  const summaryMessage: UIMessage = {
    id: `summary-${Date.now()}`,
    role: "assistant",
    parts: [{ type: "text", text: stateBlock }],
  };
  return [summaryMessage, ...tail];
}

/**
 * The kept tail is what made /compact fail to shrink the ring for local
 * models: the last N pairs hold the conversation's LARGEST payloads —
 * fresh shell output, file reads, screen captures — and keeping them
 * verbatim leaves the history over-budget even after the older messages
 * are summarized away. The tool-result outputs in the tail have already
 * served their purpose (the model acted on them); what still matters is
 * the call's existence and shape, not the full body. Truncate their
 * output objects to a compact placeholder, mirroring what auto-elision
 * does to older tool results. Text and other parts pass through
 * untouched. Returns a new array/message objects only when something
 * actually changed (id-stable copies otherwise).
 */
const TAIL_TOOL_OUTPUT_MAX_CHARS = 500;

function trimTailToolResults(tail: UIMessage[]): UIMessage[] {
  let anyChanged = false;
  const out = tail.map((m) => {
    if (
      !m.parts.some(
        (p) => typeof p.type === "string" && p.type.startsWith("tool-"),
      )
    ) {
      return m;
    }
    let msgChanged = false;
    const parts = m.parts.map((p) => {
      if (typeof p.type !== "string" || !p.type.startsWith("tool-")) return p;
      const tp = p as unknown as { output?: unknown };
      if (tp.output == null || typeof tp.output !== "object") return p;
      const serialized = JSON.stringify(tp.output);
      if (serialized.length <= TAIL_TOOL_OUTPUT_MAX_CHARS) return p;
      msgChanged = true;
      return {
        ...p,
        output: {
          note: "[output elided by /compact — already shown in full above]",
        },
      } as typeof p;
    });
    if (!msgChanged) return m;
    anyChanged = true;
    return { ...m, parts };
  });
  return anyChanged ? out : tail;
}

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


  // Surface the compressing state in the chat UI (spinner + notice).
  useChatStore.getState().patchAgentMeta({ summarizing: true });
  try {
    const fileSnapshot = deps.toolContext.fileTracker.getSnapshot();
    const sessionId = deps.getSessionId?.() ?? null;
    const trimmed = summarizeMessagesNow(messages, fileSnapshot, sessionId);
    // summarizeMessagesNow returns null below its floor — but this path
    // only runs past the token gates above, so null would mean the tail
    // already covers everything. Keep the original in that case.
    const out = trimmed ?? messages;
    // Journal the compaction: the summarized-away originals are GONE from
    // the store, so fromCount→toCount is the only surviving proof of what
    // the model no longer sees (dsh: model-visible ⟺ logged).
    if (sessionId && out !== messages) {
      appendSessionEvent(sessionId, {
        kind: "summarize",
        trigger: "auto",
        fromCount: messages.length,
        toCount: out.length,
      });
    }

    useChatStore.getState().patchAgentMeta({
      summarizing: false,
      summaryNotice: { at: Date.now() },
    });

    // Persistence is handled by AgentRunBridge which fires on every
    // messages change, including after summarization replaces history.
    return out;
  } catch (err) {
    useChatStore.getState().patchAgentMeta({ summarizing: false });
    throw err;
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
