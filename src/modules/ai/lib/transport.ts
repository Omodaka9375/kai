import type { UIMessage } from "@ai-sdk/react";
import { convertToModelMessages } from "ai";
import { invoke } from "@tauri-apps/api/core";
import { getModel, getModelContextLimit, type ModelId } from "../config";
import {
  runAgentStream,
  PLAN_MODE_PROMPT,
  type AgentUsageDelta,
  type StackInfo,
} from "./agent";
import { compactModelMessagesDetailed } from "./compact";
import { summarizeMediaOutputs } from "./media/modelSummary";
import type { ProviderKeys } from "./keyring";
import { mcpManager } from "./mcpManager";
import { buildSessionState } from "./sessionState";
import { appendSessionEvent, sessionEventsClear } from "./sessionEvents";
import type { FileSnapshot } from "./fileTracker";
import type { ToolContext } from "../tools/tools";
import {
  getSessionAutoApprove,
  registerRunController,
  useChatStore,
} from "../store/chatStore";
import { IS_WINDOWS, IS_MAC, IS_LINUX } from "@/lib/platform";
import {
  classifyWithEngine,
  decideReflex,
  reflexDisabled,
  REFLEX_MAX_PROMPT_CHARS,
} from "./localReflex";
import { executeReflexCalls, reflexAssistantStream } from "./localReflexExecute";
import { isReflexCapableTool, recordReflexEntry } from "./reflexLog";

type AgentToolCall = { toolName: string; input: unknown };

/**
 * Create a per-run step miner closing over `{ sessionId, prompt }`.
 * Bound to the individual `runAgentStream` call via `opts.onToolCalls` so it
 * stays alive for the full stream and never collides across concurrent sessions.
 */
function createStepMiner(
  sessionId: string,
  prompt: string,
): (calls: AgentToolCall[]) => void {
  const truncated = prompt.slice(0, 200);
  return (calls: AgentToolCall[]) => {
    for (const call of calls) {
      if (!isReflexCapableTool(call.toolName)) continue;
      const args =
        call.input && typeof call.input === "object"
          ? (call.input as Record<string, unknown>)
          : {};
      recordReflexEntry({
        ts: Date.now(),
        sessionId,
        outcome: "mined-llm-tool",
        prompt: truncated,
        calls: [{ name: call.toolName, arguments: args }],
      });
    }
  };
}
import { usePreferencesStore } from "@/modules/settings/preferences";
import { formatReplyStyleBlock } from "./replyStyle";

import { extensionRegistry } from "./extensions";
import { createFenceState, fence, type FenceState } from "./fence";
import { clearSessionProvenance } from "./provenance";
import {
  loadProjectRules,
  formatRulesForPrompt,
  type ProjectRules,
} from "./projectRules";
import { cleanOldCheckpoints, sweepLegacyCheckpoints } from "./checkpoints";
import { getRelevantFiles, formatRelevantFiles } from "./relevance";
import { loadProjectMemoryCached } from "./memory";
import { getSessionPreferences } from "../store/sessionPreferences";
import { getShadow } from "./shadow";
import { nativeForContext } from "../tools/context";
import { workspaceScopeKey } from "@/modules/workspace/env";

type RulesCacheEntry = { rules: ProjectRules | null; mtime: number };
const projectRulesCache = new Map<string, RulesCacheEntry>();

