import { Chat, type UIMessage } from "@ai-sdk/react";
import {
  type ChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import { create } from "zustand";
import {
  DEFAULT_MODEL_ID,
  getModel,
  getModelContextLimit,
  providerNeedsKey,
  type ModelId,
  type ProviderId,
} from "../config";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { BUILTIN_AGENTS } from "../lib/agents";
import { useAgentsStore } from "./agentsStore";
import { usePlanStore } from "./planStore";
import { useTodosStore } from "./todoStore";
import type { AgentUsage } from "../lib/agent";
import { EMPTY_PROVIDER_KEYS, type ProviderKeys } from "../lib/keyring";
import {
  deleteSessionData,
  deriveTitle,
  forkSession as forkSessionFromStore,
  loadAll,
  loadMessages,
  newSessionId,
  saveActiveId,
  saveMessages,
  saveSessionsList,
  type SessionMeta,
} from "../lib/sessions";
import { pushRecentModel, persistProjectModel } from "../lib/modelPrefs";
import { cancelAllShellSessions } from "../tools/shell";
import { createContextAwareTransport } from "../lib/transport";
import { clearFenceState } from "../lib/transport";
import { reapSessionWatches, closeWatchSessionShell } from "../tools/watch";
import type { ToolContext } from "../tools/tools";
import { resetEditFailures } from "../tools/edit";
import { FileTracker } from "../lib/fileTracker";
import { agentBus } from "../lib/eventBus";
import { detectStack, type StackInfo } from "../lib/stackDetector";

type Live = {
  getCwd: () => string | null;
  getTerminalContext: () => string | null;
  isActiveTerminalPrivate: () => boolean;
  injectIntoActivePty: (text: string) => boolean;
  getWorkspaceRoot: () => string | null;
  getActiveFile: () => string | null;
  openPreview: (url: string) => boolean;
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

const IDLE_META: AgentMeta = {
  status: "idle",
  step: null,
  approvalsPending: 0,
  error: null,
  tokens: ZERO_USAGE,
  lastInputTokens: 0,
  lastCachedTokens: 0,
  hitStepCap: false,
  compactionNotice: null,
  summarizing: false,
  summaryNotice: null,
  outputTps: 0,
};

export type MiniState = {
  open: boolean;
};

export type PendingSelection = {
  id: string;
  text: string;
  source: "terminal" | "editor";
};

export type ApprovalResponder = (
  approvalId: string,
  approved: boolean,
) => void;

/** Auto-approve modes: off = manual, edits = file mutations only, all = everything. */
export type AutoApproveMode = "off" | "edits" | "all";

/** Tool names that are file mutations (auto-approved in 'edits' mode). */
export const FILE_MUTATION_TOOLS = new Set([
  "write_file",
  "edit",
  "multi_edit",
  "create_directory",
]);

/** Tool names that are shell commands (only auto-approved in 'all' mode). */
export const SHELL_TOOLS = new Set([
  "bash_run",
  "bash_background",
]);

type StoreState = {
  live: Live;
  setLive: (live: Live) => void;

  /**
   * Set by AgentRunBridge each render. Lets surfaces outside the chat hook
   * tree (e.g. the AI diff tab in the editor area) resolve a pending tool
   * approval through the active session's `addToolApprovalResponse`.
   */
  approvalResponder: ApprovalResponder | null;
  setApprovalResponder: (fn: ApprovalResponder | null) => void;
  respondToApproval: (approvalId: string, approved: boolean) => void;

  apiKeys: ProviderKeys;
  setApiKeys: (keys: ProviderKeys) => void;
  setApiKey: (provider: ProviderId, key: string | null) => void;

  selectedModelId: ModelId;
  setSelectedModelId: (id: ModelId) => void;

  mini: MiniState;
  openMini: () => void;
  closeMini: () => void;
  toggleMini: () => void;

  panelOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;

  focusSignal: number;
  pendingPrefill: string | null;
  focusInput: (prefill?: string | null) => void;
  consumePrefill: () => string | null;

  pendingSelections: PendingSelection[];
  attachSelection: (text: string, source: "terminal" | "editor") => void;
  consumeSelections: () => PendingSelection[];

  agentMeta: AgentMeta;
  /** Monotonic tick for forcing re-renders (e.g. injected watch messages). */
  _tick: number;
  patchAgentMeta: (patch: Partial<AgentMeta>) => void;
  resetAgentMeta: () => void;

  /** Auto-approve mode — resets to 'off' on new session and app restart. */
  autoApprove: AutoApproveMode;
  setAutoApprove: (mode: AutoApproveMode) => void;
  /** Cycle through off → edits → all → off. */
  cycleAutoApprove: () => void;
  /** Set of approval IDs that were auto-approved (for UI rendering). */
  autoApprovedIds: Set<string>;
  markAutoApproved: (id: string) => void;

  // Sessions
  sessionsHydrated: boolean;
  lastHydratedWorkspace: string | null;
  sessions: SessionMeta[];
  activeSessionId: string | null;
  hydrateSessions: (workspaceRoot?: string | null) => Promise<void>;
  newSession: () => string;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  /** Persist messages of a session and bump its updatedAt + auto-title. */
  persistMessages: (id: string, messages: UIMessage[]) => void;
  /** Inject a system-originated user message (e.g. watch result) without triggering a new agent run. */
  injectMessage: (id: string, text: string) => void;
  /** Fork the current session at a message index, creating a new branch. */
  forkSession: (atMessageIndex: number) => Promise<string | null>;
  /** Steering message queued while agent is busy. */
  steeringMessage: string | null;
  setSteeringMessage: (msg: string | null) => void;
};

const NOOP_LIVE: Live = {
  getCwd: () => null,
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  injectIntoActivePty: () => false,
  getWorkspaceRoot: () => null,
  getActiveFile: () => null,
  openPreview: () => false,
};

const CHATS_LRU_CAP = 8;
const chats = new Map<string, Chat<UIMessage>>();

function touchChat(id: string, c: Chat<UIMessage>) {
  if (chats.has(id)) chats.delete(id);
  chats.set(id, c);
  while (chats.size > CHATS_LRU_CAP) {
    const oldest = chats.keys().next().value;
    if (!oldest || oldest === id) break;
    if (useChatStore.getState().activeSessionId === oldest) break;
    flushPersistEntry(oldest);
    void chats.get(oldest)?.stop();
    chats.delete(oldest);
  }
}
// Initial messages for a session, populated at hydration time and consumed
// when the matching Chat is constructed.
const seedMessages = new Map<string, UIMessage[]>();

// Trailing debounce for per-token message persistence. Streaming fires
// `persistMessages` on every token; without this we'd JSON-serialize the
// full message array and round-trip to the store plugin per token, which
// stalls the UI. Flush on idle (status transition) via `flushPersist`.
const PERSIST_DEBOUNCE_MS = 300;
const pendingPersist = new Map<
  string,
  { latest: UIMessage[]; timer: ReturnType<typeof setTimeout> }
>();

function flushPersistEntry(id: string) {
  const entry = pendingPersist.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingPersist.delete(id);
  void saveMessages(id, entry.latest);
}

export function flushPersist(id?: string): void {
  if (id) {
    flushPersistEntry(id);
    return;
  }
  for (const key of Array.from(pendingPersist.keys())) flushPersistEntry(key);
}

/**
 * Create a Chat instance synchronously. Stack detection happens in the
 * background and stackInfo will be updated via the getStackInfo callback.
 */
function makeChatSync(sessionId: string): Chat<UIMessage> {
  const readCache = new Map<string, { size: number; hash: number }>();

  // Start stack detection in the background - don't block chat creation
  const workspaceRoot = useChatStore.getState().live.getWorkspaceRoot();
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

  const toolContext: ToolContext = {
    getCwd: () => useChatStore.getState().live.getCwd(),
    getWorkspaceRoot: () =>
      useChatStore.getState().live.getWorkspaceRoot(),
    getTerminalContext: () =>
      useChatStore.getState().live.getTerminalContext(),
    isActiveTerminalPrivate: () =>
      useChatStore.getState().live.isActiveTerminalPrivate(),
    injectIntoActivePty: (text) =>
      useChatStore.getState().live.injectIntoActivePty(text),
    openPreview: (url) => useChatStore.getState().live.openPreview(url),
    readCache,
    getSessionId: () => sessionId,
    fileTracker: new FileTracker(),
    getRemainingContextTokens: () => {
      const tokens = useChatStore.getState().agentMeta.tokens;
      const modelId = useChatStore.getState().selectedModelId;
      const limit = getModelContextLimit(getModel(modelId).id);
      const used = tokens.inputTokens + tokens.outputTokens;
      return Math.max(0, limit - used);
    },
  };

  const transport = createContextAwareTransport({
    getKeys: () => useChatStore.getState().apiKeys,
    toolContext,
    getModelId: () => useChatStore.getState().selectedModelId,
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
      const live = useChatStore.getState().live;
      return {
        cwd: live.getCwd(),
        terminalPrivate: live.isActiveTerminalPrivate(),
        workspaceRoot: live.getWorkspaceRoot(),
        activeFile: live.getActiveFile(),
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
      const { selectedModelId } = useChatStore.getState();
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
      }
      useChatStore.getState().patchAgentMeta({ step });
    },
    onCompact: (info) => {
      useChatStore.getState().patchAgentMeta({
        compactionNotice: { droppedCount: info.droppedCount, at: Date.now() },
      });
    },
    onFinishMeta: (info) => {
      useChatStore.getState().patchAgentMeta({ hitStepCap: info.hitStepCap });
    },
    onUsage: (delta) => {
      const cur = useChatStore.getState().agentMeta.tokens;
      const newOutputTokens = cur.outputTokens + delta.outputTokens;
      const now = Date.now();
      // Track stream start on first output tokens.
      let streamStartedAt = streamStartedAtRef.current;
      if (streamStartedAt === null && delta.outputTokens > 0) {
        streamStartedAt = now;
        streamStartedAtRef.current = streamStartedAt;
      }
      const elapsedMs = streamStartedAt !== null ? now - streamStartedAt : 0;
      const outputTps =
        streamStartedAt !== null && newOutputTokens > 0 && elapsedMs > 0
          ? Math.round(
              (newOutputTokens / (elapsedMs / 1000)),
            )
          : 0;
      useChatStore.getState().patchAgentMeta({
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

  return new Chat<UIMessage>({
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
      useChatStore.getState().patchAgentMeta({
        status: "error",
        error: msg,
      });
    },
  });
}

export const useChatStore = create<StoreState>((set, get) => ({
  live: NOOP_LIVE,
  setLive: (live) => set({ live }),

  approvalResponder: null,
  setApprovalResponder: (fn) => set({ approvalResponder: fn }),
  respondToApproval: (approvalId, approved) => {
    const fn = get().approvalResponder;
    if (fn) fn(approvalId, approved);
    // Do NOT abort on denial — the agent should see the "tool call denied"
    // result and continue gracefully. Aborting kills the entire agent run
    // for a single rejected tool call, which causes "(User canceled)" to
    // leak into the model's context and stops the agent prematurely.
    // The only place abort is still needed: the "Run edited" flow in
    // AiToolApproval, which calls abortSession directly after denial.
  },

  apiKeys: { ...EMPTY_PROVIDER_KEYS },
  setApiKeys: (keys) => set({ apiKeys: keys }),
  setApiKey: (provider, key) => {
    set({ apiKeys: { ...get().apiKeys, [provider]: key } });
  },

  selectedModelId: DEFAULT_MODEL_ID,
  setSelectedModelId: (id) => {
    set({ selectedModelId: id });
    void pushRecentModel(id);
    // live.getWorkspaceRoot() may be null during startup before setLive()
    // runs — fall back to lastWorkspaceCwd so the model is always persisted.
    const root =
      get().live.getWorkspaceRoot() ??
      usePreferencesStore.getState().lastWorkspaceCwd ??
      null;
    void persistProjectModel(id, root);
    agentBus.emit("model:change", { modelId: id });
  },

  mini: { open: false },
  openMini: () => set({ mini: { open: true } }),
  closeMini: () => set({ mini: { open: false } }),
  toggleMini: () => set((s) => ({ mini: { open: !s.mini.open } })),

  panelOpen: false,
  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),

  focusSignal: 0,
  pendingPrefill: null,
  focusInput: (prefill = null) =>
    set((s) => ({
      panelOpen: true,
      focusSignal: s.focusSignal + 1,
      pendingPrefill: prefill ?? null,
    })),
  consumePrefill: () => {
    const v = get().pendingPrefill;
    if (v != null) set({ pendingPrefill: null });
    return v;
  },

  pendingSelections: [],
  attachSelection: (text, source) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = `sel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({
      panelOpen: true,
      focusSignal: s.focusSignal + 1,
      pendingSelections: [...s.pendingSelections, { id, text: trimmed, source }],
    }));
  },
  consumeSelections: () => {
    const v = get().pendingSelections;
    if (v.length > 0) set({ pendingSelections: [] });
    return v;
  },

  agentMeta: IDLE_META,
  _tick: 0,
  patchAgentMeta: (patch) =>
    set((s) => ({ agentMeta: { ...s.agentMeta, ...patch } })),
  resetAgentMeta: () => set({ agentMeta: IDLE_META }),

  autoApprove: "off" as AutoApproveMode,
  setAutoApprove: (mode) => set({ autoApprove: mode }),
  cycleAutoApprove: () => {
    const cur = get().autoApprove;
    const next: AutoApproveMode =
      cur === "off" ? "edits" : cur === "edits" ? "all" : "off";
    set({ autoApprove: next });
  },
  autoApprovedIds: new Set<string>(),
  markAutoApproved: (id) => {
    const next = new Set(get().autoApprovedIds);
    next.add(id);
    set({ autoApprovedIds: next });
  },

  sessionsHydrated: false,
  lastHydratedWorkspace: null,
  sessions: [],
  activeSessionId: null,

  hydrateSessions: async (workspaceRoot?: string | null) => {
    const root = workspaceRoot ?? get().live?.getWorkspaceRoot?.() ?? null;
    const norm = (p: string | null | undefined) =>
      p?.replace(/\\/g, "/").replace(/\/+$/, "") ?? null;
    const normalizedRoot = norm(root);

    // Skip only if we've already hydrated for this exact workspace.
    if (
      get().sessionsHydrated &&
      norm(get().lastHydratedWorkspace) === normalizedRoot
    )
      return;

    let sessions: SessionMeta[] = [];
    try {
      const loaded = await loadAll();
      sessions = loaded.sessions;
    } catch (err) {
      console.error(
        "[hydrateSessions] Failed to load sessions — resetting store:",
        err,
      );
    }

    // Keep ALL sessions from the store — never filter at the store level.
    // Filtering is done at the display layer (SessionPicker) so sessions
    // from other workspaces survive across workspace switches. Previously
    // we filtered here and wrote the filtered list back to the store via
    // saveSessionsList, permanently deleting cross-workspace sessions.
    const allSessions = sessions;

    // Find an existing untitled "New chat" session for this workspace so
    // we don't stack empty placeholders on every launch.
    const reusable = allSessions.find(
      (s) =>
        s.title === "New chat" &&
        (norm(s.workspaceRoot) === normalizedRoot ||
          (!s.workspaceRoot && normalizedRoot == null)),
    );

    let nextSessions: SessionMeta[];
    let freshId: string;
    if (reusable) {
      nextSessions = allSessions;
      freshId = reusable.id;
    } else {
      freshId = newSessionId();
      const fresh: SessionMeta = {
        id: freshId,
        title: "New chat",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        workspaceRoot: root,
      };
      nextSessions = [fresh, ...allSessions];
      void saveSessionsList(nextSessions).catch((err) =>
        console.error("[hydrateSessions] Failed to persist sessions:", err),
      );
    }
    void saveActiveId(freshId).catch((err) =>
      console.error("[hydrateSessions] Failed to persist activeId:", err),
    );

    set({
      sessions: nextSessions,
      activeSessionId: freshId,
      sessionsHydrated: true,
      lastHydratedWorkspace: root,
    });
  },

  newSession: () => {
    const id = newSessionId();
    const meta: SessionMeta = {
      id,
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspaceRoot: get().live?.getWorkspaceRoot?.(),
    };
    const next = [meta, ...get().sessions];
    set({
      sessions: next,
      activeSessionId: id,
      agentMeta: IDLE_META,
      autoApprove: "off" as AutoApproveMode,
      autoApprovedIds: new Set<string>(),
    });
    void saveSessionsList(next);
    void saveActiveId(id);
    return id;
  },

  switchSession: (id) => {
    if (get().activeSessionId === id) return;
    if (!get().sessions.some((s) => s.id === id)) return;
    const fromId = get().activeSessionId;
    resetEditFailures();
    agentBus.emit("session:switch", { fromId, toId: id });

    // Lazily seed the chat with persisted messages the first time we open
    // this session. Subsequent switches reuse the cached Chat instance.
    const flip = () => {
      set({ activeSessionId: id, agentMeta: IDLE_META });
      void saveActiveId(id);
    };
    if (chats.has(id) || seedMessages.has(id)) {
      flip();
      return;
    }
    void loadMessages(id).then((m) => {
      if (m && m.length > 0 && !chats.has(id)) seedMessages.set(id, m);
      flip();
    });
  },

  deleteSession: (id) => {
    const remaining = get().sessions.filter((s) => s.id !== id);
    chats.get(id)?.stop();
    chats.delete(id);
    seedMessages.delete(id);
    agentBus.emit("session:delete", { sessionId: id });
    const pend = pendingPersist.get(id);
    if (pend) {
      clearTimeout(pend.timer);
      pendingPersist.delete(id);
    }
    void deleteSessionData(id);
    void useTodosStore.getState().clearSession(id);
    reapSessionWatches(id);
    closeWatchSessionShell(id);
    clearFenceState(id);

    if (remaining.length === 0) {
      const fresh: SessionMeta = {
        id: newSessionId(),
        title: "New chat",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        workspaceRoot: get().live?.getWorkspaceRoot?.(),
      };
      set({ sessions: [fresh], activeSessionId: fresh.id });
      void saveSessionsList([fresh]);
      void saveActiveId(fresh.id);
      return;
    }

    const wasActive = get().activeSessionId === id;
    const nextActive = wasActive ? remaining[0].id : get().activeSessionId;
    set({ sessions: remaining, activeSessionId: nextActive });
    void saveSessionsList(remaining);
    if (wasActive) void saveActiveId(nextActive);
  },

  renameSession: (id, title) => {
    const next = get().sessions.map((s) =>
      s.id === id ? { ...s, title, updatedAt: Date.now() } : s,
    );
    set({ sessions: next });
    void saveSessionsList(next);
  },

  persistMessages: (id, messages) => {
    // Debounce the message-blob write so streaming doesn't pound the store.
    const existing = pendingPersist.get(id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const entry = pendingPersist.get(id);
      if (!entry) return;
      pendingPersist.delete(id);
      void saveMessages(id, entry.latest);
    }, PERSIST_DEBOUNCE_MS);
    pendingPersist.set(id, { latest: messages, timer });

    // Update zustand session list only when the derived title actually
    // changes — otherwise we'd rewrite the sessions array (and trigger
    // re-renders + a store write) on every token.
    const sessions = get().sessions;
    const meta = sessions.find((s) => s.id === id);
    if (!meta) return;
    const isUntitled = !meta.title || meta.title === "New chat";
    if (!isUntitled) return;
    const nextTitle = deriveTitle(messages);
    if (nextTitle === meta.title) return;
    const next = sessions.map((s) =>
      s.id === id ? { ...s, title: nextTitle, updatedAt: Date.now() } : s,
    );
    set({ sessions: next });
    void saveSessionsList(next);
  },
  injectMessage: (id, text) => {
    const chat = getOrCreateChat(id);
    // Push a system-originated user message into the chat's message array.
    // sendAutomaticallyWhen only triggers on assistant messages, so this
    // won't auto-trigger a new agent run.
    chat.messages = [
      ...chat.messages,
      {
        id: `watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "user",
        parts: [{ type: "text" as const, text }],
      } as UIMessage,
    ];
    // Force a Zustand re-render so the UI shows the injected message.
    set({ _tick: Date.now() });
  },
  forkSession: async (atMessageIndex) => {
    const activeId = get().activeSessionId;
    if (!activeId) return null;
    try {
      // Fork from the LIVE conversation (what the user actually sees), not
      // the persisted snapshot. The store copy can be shorter than the UI —
      // saveMessages trims to 512KB keeping only the most recent messages,
      // and the debounced persist can lag a few hundred ms — which made
      // Fork silently throw "invalid message index" and do nothing.
      let messages: UIMessage[] = [];
      let newId = "";
      const live = chats.get(activeId)?.messages;
      if (
        live &&
        atMessageIndex >= 0 &&
        atMessageIndex < live.length &&
        live.length > 0
      ) {
        // Live path: slice the conversation the user is actually seeing.
        messages = stripIncompleteToolMessages(
          live.slice(0, atMessageIndex + 1),
        );
        newId = newSessionId();
        await saveMessages(newId, messages);
      } else {
        // Chat not resident (shouldn't happen for the displayed session) —
        // fall back to the persisted snapshot.
        const stored = await forkSessionFromStore(activeId, atMessageIndex);
        messages = stored.messages;
        newId = stored.newId;
      }
      if (messages.length === 0) throw new Error("source session not found");
      const meta: SessionMeta = {
        id: newId,
        title: "Fork",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        parentId: activeId,
        forkMessageIndex: atMessageIndex,
        workspaceRoot: get().live?.getWorkspaceRoot?.(),
      };
      const next = [meta, ...get().sessions];
      set({ sessions: next, activeSessionId: newId, agentMeta: IDLE_META });
      seedMessages.set(newId, messages);
      void saveSessionsList(next);
      void saveActiveId(newId);
      return newId;
    } catch (err) {
      console.error("[forkSession] failed:", err);
      return null;
    }
  },

  steeringMessage: null,
  setSteeringMessage: (msg) => set({ steeringMessage: msg }),
}));

export function getAgentMeta(): AgentMeta {
  return useChatStore.getState().agentMeta;
}

export function getActiveProviderKey(): string | null {
  const { selectedModelId, apiKeys } = useChatStore.getState();
  return apiKeys[getModel(selectedModelId).provider] ?? null;
}

export function hasKeyForModel(modelId: ModelId): boolean {
  const { apiKeys } = useChatStore.getState();
  const provider = getModel(modelId).provider;
  return providerNeedsKey(provider) ? !!apiKeys[provider] : true;
}

export function getOrCreateChat(sessionId: string): Chat<UIMessage> {
  const existing = chats.get(sessionId);
  if (existing) {
    touchChat(sessionId, existing);
    return existing;
  }
  // Create chat synchronously - stack detection happens asynchronously
  // in the background and will be passed to the agent when available
  const c = makeChatSync(sessionId);
  touchChat(sessionId, c);
  return c;
}

export function getChat(sessionId?: string): Chat<UIMessage> | undefined {
  if (sessionId) return chats.get(sessionId);
  const id = useChatStore.getState().activeSessionId;
  return id ? chats.get(id) : undefined;
}

export async function sendMessage(text: string): Promise<boolean> {
  const state = useChatStore.getState();
  const sessionId = state.activeSessionId;
  if (!sessionId) return false;
  if (providerNeedsKey(getModel(state.selectedModelId).provider) && !getActiveProviderKey()) return false;
  const c = getOrCreateChat(sessionId);
  await c.sendMessage({ text });
  return true;
}

/** Tool-part states that count as fully resolved (safe to keep). */
const COMPLETE_PART_STATES = new Set([
  "output-available",
  "output-error",
  "approval-responded",
]);

function hasPendingApprovals(chat: Chat<UIMessage>): boolean {
  for (const m of chat.messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts as unknown[]) {
      if ((p as { state?: string }).state === "approval-requested") return true;
    }
  }
  return false;
}

