import { Chat, type UIMessage } from "@ai-sdk/react";
import type { UIMessagePart } from "ai";
import { create } from "zustand";

/** Loose part type for steering-message payloads (text + image file parts). */
type LoosePart = UIMessagePart<Record<string, never>, Record<string, never>>;
import {
  DEFAULT_MODEL_ID,
  getModel,
  providerNeedsKey,
  type ModelId,
  type ProviderId,
} from "../config";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useTodosStore } from "./todoStore";
import { EMPTY_PROVIDER_KEYS, type ProviderKeys } from "../lib/keyring";
import {
  deleteSessionData,
  deriveTitle,
  ensureMigratedOnce,
  forkSession as forkSessionFromStore,
  loadAll,
  loadMessages,
  newSessionId,
  saveActiveId,
  saveMessages,
  saveSessionsList,
  setSessionsScope,
  type SessionMeta,
} from "../lib/sessions";
import { pushRecentModel, persistProjectModel } from "../lib/modelPrefs";
import { normalizeWorkspacePath } from "../lib/workspacePath";
import { cancelAllShellSessions } from "../tools/shell";
import { clearFenceState, summarizeMessagesNow } from "../lib/transport";
import { reapSessionWatches, closeWatchSessionShell } from "../tools/watch";
import { agentBus } from "../lib/eventBus";
import { auditAppend, AUDIT_KINDS } from "../lib/audit";
import { createShadow, getShadow } from "../lib/shadow";
import {
  disposeSessionToolContext,
  getSessionToolContext,
  IDLE_META,
  makeChatSync as makeChatSyncRuntime,
  type AgentMeta,
  type AgentRunStatus,
  type ChatRuntimeDeps,
} from "../lib/chatRuntime";

// Re-export for API compatibility — AgentStatusPill, eventBus, and the
// module barrel import these types from chatStore (their original home).
export type { AgentMeta, AgentRunStatus };

type Live = {
  getCwd: () => string | null;
  getTerminalContext: () => string | null;
  isActiveTerminalPrivate: () => boolean;
  injectIntoActivePty: (text: string) => boolean;
  /** Raw write to the active terminal's DISPLAY (xterm parser), not shell stdin. */
  writeToActiveTerminalDisplay: (text: string) => boolean;
  getWorkspaceRoot: () => string | null;
  getActiveFile: () => string | null;
  openPreview: (url: string) => boolean;
};

// ── Error display — surface RetryError / APICallError details ──────────

type ErrorLike = {
  message?: string;
  errors?: (ErrorLike | null)[];
  lastError?: ErrorLike | null;
  statusCode?: number | null;
  responseBody?: string | null;
  url?: string | null;
  isRetryable?: boolean;
};

/** Map raw provider/SDK error strings onto actionable display text.
 *  Returns null when the message needs no rewrite. */
function friendlyErrorText(msg: string): string | null {
  if (!msg) return null;
  // Minified production React errors: decode the ones we know, keep the rest
  // searchable. #185 (maximum update depth) is a KAI render-loop bug — say so
  // instead of showing a minified blob.
  const reactCode = /Minified React error #(\d+)/.exec(msg);
  if (reactCode) {
    if (reactCode[1] === "185") {
      return (
        "UI render loop detected (React error #185 — maximum update depth " +
        "exceeded). The conversation history is intact; press Retry. If it " +
        "repeats, use Report an issue in Settings → About — this is a KAI " +
        "bug, not a provider problem."
      );
    }
    return (
      `UI error (React #${reactCode[1]}) — details were written to the log. ` +
      "Press Retry, or report an issue if it repeats."
    );
  }
  if (
    /network error|failed to fetch|fetch failed|networkerror|load failed|network request failed/i.test(
      msg,
    )
  ) {
    return (
      "Network request failed — the endpoint could not be reached. Check " +
      "your internet connection (VPN/proxy), or verify the provider is up. " +
      "For a custom endpoint (Settings → Models), make sure its server is " +
      "running and the URL is reachable."
    );
  }
  if (/enginecore/i.test(msg)) {
    return (
      msg +
      "\n\nEngineCore is a vLLM engine failure on the model provider, not " +
      "your setup. On a routed model (e.g. OpenRouter) the failure is " +
      "upstream — just Retry, or switch model/provider if it repeats. On " +
      "your own endpoint, check its server log (usually VRAM OOM) and " +
      "restart it."
    );
  }
  if (/available credits|add credits/i.test(msg)) {
    return (
      msg +
      "\n\nThe provider rejected the request for credit reasons: wait for " +
      "in-flight requests to settle, add credits, or switch to another " +
      "model or provider."
    );
  }
  return null;
}