async function readProjectRules(
  workspaceRoot: string | null,
  client: ReturnType<typeof nativeForContext>,
): Promise<ProjectRules | null> {
  if (!workspaceRoot) return null;
  const key = `${workspaceScopeKey(client.env)}:${workspaceRoot}`;
  const cached = projectRulesCache.get(key);
  if (cached && Date.now() - cached.mtime < 30_000) return cached.rules;
  try {
    const rules = await loadProjectRules(workspaceRoot, client);
    projectRulesCache.set(key, { rules, mtime: Date.now() });
    return rules;
  } catch {
    projectRulesCache.set(key, { rules: null, mtime: Date.now() });
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
  getOpenaiCompatibleBaseURL?: () => string | undefined;
  getOpenaiCompatibleModelId?: () => string | undefined;
  getCustomVisionOverride?: () =>
    import("@/modules/ai/config").VisionOverride | null;
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

/**
 * Fence AGENT-AUTHORED cross-project group text as UNTRUSTED data for a
 * receiving session (2026-11-01 audit, Code Reviewer: multi-hop injection
 * laundering). The fence uses the TARGET session's OWN trusted tool nonce —
 * declared in its system prompt — so the model treats the delivered text
 * (which may quote hostile fenced tool output from another project) as
 * data, never instructions. User-sent text is NOT fenced (the user is in
 * the trust zone per fence.ts's boundary model).
 */
export function fenceGroupText(sessionId: string, content: string): string {
  return fence("tool", getSessionFenceState(sessionId).nonces.tool, content, {
    source: "cross-project group chat",
  });
}

export function getFenceStateForTest(sessionId: string): FenceState {
  return getSessionFenceState(sessionId);
}

export function getSessionFenceState(sessionId: string): import("./fence").FenceState {
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
    if (sessionId !== "unknown")
      registerRunController(sessionId, runController);
    const sdkSignal = options.abortSignal;
    const forwardAbort = () => runController.abort();
    sdkSignal?.addEventListener("abort", forwardAbort, { once: true });
    const effectiveSignal = runController.signal;

    // Fire extension hooks (fire-and-forget, errors logged internally).
    for (const ext of extensionRegistry.getAll()) {
      if (ext.onAgentStart) void ext.onAgentStart({ sessionId, modelId });
    }

    let extensionStepCount = 0;

    // ── LOCAL REFLEX fast path (Needle 3, 2026-11-23) ────────────────
    // Short desktop-control prompts ("switch to dark mode", "play groove
    // salad") are classified by the local Needle engine before ANY cloud
    // work. Execute + synthetic stream on a confident auto-approve-safe
    // call; any other outcome (engine down, [], low confidence, disallowed
    // tool, grounding failure) falls through to the full LLM run below.
    // Zero cloud prefill on the fast path; ~1.5 s worst-case probe on the
    // fall-through path when the engine is absent (failure cached 60 s).
    let minedPrompt: { sessionId: string; prompt: string } | null = null;
    if ((options as { trigger?: string }).trigger !== "regenerate-message") {
      const rawReflexText = extractLastUserText(options.messages);
      const reflexText = rawReflexText
        ? stripContextBlock(rawReflexText).trim()
        : null;
      const reflexEligible =
        !!reflexText &&
        reflexText.length <= REFLEX_MAX_PROMPT_CHARS &&
        lastUserMessageIsTextOnly(options.messages);
      if (reflexEligible && reflexText) {
        if (reflexDisabled()) {
          recordReflexEntry({
            ts: Date.now(),
            sessionId,
            outcome: "fallthrough",
            prompt: reflexText.slice(0, 200),
            reason: "disabled",
          });
        } else {
          const reply = await classifyWithEngine(reflexText);
          const decision = decideReflex(reflexText, reply);
          if (decision.action === "execute") {
            const exec = await executeReflexCalls(decision.calls, deps.toolContext);
            recordReflexEntry({
              ts: Date.now(),
              sessionId,
              outcome: "executed",
              prompt: reflexText.slice(0, 200),
              confidence: decision.confidence,
              calls: decision.calls,
              latencyMs: reply?.latencyMs,
              execOk: exec.ok,
            });
            if (exec.ok || exec.partial) {
              deps.onStep?.("local reflex");
              // Compact execution summary + a small italic provenance label.
              // On partial multi-call execution, return what already ran + the
              // error instead of falling through and double-firing call 1.
              const summary =
                exec.lines.map((l) => `${l}`).join("\n") +
                "\n\n*(local reflex)*";
              return reflexAssistantStream(summary);
            }
          } else {
            recordReflexEntry({
              ts: Date.now(),
              sessionId,
              outcome: "fallthrough",
              prompt: reflexText.slice(0, 200),
              reason: decision.reason,
              confidence: reply?.confidence,
              latencyMs: reply?.latencyMs,
            });
          }
        }
        minedPrompt = { sessionId, prompt: reflexText };
      }
    }

    const live = deps.getLive();
    const projectNative = nativeForContext(deps.toolContext);
    const projectRules = await readProjectRules(
      live.workspaceRoot,
      projectNative,
    );
    const projectMemory = projectRules
      ? formatRulesForPrompt(projectRules)
      : null;
    // Load auto-memory (agent-written persistent project knowledge).
    // MEMORY-BLIND SESSIONS (/clean, 2026-11-16): a memoryClean session
    // skips ONLY this block — the project's MEMORY.md stays on disk and
    // every other session/agent keeps loading it. The session still gets
    // KAI.md project rules (architecture facts, not accumulated
    // conclusions — a memory-blind agent still needs to navigate the
    // repo) and can still save_memory (writes the shared file, so
    // discoveries made with fresh eyes persist).
    const autoMemory =
      sessionId !== "unknown" &&
      getSessionPreferences(sessionId).memoryClean === true
        ? null
        : await loadProjectMemoryCached(live.workspaceRoot, projectNative);
    const autoMemoryBlock = autoMemory?.trim()
      ? `\n\n## AUTO MEMORY — Agent-written project knowledge\n${autoMemory.trim()}`
      : "";
    const effectiveMemory =
      [projectMemory, autoMemoryBlock].filter(Boolean).join("\n") || null;
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
    // PER-TURN MODE BLOCKS (2026-11-20): auto-approve and plan-mode hints
    // ride the LAST-USER injection (same slot as the env block) instead of
    // the system prompt. Toggling Allow/Ask or plan mode used to REBUILD the
    // system prompt mid-session, which invalidates Anthropic 5.x thinking-
    // block signatures (the prefix check covers system + tools + messages)
    // and 400s the whole run. The last-user slot is per-turn content, so
    // the system prompt stays byte-stable for the life of the session.
    const sessionIdForRun = deps.getSessionId?.() ?? null;
    const autoApprove = sessionIdForRun
      ? getSessionAutoApprove(sessionIdForRun)
      : useChatStore.getState().autoApprove;
    const autoApproveHint =
      autoApprove === "all"
        ? "## AUTO-APPROVE MODE — ACTIVE\nAll tool calls (file edits, shell commands, etc.) are pre-approved and execute immediately. Do NOT stop to ask for permission or narrate what you're about to do — just call the tools directly. Chain all actions in a single turn until the task is complete."
        : "";
    const planModeBlock = deps.getPlanMode?.() ? PLAN_MODE_PROMPT : "";
    const envWithRelevance =
      [envBlock, relevantBlock, autoApproveHint, planModeBlock]
        .filter(Boolean)
        .join("\n\n") || null;
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

    // REPLY STYLE (2026-11-19): structured "how to write to me" fields from
    // Settings -> Agents (HUMANS.md-inspired). Preferences only, appended
    // after the user's prose instructions so both survive intact. Empty
    // (all defaults) adds no bytes - prompts stay prefix-cache friendly.
    // NOTE: the auto-approve hint does NOT live here anymore - it rides the
    // per-turn last-user injection above so a mid-session mode toggle can
    // never change the system prompt (Anthropic 5.x signature prefix rule).
    const replyStyleBlock = formatReplyStyleBlock(
      usePreferencesStore.getState().replyStyle,
    );
    const effectiveCustomInstructions =
      (deps.getCustomInstructions() || "") +
      (replyStyleBlock ? `\n\n${replyStyleBlock}` : "");

    const result = await runAgentStream({
      keys: deps.getKeys(),
      modelId: deps.getModelId(),
      customInstructions: effectiveCustomInstructions,
      agentPersona: deps.getAgentPersona(),
      toolContext: deps.toolContext,
      onToolCalls: minedPrompt
        ? createStepMiner(minedPrompt.sessionId, minedPrompt.prompt)
        : undefined,
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
        for (const ext of extensionRegistry.getAll()) {
          if (ext.onAgentEnd)
            void ext.onAgentEnd({
              sessionId,
              modelId,
              stepCount: extensionStepCount,
              finishReason,
            });
        }
      },
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
      fenceState: getSessionFenceState(sessionId),
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

/** True when the last user message carries ONLY text parts - the reflex
 *  must never hijack prompts with images, files, or data attachments. */
function lastUserMessageIsTextOnly(messages: UIMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const parts = m.parts as ReadonlyArray<{ type: string }>;
    return parts.every((p) => p.type === "text");
  }
  return false;
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
    const weekday = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
    }).format(now);
    const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    // UTC offset in ±HH:MM form.
    const offsetMin = -now.getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    const offset = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
    return tzName
      ? `${iso} (${weekday}, ${offset} ${tzName})`
      : `${iso} (${weekday}, ${offset})`;
  } catch {
    return iso;
  }
}