/**
 * Drop assistant messages that still hold an unfinished tool-call part
 * (e.g. an `approval-requested` we never responded to). Mirrors the
 * transport's `stripIncompleteToolCalls`: keeping a message whose tool call
 * never got an output/approval response would corrupt the next request.
 */
function stripIncompleteToolMessages(messages: UIMessage[]): UIMessage[] {
  if (messages.length === 0) return messages;
  return messages.filter((m) => {
    if (m.role !== "assistant") return true;
    for (const p of m.parts) {
      const ptype = (p as { type?: string }).type ?? "";
      if (!ptype.startsWith("tool-") && ptype !== "dynamic-tool") continue;
      const state = (p as { state?: string }).state;
      if (state == null || !COMPLETE_PART_STATES.has(state)) return false;
    }
    return true;
  });
}

function releasePendingApprovals(chat: Chat<UIMessage>): void {
  if (!hasPendingApprovals(chat)) return;
  const cleaned = stripIncompleteToolMessages(chat.messages);
  if (cleaned !== chat.messages) {
    chat.messages = cleaned;
  }
}

/**
 * Abort the chat's active run without touching pending approvals. Used after
 * an explicit approval response so we don't race the response application.
 */
export function abortSession(sessionId: string): void {
  cancelAllShellSessions();
  const chat = chats.get(sessionId);
  if (!chat) return;
  void chat.stop();
}