/** Extract actionable error details from an AI SDK RetryError chain. */
export function resolveErrorDisplay(raw: unknown): string {
  const e = raw as ErrorLike | null;
  if (!e) return "Unknown error";

  // Known raw shapes (minified React errors, network failures, engine
  // crashes, credit rejections) get actionable text before RetryError
  // unwrapping — they arrive both bare and wrapped.
  const friendly = friendlyErrorText(e.message ?? "");
  if (friendly) return friendly;

  // Duck-typed RetryError: has an `errors` array of underlying errors.
  const errors = Array.isArray(e.errors) ? e.errors.filter(Boolean) : [];
  if (errors.length === 0) return e.message ?? String(raw);

  // Find the most informative underlying error: prefer one with statusCode.
  let best: ErrorLike | null = null;
  for (let i = errors.length - 1; i >= 0; i--) {
    const err = errors[i]!;
    if (err.statusCode != null) {
      best = err;
      break;
    }
    if (!best) best = err;
  }
  if (!best) return e.message ?? String(raw);

  const code = best.statusCode;
  const body = best.responseBody?.slice(0, 500) ?? "";
  const url = best.url ?? "";
  const providerMsg = best.message ?? "";

  // Detect common failure modes and return actionable messages.
  if (code === 413 || /payload too large|request too large|exceeds.*limit/i.test(body)) {
    return (
      "Request too large (HTTP 413). Your prompt + MCP tool schemas may exceed the provider's max input size. " +
      "Try: disconnect unnecessary MCP servers, or use a model with a larger context window."
    );
  }
  if (code === 429 || /rate limit/i.test(body)) {
    return (
      "Rate limited (HTTP 429). The provider is throttling requests. " +
      "Try: wait a minute and retry, or switch to a different provider."
    );
  }
  if (code === 408 || code === 504 || /timeout|timed out/i.test(providerMsg)) {
    return (
      `Request timed out (HTTP ${code}). The model may be overloaded or the request is too large. ` +
      "Try: reduce conversation length, disconnect MCP servers, or switch models."
    );
  }
  if (code === 401 || code === 403) {
    return (
      `Authentication error (HTTP ${code}). Your API key may be invalid or missing. ` +
      "Check Settings → Models for the active provider."
    );
  }
  if (code != null) {
    return [
      `Provider error (HTTP ${code})`,
      body ? `: ${body.slice(0, 200)}` : "",
      url ? `\n\nURL: ${url}` : "",
    ].join("");
  }

  // No status code — surface the underlying message if it's more specific.
  if (providerMsg && providerMsg !== e.message) {
    return friendlyErrorText(providerMsg) ?? providerMsg;
  }
  return e.message ?? String(raw);
}

export type MiniState = {
  open: boolean;
  /** Maximized/extended — the window spans the workspace. Collapsed back
   *  to the docked mini size when the user opens a file (it would otherwise
   *  cover the editor). Preserved across open/close so re-opening restores
   *  the user's last layout. */
  expanded: boolean;
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
/** Two-state approval mode (2026-10: "edits" dropped — nobody used it in
 * practice; pinned allowlist commands cover the repeated-shell-command case,
 * and "all" covers trust-a-lot sessions). */
export type AutoApproveMode = "off" | "all";

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
  setMiniExpanded: (expanded: boolean) => void;
  /** Collapse an expanded mini window back to its docked size (no-op when
   *  already mini). Called on user file-opens so the editor isn't hidden
   *  behind the expanded AI window. */
  collapseMini: () => void;

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

  /** Set the final `output` of a tool-call part (background media result). */
  resolveMedia: (sessionId: string, toolCallId: string, output: unknown) => void;

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
  /** User-driven compaction of the ACTIVE session (the /compact command):
   *  replaces the in-chat history with the <session_state> snapshot + tail,
   *  in place — same chat, no new session. Returns a human-readable result
   *  for the toast. */
  compactActiveSession: () => string;
  /** Inject a system-originated user message (e.g. watch result) without triggering a new agent run. */
  injectMessage: (id: string, text: string) => Promise<void>;
  /** Fork the current session at a message index, creating a new branch. */
  forkSession: (atMessageIndex: number) => Promise<string | null>;
  /**
   * Shadow mode — one user-facing action that starts BOTH isolation axes:
   * a detached copy of the project files (L3 shadow) and a fork of the
   * conversation. The agent then edits the copy while the user watches from
   * the forked thread; Apply/Discard in the strip resolves both. Returns the
   * new session id, or null when there is no active session / the copy
   * failed / a shadow is already active for this project.
   */
  startShadowMode: () => Promise<string | null>;
  /** Merge a session's messages into another (append source onto target), then
   *  remove the source. Returns true on success. */
  mergeSession: (sourceId: string, targetId: string) => Promise<boolean>;
  /** Steering message queued while agent is busy. Full parts (text +
   *  image files) — attachments must survive the redirect, not just text. */
  steeringMessage: LoosePart[] | null;
  setSteeringMessage: (msg: LoosePart[] | null) => void;
  /** Strip stale `approval-requested` tool parts left by aborted runs so a
   *  dead approval can't pin the session in awaiting-approval forever. */
  releaseStaleApprovals: (sessionId: string) => void;
};

const NOOP_LIVE: Live = {
  getCwd: () => null,
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  injectIntoActivePty: () => false,
  writeToActiveTerminalDisplay: () => false,
  getWorkspaceRoot: () => null,
  getActiveFile: () => null,
  openPreview: () => false,
};

const CHATS_LRU_CAP = 8;
const chats = new Map<string, Chat<UIMessage>>();

/**
 * Hydration single-flight serialization.
 *
 * hydrateSessions is async and swaps the sessions store scope (a module-level
 * mutable in sessions.ts). Two overlapping runs — e.g. the App effect re-fires
 * on a fast A→B project switch while A's hydration is still awaiting
 * loadAll()/loadMessages() — interleave like this: B's setSessionsScope runs,
 * then A's stale snapshot commits LAST (its await resolved after B's), and
 * A's `set({ sessions, activeSessionId, lastHydratedWorkspace: A })` wins —
 * the AI window keeps showing project A's conversation after switching to
 * B. The guard has three parts, all keyed to a monotonic seq:
 *   1. serialize starts (each run awaits the previous chain tail),
 *   2. commit gate — a stale run's `set()` is dropped, latest run wins,
 *   3. re-read the scope owner after awaits — if another run re-scoped the
 *      sessions store mid-flight, this run must not touch store state.
 */
let hydrateSeq = 0;
let hydrateChain: Promise<void> = Promise.resolve();

// The normalized root of the sessions store file the module is CURRENTLY
// scoped to, set by hydrateSessions right after setSessionsScope. persistMessages
// uses it to reject writes for a session that belongs to a different project
// (see the scope-ownership guard). scopeGuardActive is false until the first
// hydrate so cold-boot writes aren't filtered against a not-yet-set root.
let scopeGuardRoot: string | null = null;
let scopeGuardActive = false;