function formatEnvBlockInner(live: LiveSnapshot): string | null {
  const lines: string[] = [];
  const os = IS_WINDOWS
    ? "windows"
    : IS_MAC
      ? "macos"
      : IS_LINUX
        ? "linux"
        : "unknown";
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
  lines.push(
    `shell: ${shell}${inv?.shellVersion ? ` (${inv.shellVersion})` : ""}`,
  );
  if (inv) {
    const present = inv.tools.filter((t) => t.present);
    const absent = inv.tools.filter((t) => !t.present);
    if (present.length > 0) {
      lines.push(
        `installed: ${present
          .map((t) =>
            t.version
              ? `${t.name} ${t.version.split(" ").slice(-1)[0]}`
              : t.name,
          )
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
  const cutoff = findUIMessageTailCutoff(messages, SUMMARY_KEEP_TAIL_PAIRS);

  // Count ALL payload mass (text, uploaded file data-URLs, tool outputs),
  // not just plain text — a chat with 6 base64 images and short text prompts
  // can exceed 200% context while having < 2,000 text tokens.
  let chars = 0;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "text" || p.type === "reasoning") {
        chars += (p as { text?: string }).text?.length ?? 0;
      } else if (p.type === "file") {
        const fp = p as { url?: string; data?: string };
        chars += (fp.url ?? fp.data ?? "").length;
      } else if (typeof p.type === "string" && p.type.startsWith("tool-")) {
        const tp = p as unknown as { output?: unknown };
        if (tp.output != null && typeof tp.output === "object") {
          chars += JSON.stringify(tp.output).length;
        }
      }
    }
  }
  if (chars / 4 < 2_000) return null;

  // Even when the whole conversation fits inside the 6-pair tail (cutoff <= 0),
  // still run tail image elision and tool-output trimming so a short chat with
  // 6 large images or huge tool outputs can be compacted in place.
  if (cutoff <= 0) {
    const trimmed = elideTailImageParts(trimTailToolResults(messages));
    return trimmed === messages ? null : trimmed;
  }

  const stateBlock = buildSessionState({ messages, fileSnapshot, sessionId });
  const tail = elideTailImageParts(trimTailToolResults(messages.slice(cutoff)));

  const summaryMessage: UIMessage = {
    id: `summary-${Date.now()}`,
    role: "assistant",
    parts: [{ type: "text", text: stateBlock }],
  };
  return [summaryMessage, ...tail];
}

/**
 * TAIL IMAGE ELISION (2026-11-23, "uploaded 6 images -> 200%, /compact
 * stayed at 120%" report): uploaded photos ride user messages as `file`
 * parts carrying FULL base64 data-URLs, and the kept tail preserves its
 * messages verbatim — so a multi-image upload inside the tail could never
 * be shrunk by /compact. Replace every payload-bearing image `file` part in
 * the tail — EXCEPT those on a trailing, unanswered user message (a live
 * upload the model hasn't seen yet) — with a `<attachment>` text pointer.
 * Wrapping in `<attachment>` ensures `stripUserContextBlocks` hides the
 * machine note from the user's chat bubble while the model still sees it.
 */
function elideTailImageParts(tail: UIMessage[]): UIMessage[] {
  // Keep images ONLY on a trailing user message that has no assistant reply
  // after it (i.e. the active prompt currently being sent to the model).
  // Once an assistant message follows it, the model has already seen those
  // images and manual /compact can safely elide them.
  let keepUserIdx = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i].role === "user") {
      const hasAssistantAfter = tail
        .slice(i + 1)
        .some((m) => m.role === "assistant");
      if (!hasAssistantAfter) keepUserIdx = i;
      break;
    }
  }
  let anyChanged = false;
  const out = tail.map((m, i) => {
    if (i === keepUserIdx) return m;
    if (!m.parts.some((p) => isPayloadImageFilePart(p))) return m;
    anyChanged = true;
    const hasSavedPath = m.parts.some(
      (p) =>
        p.type === "text" &&
        /<attachment\b[^>]*savedAt="/.test((p as { text?: string }).text ?? ""),
    );
    return {
      ...m,
      parts: m.parts.map((p) => {
        if (!isPayloadImageFilePart(p)) return p;
        const name = String((p as { filename?: string }).filename ?? "attachment");
        const safeName = name.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        const note = hasSavedPath
          ? `[image ${name} elided by /compact to save context — re-read it from its savedAt path if needed]`
          : `[image ${name} elided by /compact to save context]`;
        return {
          type: "text",
          text: `<attachment elided="true" name="${safeName}">${note}</attachment>`,
        } as typeof p;
      }),
    };
  });
  return anyChanged ? out : tail;
}

/** True for an image `file` part that actually carries an inline payload
 *  (skipping already-stripped post-restart stubs like `data:image/png;base64`). */
function isPayloadImageFilePart(p: { type?: string }): boolean {
  if (p.type !== "file") return false;
  const fp = p as { mediaType?: string; url?: string; data?: string };
  const mt = fp.mediaType ?? "";
  if (!mt.startsWith("image/")) return false;
  const payload = fp.url ?? fp.data ?? "";
  if (!payload) return false;
  if (payload.startsWith("data:")) {
    const comma = payload.indexOf(",");
    return comma !== -1 && payload.length - comma - 1 > 0;
  }
  return payload.length > 0;
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
  const modelMsgs = summarizeMediaOutputs(await convertToModelMessages(messages));
  const compact = compactModelMessagesDetailed(modelMsgs, contextLimit);
  if (!compact.needsSummarization) return messages;

  // Gate on actual token volume — skip summarization if the conversation
  // is too small for it to be worth the overhead. Generated-media display
  // payloads are not model tokens and must not trip this gate.
  const tokenEstimate = JSON.stringify(modelMsgs).length / 4;
  if (tokenEstimate < MIN_TOKEN_ESTIMATE_FOR_SUMMARY) return messages;

  // Surface the compressing state in the chat UI (spinner + notice).
  useChatStore.getState().patchAgentMeta({ summarizing: true });
  // PAINT YIELD (2026-11-17 report: "on long chats, after a break, my first
  // message makes the whole AI panel go blank then recovers"): everything
  // above plus summarizeMessagesNow below is one continuous synchronous
  // main-thread block over the full history. Without this yield the commit
  // that shows the spinner never PAINTS — the block starts in the same
  // task — and WebView2 (transparent window) drops its last presented frame
  // during the multi-second block, so the panel goes blank until the run
  // starts. Double-rAF guarantees the spinner is on screen; the timeout
  // keeps a hidden/throttled webview (background session woken by a
  // watch) from stalling on a rAF that fires once per minute.
  await yieldForPaint();
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

/** Yield to the renderer long enough for the previous commit to PAINT.
 *
 *  Double requestAnimationFrame (the second fires after the frame that
 *  composites the first's layout), raced against a timeout: hidden/
 *  backgrounded webviews throttle rAF to ~1/min (WebView2 timer policy)
 *  and a purely-rAF yield would stall a background session's run — the
 *  watch-wake path — for a full minute. 80ms covers two frames at 60Hz
 *  with slack, and even when the timeout loses the race the commit has
 *  usually painted; the block that follows merely starts ~immediately
 *  instead of after the second frame. */
export function yieldForPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") {
      setTimeout(resolve, 0);
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      resolve();
    };
    const fallback = setTimeout(done, 80);
    requestAnimationFrame(() => {
      requestAnimationFrame(done);
    });
  });
}

export const CONTEXT_BLOCK_RE =
  /^<terminal-context[^>]*>[\s\S]*?<\/terminal-context>\n*/;

export function stripContextBlock(text: string): string {
  return text.replace(CONTEXT_BLOCK_RE, "");
}