/**
 * Standalone responder — routes an approval decision through the store's
 * approval responder and aborts the agent on denial. Exported so leaf
 * UI components (AiChatView, AiMiniWindow) can resolve approvals without
 * needing a Zustand hook. Used by AiChat.tsx's onApproval callback.
 */
export function respondToApprovalStandalone(
  approvalId: string,
  approved: boolean,
): void {
  const state = useChatStore.getState();
  const fn = state.approvalResponder;
  if (fn) fn(approvalId, approved);
  // Same rationale as respondToApproval: don't abort on denial.
  // The agent should see the denial and continue gracefully.
}

/**
 * Stop the agent and release any pending approvals.
 *
 * `Chat.stop()` only aborts an in-flight (`streaming`/`submitted`) run — it
 * is a no-op when the agent is paused awaiting a tool approval (status
 * `ready`). If the user ignores an approval card, the orphaned
 * `approval-requested` part pins the session in the `awaiting-approval`
 * busy state forever: the Stop button appears dead and new messages are
 * blocked. So on stop we also strip those stale parts, which drops
 * `approvalsPending` back to 0 and frees the session.
 */
export function stopSession(sessionId: string): void {
  cancelAllShellSessions();
  const chat = chats.get(sessionId);
  if (!chat) return;
  void chat.stop().finally(() => {
    releasePendingApprovals(chat);
  });
}

export function stop(): void {
  const id = useChatStore.getState().activeSessionId;
  if (!id) return;
  stopSession(id);
}