/**
 * App-owned abort controllers for in-flight agent runs, keyed by session.
 *
 * `Chat.stop()` (the AI SDK) only aborts its internal request controller and
 * is a silent no-op unless the chat status is exactly `streaming`/`submitted`.
 * A runaway model that gets stuck between steps, or whose stream the SDK has
 * already torn down, is therefore unkillable via `chat.stop()` alone. We keep
 * our own controller per active run and abort it unconditionally on Stop so
 * the button is a first-class, always-works control.
 */
const runControllers = new Map<string, AbortController>();

/**
 * Sessions whose watch fired while the agent was still busy (streaming/
 * submitted) or awaiting an approval. The wake-up `sendMessage()` can't run
 * then — a mid-stream injection is lost because the in-flight `transport.run()`
 * already snapshotted its message list. Rather than dropping the wake (the
 * previous behavior — the model never reacted to a watch that fired during a
 * long agent turn), we record the session here and flush it once the agent
 * settles back to idle via `flushPendingWatchWakes`.
 */
const pendingWatchWakes = new Set<string>();

/** Add a session to the pending-wake set. Idempotent. */
function queueWatchWake(sessionId: string): void {
  pendingWatchWakes.add(sessionId);
}

/**
 * Flush queued watch wakes for a session once its run has settled to `ready`
 * (or `error`). Called from `AgentRunBridge` when `status` transitions out of
 * `submitted`/`streaming`. One wake per session — the injected watch message
 * is already in history, so a single `sendMessage()` re-runs over the current
 * (watch-terminated) history and lets the model react.
 */
export function flushPendingWatchWakes(sessionId: string): void {
  if (!pendingWatchWakes.delete(sessionId)) return;
  const chat = chats.get(sessionId);
  if (!chat) return;
  if (
    chat.status === "streaming" ||
    chat.status === "submitted" ||
    hasPendingApprovals(chat)
  ) {
    // Still busy OR paused on an approval card — re-queue and wait for the
    // next settle. (The approvals path used to DROP the wake: a watch that
    // fired while the user was deciding sat unanswered until the next user
    // turn. Re-queueing keeps it one transition away from delivery; when the
    // approval resolves, the continuation's history snapshot already
    // includes the watch message, so at worst the wake is redundant.)
    pendingWatchWakes.add(sessionId);
    return;
  }
  void chat.sendMessage().catch((e) => {
    console.error("[kai] watch wake-up failed:", e);
  });
}

/**
 * Flush queued watch wakes for ALL sessions, not just the active one. The
 * AgentRunBridge effect only fires for the session it's mounted against —
 * a watch on a background session (the user switched chats mid-monitoring)
 * stayed queued forever: its wake sat in pendingWatchWakes until the user
 * happened to switch back, so "the watch fired but the agent never
 * reacted". Called whenever a watch injects a message, so every firing
 * gets its session a wake attempt regardless of which session is open.
 */
export function flushAllPendingWatchWakes(): void {
  // SNAPSHOT before iterating: `flushPendingWatchWakes` re-queues busy
  // sessions back into this same Set, and a JS `for..of` over a Set visits
  // items added mid-iteration — so iterating the live Set loops FOREVER
  // whenever any queued session is busy (agent streaming/submitted or an
  // approval pending): delete → busy → re-add → visit again → …
  // Synchronously, on the webview main thread — the whole app froze and had
  // to be killed from Task Manager. Iterating a copy visits each session
  // at most once; busy ones keep their queue entry for the next flush.
  for (const id of [...pendingWatchWakes]) {
    flushPendingWatchWakes(id);
  }
}

export function registerRunController(sessionId: string, c: AbortController): void {
  // A new run supersedes any stale controller for the session.
  runControllers.get(sessionId)?.abort();
  runControllers.set(sessionId, c);
}

/** Abort the active run for a session, if any. Idempotent, and removes the
 *  controller so a future run starts clean. */
function abortRunController(sessionId: string): void {
  const c = runControllers.get(sessionId);
  if (!c) return;
  runControllers.delete(sessionId);
  c.abort();
}

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
/**
 * Port object handed to the store-decoupled Chat runtime (`lib/chatRuntime`).
 * The runtime has no zustand import — every store touch from stream
 * callbacks is routed through these accessors, preserving the pre-
 * extraction behavior (including the active-session guard).
 */
const runtimeDeps: ChatRuntimeDeps = {
  getTokens: () => useChatStore.getState().agentMeta.tokens,
  live: {
    getCwd: () => useChatStore.getState().live.getCwd(),
    getTerminalContext: () =>
      useChatStore.getState().live.getTerminalContext(),
    isActiveTerminalPrivate: () =>
      useChatStore.getState().live.isActiveTerminalPrivate(),
    injectIntoActivePty: (text) =>
      useChatStore.getState().live.injectIntoActivePty(text),
    writeToActiveTerminalDisplay: (text) =>
      useChatStore.getState().live.writeToActiveTerminalDisplay(text),
    getWorkspaceRoot: () => useChatStore.getState().live.getWorkspaceRoot(),
    openPreview: (url) => useChatStore.getState().live.openPreview(url),
  },
  getKeys: () => useChatStore.getState().apiKeys,
  getSelectedModelId: () => useChatStore.getState().selectedModelId,
  isActiveSession: (sessionId) =>
    useChatStore.getState().activeSessionId === sessionId,
  patchAgentMeta: (patch) => useChatStore.getState().patchAgentMeta(patch),
  abortRunController,
  compactActiveSession: () =>
    useChatStore.getState().compactActiveSession(),
};

/**
 * Create a Chat instance synchronously via the store-decoupled runtime.
 * Stack detection happens in the background and stackInfo will be updated
 * via the getStackInfo callback.
 */
