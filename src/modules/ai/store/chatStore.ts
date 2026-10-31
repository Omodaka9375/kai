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
import { useAgentsStore } from "./agentsStore";
import { setProjectAgentStatus } from "./projectStatus";
// Deep import, NOT the workspace barrel: the barrel re-exports ProjectRail (a
// React component that imports groupChatStore), and this module is imported
// before groupChatStore in the app's eval order — pulling the barrel here made
// groupChatStore evaluate mid-chatStore, whose top-level setChatPinner(...)
// then hit this module's `let chatPinner` TDZ and crashed the whole boot.
import { projectIdFor } from "@/modules/workspace/projectRuntime";
import { useTodosStore } from "./todoStore";
import {
  getSessionPreferences,
  removeSessionPreferences,
  setSessionPreferences,
} from "./sessionPreferences";
import { EMPTY_PROVIDER_KEYS, type ProviderKeys } from "../lib/keyring";
import {
  deleteSessionData,
  deriveTitle,
  ensureMigratedOnce,
  forkSession as forkSessionFromStore,
  loadAll,
  loadAllForRoot,
  loadMessages,
  loadMessagesForRoot,
  newSessionId,
  saveActiveId,
  saveActiveIdForRoot,
  saveMessages,
  saveMessagesForRoot,
  saveSessionsList,
  saveSessionsListForRoot,
  scopedPath,
  sessionsScopeFile,
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
import { isApprovalDenied, noteApprovalDenied } from "../lib/approvalLatch";
import { appendSessionEvent } from "../lib/sessionEvents";
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

/** Two-state approval mode: Ask reviews each approval-required call; Allow
 * auto-approves the session except for explicit consent carve-outs. */
export type AutoApproveMode = "off" | "all";

/** Tool names that are file mutations (auto-approved in 'edits' mode). */
export const FILE_MUTATION_TOOLS = new Set([
  "write_file",
  "edit",
  "batch_edit",
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
  setApprovalResponderForSession: (sessionId: string, fn: ApprovalResponder | null) => void;
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

  /** Right-gutter stack: which surface owns the single expanded slot. */
  stackRail: { surface: "ai" | "group" };
  /** Show the AI mini window (swap: group panel collapses to its pill). */
  openMiniToStack: () => void;
  /** Expand the group panel (swap: AI mini window collapses to its pill). */
  openGroupToStack: () => void;
  /** ✕ on the group panel — AI mini window comes back automatically. */
  closeGroupFromStack: () => void;
  /** Group panel full-view state — the twin of mini.expanded. */
  groupPanelExpanded: boolean;
  setGroupPanelExpanded: (expanded: boolean) => void;

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
  hydrateSessions: (workspaceRoot?: string | null, runtime?: import("@/modules/workspace").ProjectRuntime) => Promise<void>;
  newSession: () => string;
  switchSession: (id: string) => void;
  /** Archive hides a session from the active list without stopping its run
   *  or deleting its transcript. Restoring it makes it the active session. */
  archiveSession: (id: string) => void;
  restoreSession: (id: string) => void;
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
 * WATCH WAKE POLICY (the pending-wake queue was removed):
 *
 * A watch fire that lands while the agent is mid-run (streaming/submitted)
 * or paused on an approval card is PASSIVE — the injected message sits in
 * history and rides the next request (the user's next message, a
 * continuation, anything) rather than starting its own turn. The old
 * behavior queued a self-initiated wake that fired the moment the run
 * settled, hijacking the user's conversation with an unsolicited narrated
 * response mid-exchange ("it fires in the middle of my conversation and
 * messes everything up"). Idle fires (agent ready, nothing in flight) still
 * wake proactively — that's the walk-away monitoring contract.
 */

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
    const chat = chats.get(oldest);
    // Never kill background work to satisfy an in-memory cache budget.
    // Busy/approval-paused chats stay pinned; idle ones may be evicted.
    // External subsystems may ALSO pin a chat: cross-project group chats
    // pin their live participants so a mid-round delegation is never
    // evicted and rehydrated from a stale snapshot. Registered via
    // setChatPinner (chatStore cannot import the group store - cycle).
    if (
      useChatStore.getState().activeSessionId === oldest ||
      chat?.status === "streaming" ||
      chat?.status === "submitted" ||
      (chat ? hasPendingApprovals(chat) : false) ||
      chatPinner?.(oldest)
    ) break;
    flushPersistEntry(oldest);
    void chat?.stop();
    chats.delete(oldest);
  }
}

/** Externally-registered LRU pin predicate (returns true = never evict).
 *  Used by the group-chat store to pin live-group participant/coordinator
 *  chats. Single-slot inversion: chatStore cannot import the group store
 *  (module cycle); the group store registers at module init. */
let chatPinner: ((id: string) => boolean) | null = null;
export function setChatPinner(fn: ((id: string) => boolean) | null): void {
  chatPinner = fn;
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

/** The session-id → workspace-root map used to re-route cross-scope writes.
 *  Filled by persistSessionsRoot() at hydrate/persist time (see
 *  noteSessionRoot below). */
const sessionRoots = new Map<string, string | null>();

/** Record the workspace root a session belongs to (called from
 *  persistMessages' guard path and from hydrate). */
function noteSessionRoot(id: string, root: string | null | undefined) {
  const r = root == null ? null : normalizeWorkspacePath(root);
  sessionRoots.set(id, r);
  return r;
}

/**
 * saveMessages with cross-scope RE-ROUTING (not dropping).
 *
 * The module-level sessions store is re-pointed per project by
 * setSessionsScope. After a project switch, a late/lingering write for the
 * OUTGOING project's session must not land in the NEW project's file — that
 * was the corruption bug. But dropping it would silently lose the outgoing
 * project's message tail. So route the write to the file the session
 * BELONGS to: if the session's recorded root maps to a different scoped
 * file than the current scope, write via saveMessagesForRoot (a one-off
 * LazyStore for that file), else via the (fast) current-scope saveMessages.
 *
 * A root is known for a session once it has gone through persistMessages
 * (which records it) or hydrate. Until then, fall back to the current scope
 * — cold-start persists are always post-hydrate of the session's own
 * project, so the fallback is safe.
 */
function saveMessagesRerouted(id: string, messages: UIMessage[]): void {
    const session = useChatStore.getState().sessions.find((s) => s.id === id);
    const root = sessionRoots.get(id) ?? session?.workspaceRoot ?? activeProjectRuntime?.root;
    const env = session?.workspaceEnv ?? (session ? { kind: "local" as const } : activeProjectRuntime?.env);
  // Unknown session → current scope (cold-start fast path).
  if (root === undefined) {
    void saveMessages(id, messages);
    return;
  }
  const targetFile = scopedPath(root, env);
  if (targetFile !== sessionsScopeFile()) {
    console.warn(
      `[saveMessages] re-routing cross-scope write for session ${id} to its own project file (scope moved on)`,
    );
    void saveMessagesForRoot(root, id, messages, env);
    return;
  }
  void saveMessages(id, messages);
}

function flushPersistEntry(id: string) {
  const entry = pendingPersist.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingPersist.delete(id);
  saveMessagesRerouted(id, entry.latest);
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
/** Active-window runtime for legacy/global callers. Each project installs
 * its own runtime while its chats are being created/hydrated. */
let activeProjectRuntime: import("@/modules/workspace").ProjectRuntime | undefined;
const projectRuntimes = new Map<string, import("@/modules/workspace").ProjectRuntime>();
const projectLive = new Map<string, ChatRuntimeDeps["live"]>();
const projectModels = new Map<string, ModelId>();
const projectPersonas = new Map<string, string>();
const approvalResponders = new Map<string, ApprovalResponder>();
/** Which session currently holds an approval id - the owner the decision
 *  must route to. Same scan shape describeApproval uses (part.approval.id). */
function findApprovalOwner(approvalId: string): string | null {
  for (const [sessionId, chat] of chats) {
    for (const m of chat.messages) {
      for (const p of (m.parts ?? []) as Array<Record<string, unknown>>) {
        const approval = p.approval as { id?: string } | undefined;
        if (approval?.id === approvalId) return sessionId;
      }
    }
  }
  return null;
}
const sessionAgentMeta = new Map<string, AgentMeta>();
const sessionMetaListeners = new Set<() => void>();
let sessionMetaVersion = 0;
export function subscribeSessionAgentMeta(listener: () => void): () => void {
  sessionMetaListeners.add(listener);
  return () => sessionMetaListeners.delete(listener);
}
/** Version signal for useSyncExternalStore subscribers: bump-count per meta
 *  patch. A constant snapshot (() => 0) NEVER re-renders the component -
 *  presence strips reading it go stale the moment their parent stops
 *  re-rendering for unrelated reasons. */
export function getSessionMetaVersion(): number {
  return sessionMetaVersion;
}
const sessionAutoApprove = new Map<string, "off" | "all">();
/** Bumped on every setAutoApprove so subscribers (the bridge's auto-approve
 *  effect) re-read the mode reactively - a plain Map read is not reactive. */
let sessionAutoApproveVersion = 0;
const sessionAutoApproveListeners = new Set<() => void>();
export function subscribeSessionAutoApprove(listener: () => void): () => void {
  sessionAutoApproveListeners.add(listener);
  return () => sessionAutoApproveListeners.delete(listener);
}
export function getSessionAutoApproveVersion(): number {
  return sessionAutoApproveVersion;
}
function bumpAutoApproveVersion(): void {
  sessionAutoApproveVersion++;
  for (const listener of sessionAutoApproveListeners) listener();
}
export function getSessionAgentMeta(sessionId: string): AgentMeta {
  return sessionAgentMeta.get(sessionId) ?? IDLE_META;
}
export function getSessionAutoApprove(sessionId: string): "off" | "all" {
  return sessionAutoApprove.get(sessionId) ?? "off";
}
export function patchSessionAgentMeta(sessionId: string, patch: Partial<AgentMeta>): void {
  const next = { ...getSessionAgentMeta(sessionId), ...patch };
  sessionAgentMeta.set(sessionId, next);
  sessionMetaVersion++;
  const ownerId = projectIdForSession(sessionId);
  if (ownerId) setProjectAgentStatus(ownerId, next.status);
  if (useChatStore.getState().activeSessionId === sessionId) {
    useChatStore.setState({ agentMeta: next });
  }
  for (const listener of sessionMetaListeners) listener();
}
const sessionSteeringMessages = new Map<string, LoosePart[] | null>();
export function setSessionSteeringMessage(sessionId: string, parts: LoosePart[] | null): void {
  if (parts) sessionSteeringMessages.set(sessionId, parts);
  else sessionSteeringMessages.delete(sessionId);
  useChatStore.setState({ steeringMessage: parts });
}
export function getSessionSteeringMessage(sessionId: string): LoosePart[] | null {
  return sessionSteeringMessages.get(sessionId) ?? null;
}
export function getApprovalResponder(sessionId: string): ApprovalResponder | null {
  return approvalResponders.get(sessionId) ?? null;
}

const projectActiveSessions = new Map<string, string | null>();
const projectActiveSessionListeners = new Set<() => void>();
export function subscribeProjectActiveSessions(listener: () => void): () => void {
  projectActiveSessionListeners.add(listener);
  return () => projectActiveSessionListeners.delete(listener);
}

/**
 * True for a session that has never had content: untitled, no recorded
 * message growth, not a fork/shadow. Boot manufactures such placeholders
 * in MEMORY ONLY (they die with the process) and hydration purges any that
 * older builds persisted. Display filters use this to keep the session
 * picker free of "New chat" litter — the ACTIVE session is always exempt
 * (the user is looking at it).
 */
export function isGhostSession(s: SessionMeta): boolean {
  return (
    (!s.title || s.title === "New chat") &&
    (s.lastMessageCount ?? 0) === 0 &&
    !s.parentId
  );
}

function persistActiveSessionsList(sessions: SessionMeta[]): void {
  // Ghost guard: memory-only placeholders must never land in a store file.
  // (Older builds persisted a fresh "New chat" on every boot per project —
  // that litter is what the session picker was drowning in.)
  const real = sessions.filter((s) => !isGhostSession(s));
  void (activeProjectRuntime
    ? saveSessionsListForRoot(activeProjectRuntime.root, real, activeProjectRuntime.env)
    : saveSessionsList(real));
}
function persistActiveSessionId(id: string | null): void {
  // Ghost guard: never persist the id of a content-less placeholder — the
  // file would resurrect a dead "New chat" as the active session.
  if (id != null) {
    const meta = useChatStore.getState().sessions.find((s) => s.id === id);
    if (meta && isGhostSession(meta)) return;
  }
  void (activeProjectRuntime
    ? saveActiveIdForRoot(activeProjectRuntime.root, id, activeProjectRuntime.env)
    : saveActiveId(id));
}

export function getProjectActiveSession(projectId: string): string | null {
  return projectActiveSessions.get(projectId) ?? null;
}
/** The currently ACTIVE project id (null when no project is open).
 *  Used by cross-project surfaces (watch firings) to decide whether an
 *  event lands in the project the user is looking at. */
export function activeProjectId(): string | null {
  return activeProjectRuntime?.id ?? null;
}

export function projectIdForSession(sessionId: string): string | null {
  const session = useChatStore.getState().sessions.find((s) => s.id === sessionId);
  const root = normalizeWorkspacePath(session?.workspaceRoot);
  // Root+environment is canonical. A foreground switch can briefly expose
  // the previous project's active id; a preference written during that
  // window must never reassign the session to the incoming project.
  if (root) return projectIdFor(root, session?.workspaceEnv ?? { kind: "local" });
  return getSessionPreferences(sessionId).projectId ?? null;
}

export function setProjectActiveSession(projectId: string, sessionId: string | null): void {
  if (projectActiveSessions.get(projectId) === sessionId) return;
  projectActiveSessions.set(projectId, sessionId);
  for (const listener of projectActiveSessionListeners) listener();
}

export function setActiveProjectRuntime(runtime: import("@/modules/workspace").ProjectRuntime): void {
  activeProjectRuntime = runtime;
  projectRuntimes.set(runtime.id, runtime);
}
export function getActiveProjectRuntime(): import("@/modules/workspace").ProjectRuntime | undefined {
  return activeProjectRuntime;
}
export function registerProjectRuntime(runtime: import("@/modules/workspace").ProjectRuntime): void {
  projectRuntimes.set(runtime.id, runtime);
}

/** Bind live UI handles to their owning project, not the foreground window. */
export function setProjectLive(projectId: string, live: ChatRuntimeDeps["live"]): void {
  projectLive.set(projectId, live);
}
export function setProjectModel(projectId: string, model: ModelId, personaId: string): void {
  projectModels.set(projectId, model);
  projectPersonas.set(projectId, personaId);
}
export function getProjectModel(projectId: string, fallback: ModelId = DEFAULT_MODEL_ID): ModelId {
  return projectModels.get(projectId) ?? fallback;
}
const runtimeDeps: ChatRuntimeDeps = {
  projectRuntime: undefined,
  getAgentPersonaId: () => undefined,
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
  isActiveSession: (sessionId) => {
    const meta = useChatStore.getState().sessions.find((s) => s.id === sessionId);
    const root = normalizeWorkspacePath(meta?.workspaceRoot);
    // Background projects run independently: their stream callbacks must
    // update their own status/persistence even when another project is visible.
    if (activeProjectRuntime && root && root !== normalizeWorkspacePath(activeProjectRuntime.root)) {
      return true;
    }
    return useChatStore.getState().activeSessionId === sessionId;
  },
  patchAgentMeta: (patch) => {
    const id = useChatStore.getState().activeSessionId;
    if (id) patchSessionAgentMeta(id, patch);
  },
  abortRunController,
  compactActiveSession: () =>
    useChatStore.getState().compactActiveSession(),
  compactSession: (sessionId) => {
    const previous = useChatStore.getState().activeSessionId;
    if (previous !== sessionId) useChatStore.getState().switchSession(sessionId);
    const result = useChatStore.getState().compactActiveSession();
    if (previous !== sessionId && previous) useChatStore.getState().switchSession(previous);
    return result;
  },
};

/**
 * Create a Chat instance synchronously via the store-decoupled runtime.
 * Stack detection happens in the background and stackInfo will be updated
 * via the getStackInfo callback.
 */
function makeChatSync(sessionId: string): Chat<UIMessage> {
  const session = useChatStore.getState().sessions.find((s) => s.id === sessionId);
  const sessionRoot = session?.workspaceRoot;
  // A session belongs to its recorded project, not whichever workspace is
  // currently visible (watch/LRU recreation can happen in the background).
  const project = sessionRoot
    ? [...projectRuntimes.values()].find((candidate) =>
      normalizeWorkspacePath(candidate.root) === normalizeWorkspacePath(sessionRoot) &&
      (candidate.env.kind === (session?.workspaceEnv?.kind ?? "local")) &&
      (candidate.env.kind !== "wsl" || session?.workspaceEnv?.kind === "wsl" && candidate.env.distro === session.workspaceEnv.distro))
    : activeProjectRuntime;
  const fallback = (projectLive.get(project?.id ?? "") ?? runtimeDeps.live) as unknown as Live;
  const live: Live = {
    getCwd: () => (project ? projectLive.get(project.id) : undefined)?.getCwd() ?? fallback.getCwd(),
    getTerminalContext: () => (project ? projectLive.get(project.id) : undefined)?.getTerminalContext() ?? fallback.getTerminalContext(),
    getWorkspaceRoot: () => (project ? projectLive.get(project.id) : undefined)?.getWorkspaceRoot() ?? fallback.getWorkspaceRoot(),
    getActiveFile: () => (project ? projectLive.get(project.id) as unknown as Live : undefined)?.getActiveFile() ?? fallback.getActiveFile(),
    openPreview: (url: string) => (project ? projectLive.get(project.id) : undefined)?.openPreview(url) ?? fallback.openPreview(url),
    isActiveTerminalPrivate: () => (project ? projectLive.get(project.id) : undefined)?.isActiveTerminalPrivate() ?? fallback.isActiveTerminalPrivate(),
    injectIntoActivePty: (text: string) => (project ? projectLive.get(project.id) : undefined)?.injectIntoActivePty(text) ?? fallback.injectIntoActivePty(text),
    writeToActiveTerminalDisplay: (data: string) => (project ? projectLive.get(project.id) : undefined)?.writeToActiveTerminalDisplay(data) ?? fallback.writeToActiveTerminalDisplay(data),
  };
  return makeChatSyncRuntime(
    sessionId,
    {
      ...runtimeDeps,
      projectRuntime: project,
      live: live ?? runtimeDeps.live,
      patchAgentMeta: (patch) => patchSessionAgentMeta(sessionId, patch),
      getSelectedModelId: () => getSessionPreferences(sessionId).modelId ?? (project
        ? (projectModels.get(project.id) ?? useChatStore.getState().selectedModelId)
        : runtimeDeps.getSelectedModelId()),
      getAgentPersonaId: () => getSessionPreferences(sessionId).personaId ??
        (project
          ? projectIdForSession(sessionId) === project.id
            ? projectPersonas.get(project.id)
            : undefined
          : undefined),
    },
    seedMessages,
    resolveErrorDisplay,
  );
}
export const useChatStore = create<StoreState>((set, get) => ({
  live: NOOP_LIVE,
  setLive: (live) => set({ live }),

  approvalResponder: null,
  setApprovalResponder: (fn) => set({ approvalResponder: fn }),
  setApprovalResponderForSession: (sessionId, fn) => {
    if (fn) approvalResponders.set(sessionId, fn);
    else approvalResponders.delete(sessionId);
    if (get().activeSessionId === sessionId) set({ approvalResponder: fn });
  },
  respondToApproval: (approvalId, approved) => {
    // Denial is monotonic: latch it so no deferred auto-approve/allowlist
    // callback can re-permit this exact call afterward. An approve that
    // arrives after a denial is dropped (the SDK is otherwise last-writer).
  if (!approved) noteApprovalDenied(approvalId);
  else if (isApprovalDenied(approvalId)) return;
  // Route by OWNING session, not the global foreground responder: a pending
  // approval may belong to a background project's session (per-window
  // bridges register per-session responders). The global responder is the
  // ACTIVE session's closure - calling it with another session's approval id
  // throws "Tool call not found" inside the bridge's swallow-all catch and
  // the user's click silently does nothing while the card pins forever.
  const owner = approvalResponders.size > 0 ? findApprovalOwner(approvalId) : null;
  if (owner) {
    const fn = approvalResponders.get(owner);
    if (fn) {
      fn(approvalId, approved);
      return;
    }
  }
  const fallback = get().approvalResponder;
  if (fallback) fallback(approvalId, approved);
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
    const sessionId = get().activeSessionId;
    if (sessionId) setSessionPreferences(sessionId, { modelId: id });
    set({ selectedModelId: id });
    if (activeProjectRuntime) {
      setProjectModel(activeProjectRuntime.id, id, useAgentsStore.getState().activeId);
    }
    void pushRecentModel(id);
    // live.getWorkspaceRoot() may be null during startup before setLive()
    // runs — fall back to lastWorkspaceCwd so the model is always persisted.
    const root =
      get().live.getWorkspaceRoot() ??
      usePreferencesStore.getState().lastWorkspaceCwd ??
      null;
    void persistProjectModel(id, root);
    },

  mini: { open: false, expanded: false },
  openMini: () => set((s) => ({ mini: { open: true, expanded: s.mini.expanded } })),
  closeMini: () => set((s) => ({ mini: { open: false, expanded: s.mini.expanded } })),
  toggleMini: () => set((s) => ({ mini: { open: !s.mini.open, expanded: s.mini.expanded } })),
  setMiniExpanded: (expanded) =>
    set((s) => ({ mini: { open: s.mini.open, expanded } })),
  collapseMini: () =>
    set((s) => ({ mini: { open: s.mini.open, expanded: false } })),

  // Right-gutter stack rail: the AI mini window and the group panel share
  // ONE expanded slot. expandedSurface says which surface currently owns
  // the slot; the OTHER one is collapsed to its pill. This lives in the
  // store (not component state) so the two surfaces can swap each other
  // without prop-drilling across the app-level panel.
  stackRail: { surface: "ai" },
  // Group panel full-view state — the twin of mini.expanded. Every slot
  // swap RESETS it: a freshly opened group starts docked, and handing the
  // slot back to AI collapses it. A stale true would full-screen the panel
  // the next time it opens.
  groupPanelExpanded: false,
  setGroupPanelExpanded: (expanded) => set({ groupPanelExpanded: expanded }),
  openMiniToStack: () =>
    set((s) => ({ mini: { open: true, expanded: s.mini.expanded }, stackRail: { surface: "ai" }, groupPanelExpanded: false })),
  openGroupToStack: () =>
    set(() => ({ stackRail: { surface: "group" }, groupPanelExpanded: false })),
  /** Close (✕) the group panel: the AI mini window automatically comes
   *  back — either AI or the group owns the expanded slot, never neither. */
  closeGroupFromStack: () =>
    set((s) => ({ stackRail: { surface: "ai" }, mini: { open: true, expanded: s.mini.expanded }, groupPanelExpanded: false })),

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
  patchAgentMeta: (patch) => {
    const sessionId = get().activeSessionId;
    const next = sessionId
      ? { ...getSessionAgentMeta(sessionId), ...patch }
      : { ...get().agentMeta, ...patch };
    if (sessionId) {
      sessionAgentMeta.set(sessionId, next);
      const ownerId = projectIdForSession(sessionId);
      if (ownerId) setProjectAgentStatus(ownerId, next.status);
    }
    // Only the owning foreground session drives this workspace's composer.
    set({ agentMeta: next });
  },
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
      void saveMessagesRerouted(sessionId, next);
    }
  },

  autoApprove: "off" as AutoApproveMode,
  setAutoApprove: (mode) => {
    const sessionId = get().activeSessionId;
    if (sessionId) {
      sessionAutoApprove.set(sessionId, mode);
      bumpAutoApproveVersion();
      // Persist onto the session's meta so the choice survives relaunch -
      // the Map is memory-only and used to reset a user-set "Allow" back
      // to "Ask" on every start.
      const next = get().sessions.map((s) =>
        s.id === sessionId ? { ...s, autoApprove: mode } : s,
      );
      set({ sessions: next, autoApprove: mode });
      persistActiveSessionsList(next);
      return;
    }
    set({ autoApprove: mode });
  },
  cycleAutoApprove: () => {
    const cur = get().autoApprove;
    const next: AutoApproveMode = cur === "off" ? "all" : "off";
    // The bridge reads the SESSION-scoped mode, not this legacy presentation
    // field. Route cycling through the same action as an explicit set so the
    // visible Allow/Ask control and actual approval behavior cannot diverge.
    get().setAutoApprove(next);
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

  hydrateSessions: async (workspaceRoot?: string | null, runtime?: import("@/modules/workspace").ProjectRuntime) => {
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
    // Capture the owning project ONCE. The foreground runtime can change
    // while this hydration awaits storage (A → B → A); reading the mutable
    // global below would restore B's active session into A's workspace.
    const hydrationRuntime = runtime ?? activeProjectRuntime;
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
    await setSessionsScope(root, hydrationRuntime?.env);
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
      const loaded = hydrationRuntime
        ? await loadAllForRoot(hydrationRuntime.root, hydrationRuntime.env)
        : await loadAll();
      if (isStale()) return;
      sessions = loaded.sessions;
      loadedActiveId = loaded.activeId;
      // Record each loaded session's OWN workspace root so later persist
      // paths (the debounced flush, resolveMedia, LRU eviction) can re-route
      // cross-scope writes to the right project file after another switch.
      for (const s of sessions) noteSessionRoot(s.id, s.workspaceRoot ?? null);
    } catch (err) {
      console.error(
        "[hydrateSessions] Failed to load sessions — resetting store:",
        err,
      );
    }

    // ── Ghost purge ────────────────────────────────────────────────────
    // Untitled, message-less sessions are placeholder litter left by older
    // builds (boot used to manufacture + PERSIST a fresh "New chat" per
    // project, so files accumulated one per launch). A ghost by META alone
    // isn't proof of emptiness — old builds never stamped lastMessageCount —
    // so verify against the persisted message blob before dropping
    // anything. Populated survivors get their lastMessageCount backfilled,
    // which makes the meta predicate sound for every later display filter.
    {
      const ghostCandidates = sessions.filter((s) => isGhostSession(s));
      const ghostIds: string[] = [];
      let backfilled = false;
      for (const s of ghostCandidates) {
        const blob = await (hydrationRuntime
          ? loadMessagesForRoot(hydrationRuntime.root, s.id, hydrationRuntime.env)
          : loadMessages(s.id));
        if (isStale()) return;
        if (!blob || blob.length === 0) {
          ghostIds.push(s.id);
        } else {
          s.lastMessageCount = blob.length;
          backfilled = true;
        }
      }
      if (ghostIds.length > 0 || backfilled) {
        if (ghostIds.length > 0) {
          const dead = new Set(ghostIds);
          sessions = sessions.filter((s) => !dead.has(s.id));
          if (loadedActiveId && dead.has(loadedActiveId)) loadedActiveId = null;
          console.warn(
            `[hydrateSessions] purged ${ghostIds.length} empty session placeholder(s)`,
          );
        }
        // Write the cleaned list back — fire-and-forget; a failed write only
        // means the next hydration purges again.
        void (hydrationRuntime
          ? saveSessionsListForRoot(hydrationRuntime.root, sessions, hydrationRuntime.env)
          : saveSessionsList(sessions)).catch((err) =>
          console.error("[hydrateSessions] ghost purge persist failed:", err),
        );
      }
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

    const belongsToTarget = (session: SessionMeta) =>
      hydrationRuntime
        ? projectIdForSession(session.id) === hydrationRuntime.id
        : norm(session.workspaceRoot) === normalizedRoot ||
          (!session.workspaceRoot && normalizedRoot == null);

    // Find an existing untitled "New chat" session for this workspace so
    // we don't stack empty placeholders on every launch.
    const reusable = allSessions.find(
      (s) => s.title === "New chat" && belongsToTarget(s),
    );

    const currentActiveId = get().activeSessionId;
    // On cold start, restore the persisted last-active session before
    // falling back to a fresh/reusable one.
    // Prefer the LIVE last-active selection for this project (what the AI
    // window's session picker last set). Disk activeId lags behind it.
    const liveActiveId = hydrationRuntime
      ? getProjectActiveSession(hydrationRuntime.id)
      : null;
    const restoredActiveId = liveActiveId ?? loadedActiveId ?? null;

    // A real project switch (File > Open Project / StartPage recent /
    // local↔WSL) is the ONLY way the workspace root changes — plain terminal
    // `cd` never re-locks the root (useWorkspaceCwd). On a switch the
    // previous project's conversation must NOT stay active: resolve this
    // project's own session instead.
    const isWorkspaceSwitch =
      get().sessionsHydrated &&
      currentActiveId != null &&
      (hydrationRuntime
        ? (get().lastHydratedWorkspace
          ? projectIdFor(get().lastHydratedWorkspace!, hydrationRuntime.env) !== hydrationRuntime.id
          : true)
        : norm(get().lastHydratedWorkspace) !== normalizedRoot);

    // Sessions belonging to the target workspace, newest first. Falls back
    // to unscoped sessions when hydrating the unscoped store.
    const workspaceMatched = allSessions
      .filter(
        (s) =>
          belongsToTarget(s),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);

    let nextSessions: SessionMeta[];
    let nextActiveId: string | null = currentActiveId;

    if (isWorkspaceSwitch) {
      // Prefer the project's persisted last-active session, then its newest.
      nextActiveId =
        restoredActiveId != null &&
        workspaceMatched.some((s) => s.id === restoredActiveId)
          ? restoredActiveId
          : (workspaceMatched[0]?.id ?? null);
    } else if (!currentActiveId) {
      nextActiveId =
        restoredActiveId != null &&
        allSessions.some((s) => s.id === restoredActiveId)
          ? restoredActiveId
          : null;
    }

    const canRestoreTarget = nextActiveId != null &&
      workspaceMatched.some((session) => session.id === nextActiveId);
    if (reusable || canRestoreTarget) {
      // Do not manufacture a placeholder when this project already has a
      // session to restore. Repeated A→B→A switches must be idempotent.
      nextSessions = allSessions;
      if (!nextActiveId) nextActiveId = reusable!.id;
    } else {
      const freshId = newSessionId();
      const fresh: SessionMeta = {
        id: freshId,
        title: "New chat",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        workspaceRoot: root,
        workspaceEnv: hydrationRuntime?.env,
      };
      nextSessions = [fresh, ...allSessions];
      // Nothing from the target workspace to activate — the fresh session
      // (stamped with this root) becomes active.
      if (!nextActiveId) nextActiveId = freshId;
      // Deliberately NOT persisted: the placeholder is memory-only until
      // its first real message (persistMessages promotes it to disk). Older
      // builds persisted it here — that was the "New chat" litter source.
      // Hydration still finds a reusable in-memory placeholder on the next
      // boot-into-this-project via the `reusable` lookup above, or simply
      // manufactures a new one; nothing of value is lost.
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

    // Persist activeId ONLY when it points at a real session. The active
    // session can be a memory-only placeholder (fresh "New chat"); writing
    // its id to disk is exactly the ghost litter the purge above removes.
    {
      const activeMeta = nextSessions.find((s) => s.id === nextActiveId);
      if (!activeMeta || !isGhostSession(activeMeta)) {
        void (hydrationRuntime
          ? saveActiveIdForRoot(hydrationRuntime.root, nextActiveId, hydrationRuntime.env)
          : saveActiveId(nextActiveId)).catch((err) =>
          console.error("[hydrateSessions] Failed to persist activeId:", err),
        );
      }
    }

    // Seed the restored/next active session's persisted history BEFORE
    // flipping activeSessionId. If we flip first, React renders the body and
    // getOrCreateChat() constructs an EMPTY Chat (seedMessages is still empty,
    // loadMessages is async), and selecting that session later is a no-op
    // (switchSession early-returns when it's already active) — so a session
    // whose last run ended on an ignored approval would open blank forever.
    if (nextActiveId) {
      if (!chats.has(nextActiveId) && !seedMessages.has(nextActiveId)) {
        try {
          const m = hydrationRuntime
            ? await loadMessagesForRoot(hydrationRuntime.root, nextActiveId, hydrationRuntime.env)
            : await loadMessages(nextActiveId);
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

    // Restore persisted per-session auto-approve modes BEFORE the set()
    // below reads getSessionAutoApprove(nextActiveId) - a user-set "Allow"
    // used to silently reset to "Ask" on every relaunch (memory-only Map).
    for (const s of nextSessions) {
      if (s.autoApprove === "all" || s.autoApprove === "off") {
        sessionAutoApprove.set(s.id, s.autoApprove);
      }
    }

    if (hydrationRuntime) setProjectActiveSession(hydrationRuntime.id, nextActiveId);
    set({
      sessions: nextSessions,
      activeSessionId: nextActiveId,
      agentMeta: nextActiveId ? getSessionAgentMeta(nextActiveId) : IDLE_META,
      autoApprove: nextActiveId ? getSessionAutoApprove(nextActiveId) : "off",
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
      workspaceEnv: activeProjectRuntime?.env,
    };
    if (activeProjectRuntime) setSessionPreferences(id, { projectId: activeProjectRuntime.id });
    const next = [meta, ...get().sessions];
    set({
      sessions: next,
      activeSessionId: id,
      agentMeta: IDLE_META,
      autoApprove: "off" as AutoApproveMode,
      autoApprovedIds: new Set<string>(),
    });
    // Memory-only until real content: persistMessages promotes the
    // placeholder to disk on its first message (list + activeId). The
    // central ghost guards in the persist helpers are the real safety net
    // if a future edit reintroduces a call here.
    return id;
  },

  switchSession: (id) => {
    if (get().activeSessionId === id) return;
    if (!get().sessions.some((s) => s.id === id)) return;
    const prefs = getSessionPreferences(id);
    if (prefs.archivedAt) return;
    const fromId = get().activeSessionId;

    // Lazily seed the chat with persisted messages the first time we open
    // this session. Subsequent switches reuse the cached Chat instance.
    const flip = () => {
      // Stale-request guard: if the user switched again (or the target was
      // deleted) before `loadMessages` resolved, don't yank activeSessionId
      // back to this session.
      if (get().activeSessionId !== fromId) return;
      if (!get().sessions.some((s) => s.id === id)) return;
      set({
        activeSessionId: id,
        agentMeta: getSessionAgentMeta(id),
        autoApprove: getSessionAutoApprove(id),
        selectedModelId: prefs.modelId ?? get().selectedModelId,
      });
      if (activeProjectRuntime) setProjectActiveSession(activeProjectRuntime.id, id);
      persistActiveSessionId(id);
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

  archiveSession: (id) => {
    // Archiving is a VIEW operation, not Stop. An active run continues in
    // the background and can still surface approval/completion notifications.
    setSessionPreferences(id, { archivedAt: Date.now() });
    if (get().activeSessionId === id) {
      const owner = projectIdForSession(id);
      const next = get().sessions
        .filter((s) => s.id !== id && projectIdForSession(s.id) === owner && !getSessionPreferences(s.id).archivedAt)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (next) get().switchSession(next.id);
      else get().newSession();
    }
  },

  restoreSession: (id) => {
    setSessionPreferences(id, { archivedAt: undefined });
    get().switchSession(id);
  },

  deleteSession: (id) => {
    removeSessionPreferences(id);
    sessionAutoApprove.delete(id);
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
      workspaceEnv: activeProjectRuntime?.env,
      };
      set({ sessions: [fresh], activeSessionId: fresh.id });
      // Record the DELETION on disk, but keep the replacement placeholder
      // memory-only (same contract as newSession).
      persistActiveSessionsList([]);
      persistActiveSessionId(null);
      return;
    }

    const wasActive = get().activeSessionId === id;
    const nextActive: string | null = wasActive
      ? remaining[0].id
      : get().activeSessionId;
    set({ sessions: remaining, activeSessionId: nextActive });
    persistActiveSessionsList(remaining);
    if (wasActive && nextActive) {
      const next = nextActive;
      persistActiveSessionId(next);
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
    persistActiveSessionsList(next);
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
    appendSessionEvent(id, {
      kind: "summarize",
      trigger: "manual",
      fromCount: chat.messages.length,
      toCount: next.length,
    });
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
    // Scope-ownership record. `saveMessages` writes into the CURRENTLY SCOPED
    // sessions file, which belongs to exactly one project. On a project
    // switch the outgoing Chat can still emit a (possibly empty/transient)
    // persist while being torn down — that write must land in the session's
    // OWN project file, never the new project's. Record the session's root
    // (the write path re-routes on scope mismatch — see saveMessagesRerouted).
    // `sessions` is intentionally GLOBAL across projects, so a membership
    // check would be useless; the session's own workspaceRoot is authoritative.
    const sessionMeta = get().sessions.find((s) => s.id === id);
    noteSessionRoot(id, sessionMeta?.workspaceRoot ?? null);
    // Stamp createdAt on NEW messages (metadata) so the transcript can render
    // day separators + hover times. Mutates the LIVE array's message objects —
    // deliberate: the same objects render in AiChat and persist via the
    // debounced save below. Legacy messages (pre-feature) are marked
    // `legacyNoTs` at hydration (loadMessages) and skipped — no fake times.
    for (const m of messages) {
      const mMeta = m.metadata as { createdAt?: number; legacyNoTs?: boolean } | undefined;
      if (mMeta?.createdAt || mMeta?.legacyNoTs) continue;
      m.metadata = { ...(m.metadata as object | undefined), createdAt: Date.now() };
    }
    // Debounce the message-blob write so streaming doesn't pound the store.
    const existing = pendingPersist.get(id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const entry = pendingPersist.get(id);
      if (!entry) return;
      pendingPersist.delete(id);
      saveMessagesRerouted(id, entry.latest);
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
    // Was this session a memory-only placeholder until this very persist?
    const wasGhost = isUntitled && (meta.lastMessageCount ?? 0) === 0;
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
    persistActiveSessionsList(next);
    // First real content on a memory-only placeholder: promote it to disk.
    // Until this write the session (list entry + activeId) was deliberately
    // never persisted, so THIS is what makes it survive a restart.
    if (wasGhost && count > 0) persistActiveSessionId(id);
  },
  injectMessage: async (id, text) => {
    // Hydrate persisted history BEFORE constructing a chat, so evicting a
    // session from the LRU and receiving a watch/steering message while it's
    // inactive can't instantiate an empty Chat and clobber the real history.
    const hasChat = chats.has(id);
    if (!hasChat && !seedMessages.has(id)) {
      const session = get().sessions.find((s) => s.id === id);
      const root = session?.workspaceRoot;
      const m = root ? await loadMessagesForRoot(root, id, session?.workspaceEnv ?? { kind: "local" }) : await loadMessages(id);
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
    // Mid-conversation fires are PASSIVE: if the agent is mid-run
    // (streaming/submitted) or paused on an approval card, the injected fire
    // lands in history but does NOT start (or queue) its own turn — the
    // in-flight run already snapshotted its messages (invisible to it), and
    // a self-initiated wake right after the run settles used to hijack the
    // user's conversation with an unsolicited narrated response ("it fires in
    // the middle of my conversation and messes everything up"). Instead the
    // fire rides along: every LATER request — the user's next message, a
    // continuation, anything — carries the full history, fire included, and
    // the model reacts within the user's own thread.
    //
    // Idle fires (agent ready, nothing in flight) keep the proactive wake —
    // that's the monitoring contract: watch the deploy while I'm away, act
    // when it lands.
    if (
      chat.status === "streaming" ||
      chat.status === "submitted" ||
      hasPendingApprovals(chat)
    ) {
      // Passive ride-along: no wake, no queue. The message is already in
      // chat.messages (appended above) and will be in the next request's
      // history snapshot.
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
        noteSessionRoot(newId, get().live?.getWorkspaceRoot?.() ?? null);
      } else {
        // Chat not resident (shouldn't happen for the displayed session) —
        // fall back to the persisted snapshot.
        const stored = await forkSessionFromStore(activeId, atMessageIndex);
        messages = stored.messages;
        newId = stored.newId;
      }
      if (messages.length === 0) throw new Error("source session not found");
      const originTitle =
        get().sessions.find((s) => s.id === activeId)?.title ?? "chat";
      const meta: SessionMeta = {
        id: newId,
        title: `Fork · ${originTitle}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        parentId: activeId,
        forkMessageIndex: atMessageIndex,
        workspaceRoot: get().live?.getWorkspaceRoot?.(),
      workspaceEnv: activeProjectRuntime?.env,
      };
      const next = [meta, ...get().sessions];
      set({ sessions: next, activeSessionId: newId, agentMeta: IDLE_META });
      seedMessages.set(newId, messages);
      persistActiveSessionsList(next);
      persistActiveSessionId(newId);
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
      noteSessionRoot(newId, get().live?.getWorkspaceRoot?.() ?? null);
      const meta: SessionMeta = {
        id: newId,
        title: "Shadow mode",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        parentId: activeId,
        forkMessageIndex: Math.max(0, messages.length - 1),
        workspaceRoot: root,
        workspaceEnv: activeProjectRuntime?.env,
      };
      const next = [meta, ...get().sessions];
      set({ sessions: next, activeSessionId: newId, agentMeta: IDLE_META });
      seedMessages.set(newId, messages);
      persistActiveSessionsList(next);
      persistActiveSessionId(newId);
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
      // Merge target: the session being merged INTO. Its root governs
      // which file the merged history lands in.
      const targetMeta = get().sessions.find((s) => s.id === targetId);
      await saveMessagesForRoot(
        targetMeta?.workspaceRoot ?? null,
        targetId,
        merged,
      );

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
      persistActiveSessionsList(next);
      persistActiveSessionId(targetId);

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

/** Session meta by id from the GLOBAL in-memory list (all projects). Exported
 *  for saveActiveId's scope routing in sessions.ts — a file's `activeId` must
 *  reference a session that lives in that file. */
export function getSessionsMetaById(id: string): SessionMeta | undefined {
  return useChatStore.getState().sessions.find((s) => s.id === id);
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

/**
 * True when a message's parts hold an approval that is pending OR just
 * responded — i.e. the SDK is about to (or may) fire a continuation request
 * for this turn. Used by the chat UI to suppress the "Ended after tool
 * call" + Continue banner: responding to an approval moves the part from
 * `approval-requested` to `approval-responded`, and the follow-up request
 * then goes through transport prep (project rules, memory, summarization,
 * MCP gathering) + network latency — a multi-second window in which the
 * status is `ready` and the run LOOKS finished. The banner flashes, then
 * "the agent continues on its own". A denied approval also continues (the
 * model sees the denial), so ANY responded approval counts as pending
 * continuation, not just approved ones.
 */
export function approvalContinuationPending(
  parts: ReadonlyArray<unknown>,
): boolean {
  return parts.some((p) => {
    const st = (p as { state?: string }).state ?? "";
    return st === "approval-requested" || st === "approval-responded";
  });
}

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
      if ((p as { state?: string }).state !== "approval-requested") return true;
      // Absence of a decision is not permission: latch the reaped approval
      // id as denied so a deferred auto-approve callback already in flight
      // for this exact call cannot resurrect it.
      const ap = (p as { approval?: { id?: string } }).approval;
      if (ap?.id) noteApprovalDenied(ap.id);
      return false;
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
  // Absence of permission is denial: latch every still-pending approval id
  // before stripping, so a deferred auto-approve callback already in flight
  // for this exact call cannot resurrect it. The stale reaper
  // (releaseStaleApprovalsOnly) latches the same way - stop must not be the
  // one asymmetry.
  for (const m of chat.messages) {
    for (const p of m.parts as Array<Record<string, unknown>>) {
      if ((p as { state?: string }).state !== "approval-requested") continue;
      const ap = p.approval as { id?: string } | undefined;
      if (ap?.id) noteApprovalDenied(ap.id);
    }
  }
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
  cancelAllShellSessions(sessionId);
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
  const owner = approvalResponders.size > 0 ? findApprovalOwner(approvalId) : null;
  if (owner) {
    const fn = approvalResponders.get(owner);
    if (fn) {
      fn(approvalId, approved);
      return;
    }
  }
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
    // the tool name + input. Resolve the OWNING session first (an approval
    // can belong to a background project's chat) — the old active-session
    // read attributed decisions to the wrong transcript's audit trail.
    const root =
      state.live?.getWorkspaceRoot?.() ??
      usePreferencesStore.getState().lastWorkspaceCwd ??
      "";
    const owner = findApprovalOwner(approvalId);
    const chat = chats.get(owner ?? state.activeSessionId ?? "");
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
  cancelAllShellSessions(sessionId);
  // Abort our own controller unconditionally — the Stop button must work even
  // when the model is stuck in a reasoning/tool loop where `Chat.stop()` is a
  // silent no-op (SDK status is neither streaming nor submitted).
  abortRunController(sessionId);
  const chat = chats.get(sessionId);
  if (!chat) return;
  void chat.stop().finally(() => {
    releasePendingApprovals(chat);
    // Meta MUST settle to idle here, not keep its last busy value. Group
    // delivery gates on this mirrored status; a stale "streaming" after a
    // stop pinned every later cross-project message in the send queue
    // forever (flush only fires on an idle transition that never came).
    patchSessionAgentMeta(sessionId, {
      status: "idle",
      approvalsPending: 0,
      step: null,
    });
  });
}