function makeChatSync(sessionId: string): Chat<UIMessage> {
  return makeChatSyncRuntime(
    sessionId,
    runtimeDeps,
    seedMessages,
    resolveErrorDisplay,
  );
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

  mini: { open: false, expanded: false },
  openMini: () => set((s) => ({ mini: { open: true, expanded: s.mini.expanded } })),
  closeMini: () => set((s) => ({ mini: { open: false, expanded: s.mini.expanded } })),
  toggleMini: () => set((s) => ({ mini: { open: !s.mini.open, expanded: s.mini.expanded } })),
  setMiniExpanded: (expanded) =>
    set((s) => ({ mini: { open: s.mini.open, expanded } })),
  collapseMini: () =>
    set((s) => ({ mini: { open: s.mini.open, expanded: false } })),

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

  resolveMedia: (sessionId, toolCallId, output) => {
    const chat = chats.get(sessionId);
    if (!chat) return;
    const msgs = chat.messages;
    let mutated = false;
    const next = msgs.map((m) => {
      if (m.role !== "assistant") return m;
      let touched = false;
      const parts = m.parts.map((p) => {
        const tc = (p as { toolCallId?: string }).toolCallId;
        if (tc !== toolCallId) return p;
        const state = (p as { state?: string }).state;
        // Only patch a part the SDK already finalized (has a result slot).
        if (state !== "output-available" && state !== "output-error") return p;
        touched = true;
        return { ...(p as Record<string, unknown>), output } as unknown as typeof p;
      });
      if (!touched) return m;
      mutated = true;
      return { ...m, parts } as typeof m;
    });
    if (mutated) {
      chat.messages = next;
      set({ _tick: Date.now() });
      void saveMessages(sessionId, next);
    }
  },

  autoApprove: "off" as AutoApproveMode,
  setAutoApprove: (mode) => set({ autoApprove: mode }),
  cycleAutoApprove: () => {
    const cur = get().autoApprove;
    const next: AutoApproveMode = cur === "off" ? "all" : "off";
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
    // Serialize starts: a run may only begin once the previous hydration has
    // fully settled. This alone removes most of the interleave window.
    const prior = hydrateChain;
    let resolveChain!: () => void;
    hydrateChain = new Promise((r) => (resolveChain = r));
    await prior;

    const seq = ++hydrateSeq;
    // Latest-wins gate: after every await, the run must still be the newest.
    const isStale = () => seq !== hydrateSeq;

    const root = workspaceRoot ?? get().live?.getWorkspaceRoot?.() ?? null;
    const norm = normalizeWorkspacePath;
    const normalizedRoot = norm(root);

    try {
    // Flush every pending (debounced) message persist BEFORE the scope can
    // swap. Any queued write still belongs to the previous project's store,
    // so it must land there — flushing here (while `store` still points at
    // the old file) prevents a late debounce from a torn-down Chat writing
    // the previous conversation into the new project's file.
    flushPersist();
    // Scope the sessions store to this project's file before loading, so
    // concurrent instances on different projects read/write disjoint files.
    // Migration runs once per process, idempotent via a marker.
    await ensureMigratedOnce();
    // Serialized start: by the time we're here, every earlier hydration has
    // fully settled, so re-scoping can't interleave with another run's
    // reads/writes. (No owner re-check needed — starts never overlap.)
    await setSessionsScope(root);
    // `store` now points at THIS project's file — arm the persistMessages
    // scope guard so a lingering persist for a different project's session
    // cannot write into it.
    scopeGuardRoot = normalizedRoot;
    scopeGuardActive = true;
    if (isStale()) return;

    // Skip only if we've already hydrated for this exact workspace.
    if (
      get().sessionsHydrated &&
      norm(get().lastHydratedWorkspace) === normalizedRoot
    )
      return;

    let sessions: SessionMeta[] = [];
    let loadedActiveId: string | null = null;
    try {
      const loaded = await loadAll();
      if (isStale()) return;
      sessions = loaded.sessions;
      loadedActiveId = loaded.activeId;
    } catch (err) {
      console.error(
        "[hydrateSessions] Failed to load sessions — resetting store:",
        err,
      );
    }

    // Keep ALL sessions — never filter at the store level. Filtering happens
    // at the display layer (SessionPicker) so sessions from other workspaces
    // survive workspace switches. (Previously we filtered here and wrote the
    // filtered list back via saveSessionsList, permanently deleting
    // cross-workspace sessions.)
    //
    // Merge in memory: when this is a re-hydration (workspace switched while
    // loadAll() was in flight) the in-memory list is MORE current than the
    // snapshot, so treat it as the base and only add persisted sessions that
    // aren't already present. This also prevents resurrecting sessions the
    // user just deleted. On the very first hydration the in-memory list is
    // empty/stale and the snapshot wins.
    const inMemory = get().sessions;
    const isRehydrate = get().sessionsHydrated;
    let allSessions: SessionMeta[];
    if (isRehydrate) {
      const liveIds = new Set(inMemory.map((s) => s.id));
      // Preserve in-memory order as the head, append snapshot-only entries.
      const snapshotOnly = sessions.filter((s) => !liveIds.has(s.id));
      allSessions = [...inMemory, ...snapshotOnly];
    } else {
      const seenIds = new Set(sessions.map((s) => s.id));
      allSessions = [
        ...sessions,
        ...inMemory.filter((s) => !seenIds.has(s.id)),
      ];
    }

    // Find an existing untitled "New chat" session for this workspace so
    // we don't stack empty placeholders on every launch.
    const reusable = allSessions.find(
      (s) =>
        s.title === "New chat" &&
        (norm(s.workspaceRoot) === normalizedRoot ||
          (!s.workspaceRoot && normalizedRoot == null)),
    );

    const currentActiveId = get().activeSessionId;
    // On cold start, restore the persisted last-active session before
    // falling back to a fresh/reusable one.
    const restoredActiveId = loadedActiveId ?? null;

    // A real project switch (File > Open Project / StartPage recent /
    // local↔WSL) is the ONLY way the workspace root changes — plain terminal
    // `cd` never re-locks the root (useWorkspaceCwd). On a switch the
    // previous project's conversation must NOT stay active: resolve this
    // project's own session instead.
    const isWorkspaceSwitch =
      get().sessionsHydrated &&
      currentActiveId != null &&
      norm(get().lastHydratedWorkspace) !== normalizedRoot;

    // Sessions belonging to the target workspace, newest first. Falls back
    // to unscoped sessions when hydrating the unscoped store.
    const workspaceMatched = allSessions
      .filter(
        (s) =>
          norm(s.workspaceRoot) === normalizedRoot ||
          (!s.workspaceRoot && normalizedRoot == null),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);

    let nextSessions: SessionMeta[];
    let nextActiveId: string | null = currentActiveId;

    if (isWorkspaceSwitch) {
      // Prefer the project's persisted last-active session, then its newest.
      nextActiveId =
        restoredActiveId != null &&
        allSessions.some((s) => s.id === restoredActiveId)
          ? restoredActiveId
          : (workspaceMatched[0]?.id ?? null);
    } else if (!currentActiveId) {
      nextActiveId =
        restoredActiveId != null &&
        allSessions.some((s) => s.id === restoredActiveId)
          ? restoredActiveId
          : null;
    }

    if (reusable) {
      nextSessions = allSessions;
      if (!nextActiveId) nextActiveId = reusable.id;
    } else {
      const freshId = newSessionId();
      const fresh: SessionMeta = {
        id: freshId,
        title: "New chat",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        workspaceRoot: root,
      };
      nextSessions = [fresh, ...allSessions];
      // Nothing from the target workspace to activate — the fresh session
      // (stamped with this root) becomes active.
      if (!nextActiveId) nextActiveId = freshId;
      void saveSessionsList(nextSessions).catch((err) =>
        console.error("[hydrateSessions] Failed to persist sessions:", err),
      );
    }
    // Safety net: `activeSessionId` must always reference a session in the
    // list the UI reads, otherwise SessionPicker renders nothing. Fall back
    // to a session bound to this workspace, then the newest session.
    if (!nextSessions.some((s) => s.id === nextActiveId)) {
      nextActiveId =
        nextSessions.find((s) => norm(s.workspaceRoot) === normalizedRoot)
          ?.id ??
        nextSessions[0]?.id ??
        null;
    }

    // Commit gate: only the newest hydration may commit store state. A
    // stale run resolving after a newer one must not overwrite it — this
    // is the exact interleave that kept the AI window on the previous
    // project's conversation after a fast project switch.
    if (isStale()) return;

    void saveActiveId(nextActiveId).catch((err) =>
      console.error("[hydrateSessions] Failed to persist activeId:", err),
    );

    // Seed the restored/next active session's persisted history BEFORE
    // flipping activeSessionId. If we flip first, React renders the body and
    // getOrCreateChat() constructs an EMPTY Chat (seedMessages is still empty,
    // loadMessages is async), and selecting that session later is a no-op
    // (switchSession early-returns when it's already active) — so a session
    // whose last run ended on an ignored approval would open blank forever.
    if (nextActiveId) {
      if (!chats.has(nextActiveId) && !seedMessages.has(nextActiveId)) {
        try {
          const m = await loadMessages(nextActiveId);
          if (isStale()) return;
          if (
            m &&
            m.length > 0 &&
            !chats.has(nextActiveId) &&
            !seedMessages.has(nextActiveId)
          ) {
            seedMessages.set(nextActiveId, stripIncompleteToolMessages(m));
          }
        } catch (err) {
          console.error(
            "[hydrateSessions] Failed to seed active session:",
            err,
          );
        }
      }
    }

    if (isStale()) return;

    set({
      sessions: nextSessions,
      activeSessionId: nextActiveId,
      sessionsHydrated: true,
      lastHydratedWorkspace: root,
    });
    } finally {
      // Release the chain slot this run held — the next queued hydration
      // can start. Runs that early-returned above ALSO release here.
      resolveChain();
    }
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
    agentBus.emit("session:switch", { fromId, toId: id });

    // Lazily seed the chat with persisted messages the first time we open
    // this session. Subsequent switches reuse the cached Chat instance.
    const flip = () => {
      // Stale-request guard: if the user switched again (or the target was
      // deleted) before `loadMessages` resolved, don't yank activeSessionId
      // back to this session.
      if (get().activeSessionId !== fromId) return;
      if (!get().sessions.some((s) => s.id === id)) return;
      set({ activeSessionId: id, agentMeta: IDLE_META });
      void saveActiveId(id);
    };
    if (chats.has(id) || seedMessages.has(id)) {
      flip();
      return;
    }
    void loadMessages(id).then((m) => {
      // Only seed if this session hasn't already been opened (its own chat
      // instantiated) while the load was in flight — using seedMessages now
      // would be discarded or, worse, clobber a live chat's history.
      if (m && m.length > 0 && !chats.has(id)) {
        seedMessages.set(id, stripIncompleteToolMessages(m));
      }
      flip();
    });
  },

  deleteSession: (id) => {
    const remaining = get().sessions.filter((s) => s.id !== id);
    abortRunController(id);
    chats.get(id)?.stop();
    chats.delete(id);
    seedMessages.delete(id);
    disposeSessionToolContext(id);
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
    const nextActive: string | null = wasActive
      ? remaining[0].id
      : get().activeSessionId;
    set({ sessions: remaining, activeSessionId: nextActive });
    void saveSessionsList(remaining);
    if (wasActive && nextActive) {
      const next = nextActive;
      void saveActiveId(next);
      // Route the fallback activation through the same lazy load/seed path
      // as a normal switch, so the newly active session's persisted history
      // is hydrated instead of being overwritten with an empty chat.
      if (!chats.has(next) && !seedMessages.has(next)) {
        void loadMessages(next).then((m) => {
          // The user may have switched away while loading — only honor if
          // this session is still active and its chat wasn't built meanwhile.
          if (get().activeSessionId !== next) return;
          if (m && m.length > 0 && !chats.has(next)) {
            seedMessages.set(next, stripIncompleteToolMessages(m));
          }
        });
      }
    }
  },

  renameSession: (id, title) => {
    const next = get().sessions.map((s) =>
      s.id === id ? { ...s, title, updatedAt: Date.now() } : s,
    );
    set({ sessions: next });
    void saveSessionsList(next);
  },

  // ── User-driven compaction (/compact) ─────────────────────────────
  // In-place history replacement: same Chat, same session, no agent run.
  // Guards: refuses while a run is streaming/thinking or a pending approval
  // exists — replacing history mid-run would desync the SDK's in-flight
  // snapshot from the UI. Idle only.
  compactActiveSession: () => {
    const id = get().activeSessionId;
    if (!id) return "No active chat to compact.";
    const chat = chats.get(id);
    if (!chat) return "No active chat to compact.";
    const status = chat.status;
    if (
      status === "streaming" ||
      status === "submitted" ||
      hasPendingApprovals(chat)
    ) {
      return "Wait for the current run to finish before compacting.";
    }
    const toolContext = getSessionToolContext(id);
    const fileSnapshot = toolContext?.fileTracker.getSnapshot() ?? [];
    const next = summarizeMessagesNow(chat.messages, fileSnapshot, id);
    if (!next) {
      return "Context is already minimal — nothing worth compacting.";
    }
    // Replace in place. The SDK adopts the new array; AgentRunBridge
    // persists it on the next messages-change effect, the same path the
    // automatic summarizer uses.
    const dropped = chat.messages.length - next.length;
    chat.messages = next;
    set({ _tick: Date.now() });
    // lastInputTokens reflected the pre-compact request size; the next run
    // will re-report. Zero it so the context indicator doesn't show stale
    // pressure against the freshly trimmed history.
    get().patchAgentMeta({
      lastInputTokens: 0,
      summaryNotice: { at: Date.now(), text: "Context compacted by /compact." },
    });
    const n = next.length;
    return `Context compacted — ${Math.max(0, dropped)} older message${
      Math.max(0, dropped) === 1 ? "" : "s"
    } summarized, kept the last ${n - 1}.`;
  },

  persistMessages: (id, messages) => {
    // Scope-ownership guard. `saveMessages` writes into the CURRENTLY SCOPED
    // sessions file, which belongs to exactly one project. But `sessions`
    // (the in-memory list) is intentionally GLOBAL across projects, so a
    // membership check would wrongly ALLOW an old-project session. Compare
    // the session's own workspaceRoot against the scope we last switched to
    // (scopeGuardRoot). On a project switch the outgoing Chat can still emit
    // an empty/transient persist while being torn down; without this guard
    // that write lands in the NEW project's file — the observed corruption
    // (a real session blanking / another project's history appearing). The
    // guard activates only once a hydrate has run, so cold-boot persists of
    // the just-hydrated session are unaffected.
    if (scopeGuardActive) {
      const meta = get().sessions.find((s) => s.id === id);
      const sRoot = normalizeWorkspacePath(meta?.workspaceRoot);
      if (sRoot !== scopeGuardRoot) return;
    }
    // Stamp createdAt on NEW messages (metadata) so the transcript can render
    // day separators + hover times. Mutates the LIVE array's message objects —
    // deliberate: the same objects render in AiChat and persist via the
    // debounced save below. Legacy messages (pre-feature) are marked
    // `legacyNoTs` at hydration (loadMessages) and skipped — no fake times.
    for (const m of messages) {
      const meta = m.metadata as { createdAt?: number; legacyNoTs?: boolean } | undefined;
      if (meta?.createdAt || meta?.legacyNoTs) continue;
      m.metadata = { ...(m.metadata as object | undefined), createdAt: Date.now() };
    }
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
    // Bump updatedAt on real message growth (not per token) so recency
    // ordering in SessionPicker stays correct for already-titled sessions.
    const isUntitled = !meta.title || meta.title === "New chat";
    const count = messages.length;
    const countChanged = count !== (meta.lastMessageCount ?? -1);
    const nextTitle = isUntitled ? deriveTitle(messages) : meta.title;
    if (!countChanged && nextTitle === meta.title) return;
    const next = sessions.map((s) =>
      s.id === id
        ? {
            ...s,
            title: nextTitle,
            updatedAt: Date.now(),
            lastMessageCount: count,
          }
        : s,
    );
    set({ sessions: next });
    void saveSessionsList(next);
  },
  injectMessage: async (id, text) => {
    // Hydrate persisted history BEFORE constructing a chat, so evicting a
    // session from the LRU and receiving a watch/steering message while it's
    // inactive can't instantiate an empty Chat and clobber the real history.
    const hasChat = chats.has(id);
    if (!hasChat && !seedMessages.has(id)) {
      const m = await loadMessages(id);
      if (m && m.length > 0 && !chats.has(id) && !seedMessages.has(id)) {
        seedMessages.set(id, stripIncompleteToolMessages(m));
      }
    }
    const chat = getOrCreateChat(id);
    // Push a system-originated user message into the chat's message array.
    chat.messages = [
      ...chat.messages,
      {
        id: `watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "user",
        parts: [{ type: "text" as const, text }],
        metadata: { kind: "watch" },
      } as UIMessage,
    ];
    // Force a Zustand re-render so the UI shows the injected message.
    set({ _tick: Date.now() });
    // ── Wake the agent. Appending via the bare `messages` setter does NOT
    // trigger a run (only sendMessage/addToolResult consult
    // sendAutomaticallyWhen), so a fired watch used to land in the
    // transcript and the model never reacted. Call sendMessage() with no
    // args: it makes a request over the current history — which now ends
    // with the watch message.
    //
    // If the agent is mid-run (streaming/submitted) or a run's last assistant
    // turn ended on a pending approval, DON'T drop the wake: the in-flight run
    // has already snapshotted its message list (the injected watch message is
    // invisible to it), and sending now would yank the paused agent out of its
    // state. Queue the wake instead — AgentRunBridge flushes it as soon as the
    // run settles back to idle.
    if (
      chat.status === "streaming" ||
      chat.status === "submitted" ||
      hasPendingApprovals(chat)
    ) {
      queueWatchWake(id);
    } else {
      void chat.sendMessage().catch((e) => {
        console.error("[kai] watch wake-up failed:", e);
      });
    }
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

  startShadowMode: async () => {
    const activeId = get().activeSessionId;
    const root = get().live?.getWorkspaceRoot?.() ?? null;
    if (!activeId || !root) return null;
    // One shadow per project (Rust invariant) — don't double-start.
    if (getShadow(root)) return null;
    try {
      // Files first: if the copy fails, the conversation was never forked and
      // the user sees one actionable error instead of a half-applied mode.
      await createShadow(root);
      // Conversation: fork the FULL history (the user keeps watching the same
      // thread; the original session stays untouched as the "before" record).
      const live = chats.get(activeId)?.messages;
      const source =
        live && live.length > 0
          ? live
          : await loadMessages(activeId).then((m) => m ?? []);
      const messages = stripIncompleteToolMessages(source);
      const newId = newSessionId();
      await saveMessages(newId, messages);
      const meta: SessionMeta = {
        id: newId,
        title: "Shadow mode",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        parentId: activeId,
        forkMessageIndex: Math.max(0, messages.length - 1),
        workspaceRoot: root,
      };
      const next = [meta, ...get().sessions];
      set({ sessions: next, activeSessionId: newId, agentMeta: IDLE_META });
      seedMessages.set(newId, messages);
      void saveSessionsList(next);
      void saveActiveId(newId);
      return newId;
    } catch (err) {
      console.error("[startShadowMode] failed:", err);
      return null;
    }
  },

  mergeSession: async (sourceId, targetId) => {
    if (sourceId === targetId) return false;
    if (!get().sessions.some((s) => s.id === sourceId)) return false;
    if (!get().sessions.some((s) => s.id === targetId)) return false;

    try {
      // Prefer the resident (live) message arrays; fall back to persisted.
      const sourceLive = chats.get(sourceId)?.messages;
      const targetLive = chats.get(targetId)?.messages;

      const [source, target] = await Promise.all([
        sourceLive
          ? Promise.resolve(sourceLive)
          : loadMessages(sourceId).then((m) => m ?? []),
        targetLive
          ? Promise.resolve(targetLive)
          : loadMessages(targetId).then((m) => m ?? []),
      ]);

      const sourceClean = stripIncompleteToolMessages(source);
      if (sourceClean.length === 0) return false;

      // A visible divider so the merged tail is clearly separable from the
      // target's original history.
      const divider: UIMessage = {
        id: `merge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "\n\n---\n\n*Merged conversation (continued from a branched thread)*\n",
          },
        ],
      } as UIMessage;

      const merged = [...target, divider, ...sourceClean];
      await saveMessages(targetId, merged);

      // Adopt the merged history into the target's resident chat (or seed it
      // for a future open) so the UI reflects the merge immediately.
      const resident = chats.get(targetId);
      if (resident) {
        resident.messages = merged;
      } else {
        seedMessages.set(targetId, merged);
      }

      // Drop the source; activate the target so the user lands on the merged
      // result.
      const remaining = get().sessions.filter((s) => s.id !== sourceId);
      const next = remaining.map((s) =>
        s.id === targetId
          ? { ...s, updatedAt: Date.now(), parentId: undefined }
          : s,
      );
      set({ sessions: next, activeSessionId: targetId });
      void saveSessionsList(next);
      void saveActiveId(targetId);

      // Clean up the source's in-memory chat + any pending persistence.
      abortRunController(sourceId);
      chats.get(sourceId)?.stop();
      chats.delete(sourceId);
      seedMessages.delete(sourceId);
      const pend = pendingPersist.get(sourceId);
      if (pend) {
        clearTimeout(pend.timer);
        pendingPersist.delete(sourceId);
      }
      void deleteSessionData(sourceId);
      void useTodosStore.getState().clearSession(sourceId);
      reapSessionWatches(sourceId);
      closeWatchSessionShell(sourceId);
      clearFenceState(sourceId);
      agentBus.emit("session:delete", { sessionId: sourceId });

      return true;
    } catch (err) {
      console.error("[mergeSession] failed:", err);
      return false;
    }
  },

  steeringMessage: null,
  setSteeringMessage: (msg) => set({ steeringMessage: msg }),
  releaseStaleApprovals: (sessionId) => {
    const chat = chats.get(sessionId);
    if (!chat) return;
    releaseStaleApprovalsOnly(chat);
  },
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
 * Strip only STALE pending approvals — never a live approval card.
 *
 * A pending (`approval-requested`) part is stale when:
 *  - it sits on an assistant message that is NOT the last assistant message
 *    (a later message exists, so the turn it belonged to is over), or
 *  - the chat status is `error` (the run died; the card can never resolve).
 *
 * On the LAST assistant message with a non-error status the card is LIVE:
 * the run is paused awaiting the user's click. Stripping it would yank an
 * interactive approval away from the user.
 *
 * Stale parts otherwise pin the session in `awaiting-approval` forever
 * (busy UI, blocked sends) because the pending-approvals counter in
 * AgentRunBridge scans ALL history.
 */
function releaseStaleApprovalsOnly(chat: Chat<UIMessage>): void {
  if (!hasPendingApprovals(chat)) return;
  const stripAll = chat.status === "error";
  let lastAssistantIdx = -1;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    if (chat.messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  let changed = false;
  const out = chat.messages.map((m, i) => {
    if (m.role !== "assistant") return m;
    if (!stripAll && i === lastAssistantIdx) return m; // live card — keep
    const kept = m.parts.filter((p) => {
      const ptype = (p as { type?: string }).type ?? "";
      if (!ptype.startsWith("tool-") && ptype !== "dynamic-tool") return true;
      return (p as { state?: string }).state !== "approval-requested";
    });
    if (kept.length === m.parts.length) return m;
    changed = true;
    if (kept.length > 0) return { ...m, parts: kept } as UIMessage;
    return null;
  });
  if (!changed) return;
  chat.messages = out.filter((m): m is UIMessage => m !== null);
}

/**
 * Drop unfinished tool-call PARTS from assistant messages (e.g. an
 * `approval-requested` we never responded to). Mirrors the transport's
 * `stripIncompleteToolCalls`: keeping a message whose tool call never got an
 * output/approval response would corrupt the next request — and, when loaded
 * from disk, the orphaned `approval-requested` part pins the session in the
 * `awaiting-approval` busy state forever.
 *
 * Strips at the PART level (not the whole message) so the assistant's visible
 * text surrounding the abandoned tool call is preserved.
 */
function stripIncompleteToolMessages(messages: UIMessage[]): UIMessage[] {
  if (messages.length === 0) return messages;
  let changed = false;
  const out: UIMessage[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") {
      out.push(m);
      continue;
    }
    const kept = m.parts.filter((p) => {
      const ptype = (p as { type?: string }).type ?? "";
      if (!ptype.startsWith("tool-") && ptype !== "dynamic-tool") return true;
      const state = (p as { state?: string }).state;
      return state != null && COMPLETE_PART_STATES.has(state);
    });
    if (kept.length === m.parts.length) {
      out.push(m);
    } else {
      changed = true;
      if (kept.length > 0) out.push({ ...m, parts: kept } as UIMessage);
    }
  }
  return changed ? out : messages;
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
  // Abort our own controller FIRST — this works even when Chat.stop() is a
  // no-op because the SDK's status is no longer streaming/submitted.
  abortRunController(sessionId);
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
  // AUDIT: record the human decision — the one thing the agent's own
  // transcript can't prove. Fire-and-forget; never blocks the response.
  const auditSummary = describeApproval(approvalId, approved, state);
  auditAppend(
    approved ? AUDIT_KINDS.approvalApprove : AUDIT_KINDS.approvalDeny,
    auditSummary.subject,
    auditSummary.summary,
    auditSummary.root,
  );
  const fn = state.approvalResponder;
  if (fn) fn(approvalId, approved);
  // Same rationale as respondToApproval: don't abort on denial.
  // The agent should see the denial and continue gracefully.
}

/** Best-effort approval description for the audit trail: tool name + a
 *  scrubbed short excerpt of the input. Never throws. */
function describeApproval(
  approvalId: string,
  approved: boolean,
  state: StoreState,
): { subject: string; summary: string; root: string } {
  try {
    // Find the approval-requested part across session messages to recover
    // the tool name + input. (The resolver map isn't exported; scanning is
    // acceptable — one pass over the active session's messages.)
    const root =
      state.live?.getWorkspaceRoot?.() ??
      usePreferencesStore.getState().lastWorkspaceCwd ??
      "";
    const chat = chats.get(state.activeSessionId ?? "");
    if (!chat) return { subject: "unknown", summary: `approval ${approved ? "approved" : "denied"} (${approvalId})`, root };
    for (const m of chat.messages) {
      for (const p of m.parts as Array<Record<string, unknown>>) {
        const approval = p.approval as { id?: string } | undefined;
        if (approval?.id !== approvalId) continue;
        const input = (p.input ?? {}) as Record<string, unknown>;
        // Tool name derivation mirrors AiChat's pendingApprovals: regular
        // tools encode it in part.type ("tool-<name>"); dynamic-tool parts
        // (MCP) carry it under toolName. Reading p.toolName directly made
        // every regular approval audit as "unknown".
        const type = String((p as { type?: string }).type ?? "");
        const subject = String(
          type === "dynamic-tool"
            ? ((p as { toolName?: string }).toolName ?? "tool")
            : type.replace(/^tool-/, ""),
        );
        // Command/path excerpt — scrubbed again on the Rust side.
        const cmd =
          typeof input.command === "string"
            ? input.command.slice(0, 160)
            : typeof input.path === "string"
              ? input.path
              : "";
        return {
          subject,
          summary: `${approved ? "approved" : "denied"}${cmd ? `: ${cmd}` : ""}`,
          root,
        };
      }
    }
    return { subject: "unknown", summary: `approval ${approved ? "approved" : "denied"} (${approvalId})`, root };
  } catch {
    return { subject: "unknown", summary: `approval decision (${approvalId})`, root: "" };
  }
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
  // Abort our own controller unconditionally — the Stop button must work even
  // when the model is stuck in a reasoning/tool loop where `Chat.stop()` is a
  // silent no-op (SDK status is neither streaming nor submitted).
  abortRunController(sessionId);
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
