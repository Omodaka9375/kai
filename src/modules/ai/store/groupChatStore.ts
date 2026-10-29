import { LazyStore } from "@tauri-apps/plugin-store";
import { agentBus } from "../lib/eventBus";
import { notifyBackgroundAgent } from "../lib/backgroundNotifications";
import { getProjectActiveSession, getSessionAgentMeta, setChatPinner, useChatStore } from "./chatStore";

/**
 * Cross-project group chats — a coordination layer OVER existing per-project
 * agent sessions, not a new multi-root agent. Each participant keeps its own
 * model, tools, approvals, and sandbox; this store routes messages between
 * their sessions and mirrors their replies into a group transcript.
 *
 * Membership is HUMAN-GRANTED ONLY: agents can never invite projects. An
 * agent may only receive a delegate-coordinator role that a user assigned.
 *
 * Persistence: groups belong to no single project, so they live in their own
 * app-level store file (kai-groups.json), same pattern as kai-open-projects.
 *
 * Phase 3 hardening:
 *  - LRU pinning: live-group sessions are registered with chatStore's
 *    setChatPinner so a mid-round participant is never evicted mid-delegation.
 *  - session:delete re-resolution: a deleted participant/coordinator session
 *    re-resolves to the project's current active session when one exists, and
 *    otherwise drops from the group (with a system note in the transcript).
 *  - Machinery teardown: endGroupChat / reclaimCoordination /
 *    removeParticipant clear that session's queues, coalesce timers, and
 *    relay depth — no dangling wake-ups after the group state changed.
 */

export type GroupParticipant = {
  projectId: string;
  sessionId: string;
  root: string;
  name: string;
  joinedAt: number;
};

export type GroupMessage = {
  id: string;
  /** Who authored it: the human coordinator, a participating agent, or the
   *  group machinery itself (relay-cap notes). */
  from: "user" | "agent" | "system";
  /** Participant the message is attributed to (agent messages) / sent to. */
  projectId: string;
  sessionId: string;
  text: string;
  at: number;
};

export type GroupChat = {
  id: string;
  name: string;
  /** Human coordinator by default; can be delegated to a participant's agent. */
  coordinator: { kind: "user" } | { kind: "agent"; projectId: string; sessionId: string };
  participants: GroupParticipant[];
  messages: GroupMessage[];
  createdAt: number;
  endedAt: number | null;
};

/** Message queued for a participant whose agent is busy; flushed on idle. */
type QueuedMessage = {
  groupId: string;
  sessionId: string;
  text: string;
  at: number;
};

/**
 * Delegation ledger — which session is the group's AGENT coordinator and how
 * deep the reply relay has traveled. Phase 2's loop guard: each hop (a relayed
 * reply that itself contains a send_to_project) increments the origin's hop
 * count; past GROUP_RELAY_MAX_HOPS the bridge refuses to relay further and
 * surfaces the loop to the user instead. Data only — the bridge enforces.
 */
const GROUP_RELAY_MAX_HOPS = 24;
/** Coordinator session -> relay depth for the CURRENT outstanding round. */
const relayDepth = new Map<string, number>();

/**
 * Reply-coalescing buffer: participant replies awaiting delivery to the
 * coordinator. When the coordinator messages N participants, the bridge
 * buffers each reply; the wake fires ONCE — when every expected participant
 * has answered or GROUP_COALESCE_TIMEOUT_MS passes (a slow participant must
 * not hold the coordinator's turn hostage). Keyed by coordinator sessionId.
 */
const GROUP_COALESCE_TIMEOUT_MS = 90_000;
type PendingReply = { projectId: string; name: string; text: string; at: number };
type CoalesceBuffer = { expected: Set<string>; replies: PendingReply[] };
const pendingReplies = new Map<string, CoalesceBuffer>();
const coalesceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Flush whatever the buffer holds as one merged wake (timeout or complete). */
function flushCoalesced(coordinatorSessionId: string): void {
  const buf = pendingReplies.get(coordinatorSessionId);
  const timer = coalesceTimers.get(coordinatorSessionId);
  if (timer) {
    clearTimeout(timer);
    coalesceTimers.delete(coordinatorSessionId);
  }
  if (!buf || buf.replies.length === 0) {
    pendingReplies.delete(coordinatorSessionId);
    return;
  }
  const merged = buf.replies
    .map((r) => `[group] ${r.name} replied:\n${r.text}`)
    .join("\n\n---\n\n");
  const missing = [...buf.expected].filter(
    (e) => !buf.replies.some((r) => r.projectId === e),
  );
  pendingReplies.delete(coordinatorSessionId);
  relayDepth.set(coordinatorSessionId, (relayDepth.get(coordinatorSessionId) ?? 0) + 1);
  const suffix = missing.length
    ? `\n\n[group] (no reply yet from: ${missing.join(", ")} — ask again if needed)`
    : "";
  void useChatStore.getState().injectMessage(coordinatorSessionId, merged + suffix);
}

export function isAgentCoordinator(sessionId: string): boolean {
  for (const g of groups.values()) {
    if (g.endedAt !== null) continue;
    if (g.coordinator.kind === "agent" && g.coordinator.sessionId === sessionId) return true;
  }
  return false;
}

export function coordinatorGroupForSession(sessionId: string): GroupChat | null {
  for (const g of groups.values()) {
    if (g.endedAt !== null) continue;
    if (g.coordinator.kind === "agent" && g.coordinator.sessionId === sessionId) return g;
  }
  return null;
}

const store = new LazyStore("kai-groups.json", { defaults: {}, autoSave: 200 });

let groups = new Map<string, GroupChat>();
const listeners = new Set<() => void>();
const sendQueues = new Map<string, QueuedMessage[]>(); // sessionId -> pending
/** sessionId -> groupId, so the bridge can mirror replies without scanning. */
const sessionGroups = new Map<string, string>();
/** Sessions that received a group delivery and have not yet replied. Only
 *  these mirror into the transcript/relay — a reply is mirrored when it was
 *  PROVOKED by group activity, never because the user happened to chat with
 *  the same session in its own project (background-chatter leak gate). */
const awaitingReply = new Map<string, string>();
let hydrated = false;
let hydratePromise: Promise<void> | null = null;
/** Monotonic store version — useSyncExternalStore snapshot for non-Zustand consumers (rail arcs). */
let storeVersion = 0;

function notify(): void {
  storeVersion++;
  for (const l of listeners) l();
}

export function getGroupStoreVersion(): number {
  return storeVersion;
}

export function subscribeGroupChats(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getGroups(): GroupChat[] {
  return [...groups.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function getGroup(id: string): GroupChat | null {
  return groups.get(id) ?? null;
}

export function getGroupForSession(sessionId: string): GroupChat | null {
  const groupId = sessionGroups.get(sessionId);
  return groupId ? (groups.get(groupId) ?? null) : null;
}

/** Groups a project participates in (for rail arcs + panel entry). */
export function groupsForProject(projectId: string): GroupChat[] {
  const out: GroupChat[] = [];
  for (const g of groups.values()) {
    if (g.endedAt !== null) continue;
    if (g.participants.some((p) => p.projectId === projectId)) out.push(g);
  }
  return out;
}

/** Groups where BOTH projects are participants — the arc edges. */
export function groupArcsBetween(projectId: string): Array<{ groupId: string; otherId: string }> {
  const out: Array<{ groupId: string; otherId: string }> = [];
  for (const g of groupsForProject(projectId)) {
    for (const p of g.participants) {
      if (p.projectId !== projectId) out.push({ groupId: g.id, otherId: p.projectId });
    }
  }
  return out;
}

export async function hydrateGroups(): Promise<void> {
  if (hydrated) return;
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    const saved = await store
      .get<GroupChat[]>("groups")
      .catch(() => null);
    if (saved) {
      for (const g of saved) {
        groups.set(g.id, g);
        for (const p of g.participants) {
          if (g.endedAt === null) sessionGroups.set(p.sessionId, g.id);
        }
      }
    }
    hydrated = true;
    notify();
  })();
  return hydratePromise;
}

async function persist(): Promise<void> {
  // Strip live session-resolution fields; keep the group shape stable.
  await store.set("groups", [...groups.values()]);
  await store.save();
}

function reindex(group: GroupChat): void {
  for (const p of group.participants) {
    if (group.endedAt === null) sessionGroups.set(p.sessionId, group.id);
    else sessionGroups.delete(p.sessionId);
  }
}

let nextGroupSeq = 1;
function newGroupId(): string {
  return `grp-${Date.now().toString(36)}-${nextGroupSeq++}`;
}

function newMessageId(): string {
  return `gm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a group chat from the inviting (foreground) project's active session
 * plus the picked project participants. Human-only entry point — never call
 * this from agent tool code.
 */
export async function createGroupChat(
  inviter: { projectId: string; sessionId: string; root: string; name: string },
  invitees: Array<{ projectId: string; root: string; name: string }>,
  groupName?: string,
): Promise<GroupChat | null> {
  if (invitees.length === 0) return null;
  // The inviter's sessionId is resolved HERE (not trusted from the caller):
  // the panel passes a placeholder; the active session at creation time is
  // the one that owns the group.
  const inviterSession = inviter.sessionId || getProjectActiveSession(inviter.projectId) || "";
  const group: GroupChat = {
    id: newGroupId(),
    name: groupName?.trim() || `${inviter.name} + ${invitees.length} more`,
    coordinator: { kind: "user" },
    participants: [
      { ...inviter, sessionId: inviterSession, joinedAt: Date.now() },
      ...invitees.map((i) => ({
        projectId: i.projectId,
        sessionId: getProjectActiveSession(i.projectId) ?? "",
        root: i.root,
        name: i.name,
        joinedAt: Date.now(),
      })),
    ],
    messages: [],
    createdAt: Date.now(),
    endedAt: null,
  };
  groups.set(group.id, group);
  reindex(group);
  await persist();
  notify();
  return group;
}

/** Append a message to the group transcript (user line or mirrored agent reply). */
export async function appendGroupMessage(
  groupId: string,
  msg: Omit<GroupMessage, "id" | "at">,
): Promise<GroupMessage | null> {
  const g = groups.get(groupId);
  if (!g || g.endedAt !== null) return null;
  const m: GroupMessage = { id: newMessageId(), at: Date.now(), ...msg };
  g.messages = [...g.messages, m];
  await persist();
  notify();
  return m;
}

/**
 * Send a coordinator message to one participant ("all" fans out). Busy
 * participants QUEUE; idle ones wake immediately. Returns per-recipient
 * delivery state so the UI can show queued chips.
 */
export async function sendGroupMessage(
  groupId: string,
  text: string,
  targetProjectId?: string,
): Promise<Array<{ projectId: string; sessionId: string; queued: boolean }>> {
  const g = groups.get(groupId);
  if (!g || g.endedAt !== null) return [];
  // USER intervention is the relay-cap circuit breaker: any human message
  // into the group resets the agent-driven hop depth of its coordinator.
  if (g.coordinator.kind === "agent") {
    relayDepth.delete(g.coordinator.sessionId);
  }
  const targets = g.participants.filter(
    (p) => p.projectId !== (g.coordinator.kind === "agent" ? g.coordinator.projectId : "") ||
      p.projectId === targetProjectId,
  );
  const picked = targetProjectId
    ? targets.filter((p) => p.projectId === targetProjectId)
    : targets;
  const out: Array<{ projectId: string; sessionId: string; queued: boolean }> = [];
  for (const p of picked) {
    if (!p.sessionId) continue;
    const queued = deliverToParticipant(g, p, text);
    out.push({ projectId: p.projectId, sessionId: p.sessionId, queued });
  }
  await appendGroupMessage(groupId, {
    from: "user",
    projectId: targetProjectId ?? "all",
    sessionId: g.coordinator.kind === "user" ? "" : g.coordinator.sessionId,
    text,
  });
  return out;
}

/** Fan-out copy inside sendGroupMessage — one participant. */
function deliverToParticipant(
  g: GroupChat,
  p: GroupParticipant,
  text: string,
): boolean {
  awaitingReply.set(p.sessionId, g.id);
  const prefixed = `[${g.name} · cross-project group] ${text}`;
  const meta = getSessionAgentMeta(p.sessionId);
  const busy =
    meta.status === "streaming" ||
    meta.status === "awaiting-approval" ||
    meta.status === "thinking";
  if (busy) {
    const q = sendQueues.get(p.sessionId) ?? [];
    q.push({ groupId: g.id, sessionId: p.sessionId, text: prefixed, at: Date.now() });
    sendQueues.set(p.sessionId, q);
    notify();
    // Best-effort ping: the message sits queued until the agent goes idle —
    // without this the sender wonders why nothing happened. Never throws.
    void notifyBackgroundAgent(p.name, `Group message queued - agent is busy in ${p.name}`);
    return true;
  }
  void useChatStore.getState().injectMessage(p.sessionId, prefixed);
  return false;
}

/**
 * Flush queued group messages when a participant goes idle. Called from the
 * store's status pipeline (patchSessionAgentMeta via observeGroupActivity).
 */
export function flushQueuedForSession(sessionId: string): void {
  const q = sendQueues.get(sessionId);
  if (!q || q.length === 0) return;
  sendQueues.delete(sessionId);
  notify();
  const merged = q.map((m) => m.text).join("\n\n");
  void useChatStore.getState().injectMessage(sessionId, merged);
}

/** The bridge asks this before mirroring a settled reply: true only when the
 *  session received a group delivery it has not yet answered. Clears the
 *  flag (one delivery = one mirrored reply) — the background-chatter gate. */
export function takeReplyProvision(sessionId: string): string | null {
  const groupId = awaitingReply.get(sessionId);
  if (!groupId) return null;
  awaitingReply.delete(sessionId);
  return groupId;
}

/** Session became idle — called by the status observer. */
export function noteSessionIdle(sessionId: string): void {
  flushQueuedForSession(sessionId);
}

/** Session went busy — nothing to do (queues only flush on idle). */
export function noteSessionBusy(_sessionId: string): void {
  // Intentionally empty: symmetric API for the observer.
}

/**
 * End the group chat. Arcs disappear, no new messages flow, but NOTHING is
 * torn down — each participant agent keeps running exactly as before (their
 * sessions already contain the group turns inline). Ended groups are kept
 * for resume.
 */
export async function endGroupChat(groupId: string): Promise<void> {
  const g = groups.get(groupId);
  if (!g || g.endedAt !== null) return;
  g.endedAt = Date.now();
  for (const p of g.participants) {
    teardownSessionMachinery(p.sessionId);
    sessionGroups.delete(p.sessionId);
  }
  if (g.coordinator.kind === "agent") teardownSessionMachinery(g.coordinator.sessionId);
  await persist();
  notify();
}

/** Resume an ended group. */
export async function resumeGroupChat(groupId: string): Promise<void> {
  const g = groups.get(groupId);
  // Only ENDED groups can resume — a live group is a no-op.
  if (!g || g.endedAt === null) return;
  g.endedAt = null;
  reindex(g);
  await persist();
  notify();
}

/** Drop a project that was closed in the shell (participant cleanup). */
export async function removeProjectFromGroups(projectId: string): Promise<void> {
  for (const g of groups.values()) {
    if (g.participants.some((p) => p.projectId === projectId)) {
      g.participants = g.participants.filter((p) => p.projectId !== projectId);
      if (g.participants.length <= 1) {
        // A one-participant group is not a group — end it.
        g.endedAt = g.endedAt ?? Date.now();
        for (const p of g.participants) sessionGroups.delete(p.sessionId);
      } else {
        reindex(g);
      }
    }
  }
  await persist();
  notify();
}

/**
 * Phase 2: hand the coordinator role to a participant's agent. HUMAN action
 * only (panel button) — an agent can never seize the role. The delegate's
 * next run receives a group preamble describing participants.
 */
export async function delegateCoordination(groupId: string, projectId: string): Promise<void> {
  const g = groups.get(groupId);
  if (!g || g.endedAt !== null) return;
  const p = g.participants.find((x) => x.projectId === projectId);
  if (!p) return;
  g.coordinator = { kind: "agent", projectId, sessionId: p.sessionId };
  await persist();
  notify();
}

/** Return coordination to the user. */
export async function reclaimCoordination(groupId: string): Promise<void> {
  const g = groups.get(groupId);
  if (!g || g.endedAt !== null) return;
  if (g.coordinator.kind === "agent") teardownSessionMachinery(g.coordinator.sessionId);
  g.coordinator = { kind: "user" };
  await persist();
  notify();
}

/** Group preamble injected as the delegation system note — describes the
 *  participant set and the send_to_project contract for the delegate. */
export function coordinatorPreamble(g: GroupChat): string {
  const others = g.participants
    .filter((p) => p.sessionId !== (g.coordinator.kind === "agent" ? g.coordinator.sessionId : ""))
    .map((p) => `${p.name} (${p.root})`);
  return [
    `[group: ${g.name}] You are now the COORDINATOR of a cross-project group chat.`,
    `You coordinate these projects' agents (each works only inside its own repo):`,
    others.map((s) => `  - ${s}`).join("\n"),
    `Rules:`,
    `- Use send_to_project(project, message) to delegate a task or ask a question. It is FIRE-AND-FORGET: the reply arrives as your NEXT user message — do not poll, do not wait, do not call anything to check.`,
    `- After send_to_project, state that you are waiting and END YOUR TURN. Never declare the overall task complete while a delegation is outstanding.`,
    `- project_status(project) tells you whether a participant's agent is busy before you send.`,
    `- Relayed replies may themselves contain work you should delegate onward — but keep total delegation hops minimal.`,
    `- End-to-end: when the multi-repo goal is met, summarize what each project did.`,
  ].join("\n");
}

/**
 * Engine behind the send_to_project tool: the coordinator AGENT sends to a
 * participant. Same queue-when-busy contract as the user path, plus:
 *  - records the delivery in the group transcript (from: "agent")
 *  - arms the coalescing buffer so the participant's reply is relayed back
 *  - enforces the relay hop cap (loop guard)
 * Returns a human-readable tool result string (no throw).
 */
export async function sendFromCoordinator(
  groupId: string,
  targetProjectId: string,
  message: string,
): Promise<string> {
  const g = groups.get(groupId);
  if (!g || g.endedAt !== null) return "group chat ended — message not delivered";
  if (g.coordinator.kind !== "agent") return "coordination was reclaimed by the user — not delivered";
  const coord = g.coordinator;
  const p = g.participants.find((x) => x.projectId === targetProjectId);
  if (!p) return `unknown project "${targetProjectId}" — participants: ${g.participants.map((x) => x.name).join(", ")}`;
  if (p.sessionId === coord.sessionId) return "refusing to send to yourself (the coordinator)";
  // Hop cap: count active delegations from this coordinator round.
  const depth = relayDepth.get(coord.sessionId) ?? 0;
  if (depth >= GROUP_RELAY_MAX_HOPS) {
    return `relay cap reached (${GROUP_RELAY_MAX_HOPS} hops) — the group is bouncing between projects. Summarize the current state to the user instead of delegating further.`;
  }
  const queued = deliverToParticipant(g, p, message);
  // Arm the coalescing buffer for this target (+ the safety timeout: a slow
  // participant must not hold the coordinator hostage forever).
  const buf = pendingReplies.get(coord.sessionId) ?? { expected: new Set<string>(), replies: [] };
  buf.expected.add(p.projectId);
  pendingReplies.set(coord.sessionId, buf);
  if (!coalesceTimers.has(coord.sessionId)) {
    coalesceTimers.set(
      coord.sessionId,
      setTimeout(() => flushCoalesced(coord.sessionId), GROUP_COALESCE_TIMEOUT_MS),
    );
  }
  await appendGroupMessage(groupId, {
    from: "agent",
    projectId: targetProjectId,
    sessionId: coord.sessionId,
    text: message,
  });
  return queued
    ? `Delivered (queued) to ${p.name} — its agent is busy; your message will wake it when idle. The reply arrives as your next message.`
    : `Delivered to ${p.name}. The reply arrives as your next message — do not wait or poll; end your turn.`;
}

/**
 * The bridge calls this when a PARTICIPANT session (not the coordinator)
 * settles to idle with a fresh assistant reply, IF that reply was produced
 * after the last delivery to it. Returns the coalesced wake text for the
 * coordinator, or null when still waiting for other participants / cap hit.
 */
export function noteParticipantReply(
  groupId: string,
  participantProjectId: string,
  replyText: string,
): string | null {
  const g = groups.get(groupId);
  if (!g || g.endedAt !== null) return null;
  if (g.coordinator.kind !== "agent") return null;
  const coord = g.coordinator;
  const buf = pendingReplies.get(coord.sessionId);
  if (!buf) return null;
  const name = g.participants.find((p) => p.projectId === participantProjectId)?.name ?? participantProjectId;
  buf.replies.push({ projectId: participantProjectId, name, text: replyText, at: Date.now() });
  const answered = new Set(buf.replies.map((r) => r.projectId));
  const allAnswered = [...buf.expected].every((e) => answered.has(e));
  if (!allAnswered) return null;
  // All expected participants answered - one merged wake via the shared
  // flush (clears the timeout, bumps relay depth, injects). Returning null
  // keeps the bridge from double-injecting.
  flushCoalesced(coord.sessionId);
  return null;
}

/** Outstanding delegations a coordinator is waiting on (for UI state). */
export function coordinatorPendingCount(sessionId: string): number {
  const buf = pendingReplies.get(sessionId);
  return buf ? buf.expected.size : 0;
}

/**
 * Coordinator's own run settled to idle. Does NOT reset relay depth: depth
 * counts agent-driven hops since the last USER action (see the ledger note
 * above); a coordinator round is not user intervention. The stale coalesce
 * buffer and its timer ARE cleared (that round is over).
 */
export function noteCoordinatorRoundDone(sessionId: string): void {
  pendingReplies.delete(sessionId);
  const timer = coalesceTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    coalesceTimers.delete(sessionId);
  }
}
export function __resetGroupChatsForTest(): void {
  groups = new Map();
  sendQueues.clear();
  sessionGroups.clear();
  relayDepth.clear();
  pendingReplies.clear();
  awaitingReply.clear();
  hydrated = false;
  hydratePromise = null;
  nextGroupSeq = 1;
  notify();
}
// ── Phase 3: lifecycle hardening ─────────────────────────────────────────
//
// Everything below exists because the earlier phases left machinery armed
// across state transitions: a queued message could wake a session after its
// group ENDED; a coalesce timer could fire into a reclaimed coordinator; a
// deleted session left the group pointing at a dead id; and a participant's
// chat could be LRU-evicted mid-round and rehydrated from a stale snapshot.

/** Clear ALL group machinery targeting one session — queues, coalesce
 *  timers, relay depth. Called on end/reclaim/remove/re-resolve so no
 *  dangling wake-up fires after the group state changed. */
function teardownSessionMachinery(sessionId: string): void {
  sendQueues.delete(sessionId);
  const timer = coalesceTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    coalesceTimers.delete(sessionId);
  }
  pendingReplies.delete(sessionId);
  relayDepth.delete(sessionId);
  awaitingReply.delete(sessionId);
}

/** Is this session live machinery of ANY active group? Used both by the
 *  chatStore LRU pinner (never evict a live participant/coordinator) and by
 *  the delete-re-resolver. */
function sessionIsGroupLive(sessionId: string): boolean {
  if (sessionGroups.has(sessionId)) return true;
  for (const g of groups.values()) {
    if (g.endedAt !== null) continue;
    if (g.coordinator.kind === "agent" && g.coordinator.sessionId === sessionId) return true;
  }
  return false;
}

// LRU pinner registration (inversion: chatStore cannot import this module).
// Pins the chat instances of live-group participant + coordinator sessions.
if (typeof setChatPinner === "function") setChatPinner(sessionIsGroupLive);

/** session:delete re-resolution. chatStore deletes sessions for many
 *  reasons (user deletes a chat, LRU-adjacent cleanup, project reset). When
 *  the deleted session belongs to a live group, re-point the participant at
 *  that project's CURRENT active session if one exists; otherwise remove
 *  the participant with a system note so the group stays coherent. */
if (typeof agentBus?.on === "function") agentBus.on("session:delete", ({ sessionId }) => {
  for (const g of [...groups.values()]) {
    if (g.endedAt !== null) continue;
    // Coordinator deleted?
    if (g.coordinator.kind === "agent" && g.coordinator.sessionId === sessionId) {
      const coordProject = g.coordinator.projectId;
      const candidate = getProjectActiveSession(coordProject);
      // A replacement is only valid when it is fresh AND not another
      // participant's session — re-pointing coordination at someone else's
      // member session would make that agent both coordinator and
      // participant of its own delegation target.
      const replacement =
        candidate && candidate !== sessionId &&
        !g.participants.some((x) => x.sessionId === candidate && x.projectId !== coordProject)
          ? candidate
          : null;
      teardownSessionMachinery(sessionId);
      if (replacement) {
        g.coordinator = { kind: "agent", projectId: coordProject, sessionId: replacement };
        void appendGroupMessage(g.id, {
          from: "system", projectId: "", sessionId: "",
          text: "Coordinator session was deleted — delegation re-pointed to the project's current session.",
        });
      } else {
        g.coordinator = { kind: "user" };
        void appendGroupMessage(g.id, {
          from: "system", projectId: "", sessionId: "",
          text: "Coordinator session was deleted — coordination returned to you.",
        });
      }
      continue;
    }
    // Participant deleted?
    const p = g.participants.find((x) => x.sessionId === sessionId);
    if (!p) continue;
    const replacement = getProjectActiveSession(p.projectId);
    teardownSessionMachinery(sessionId);
    if (replacement && replacement !== sessionId) {
      p.sessionId = replacement;
      sessionGroups.delete(sessionId);
      sessionGroups.set(replacement, g.id);
      void appendGroupMessage(g.id, {
        from: "system", projectId: p.projectId, sessionId: replacement,
        text: `${p.name}'s session was deleted — the project's current session took over.`,
      });
    } else {
      g.participants = g.participants.filter((x) => x.sessionId !== sessionId);
      sessionGroups.delete(sessionId);
      if (g.participants.length <= 1) {
        g.endedAt = g.endedAt ?? Date.now();
        for (const rest of g.participants) sessionGroups.delete(rest.sessionId);
      }
      void appendGroupMessage(g.id, {
        from: "system", projectId: p.projectId, sessionId: "",
        text: `${p.name} left the group (its session was deleted).`,
      });
    }
  }
  void persist();
  notify();
});

/** Phase 3: invite MORE projects into an existing live group. Human-only
 *  (panel) — the same trust boundary as createGroupChat. Idempotent per
 *  project; the invitee joins at its project's current active session. */
export async function addParticipants(
  groupId: string,
  invitees: Array<{ projectId: string; root: string; name: string }>,
): Promise<void> {
  const g = groups.get(groupId);
  if (!g || g.endedAt !== null || invitees.length === 0) return;
  const added: string[] = [];
  for (const i of invitees) {
    if (g.participants.some((p) => p.projectId === i.projectId)) continue;
    g.participants = [
      ...g.participants,
      {
        projectId: i.projectId,
        sessionId: getProjectActiveSession(i.projectId) ?? "",
        root: i.root,
        name: i.name,
        joinedAt: Date.now(),
      },
    ];
    sessionGroups.set(getProjectActiveSession(i.projectId) ?? "", groupId);
    added.push(i.name);
  }
  if (added.length) {
    void appendGroupMessage(g.id, {
      from: "system", projectId: "", sessionId: "",
      text: `${added.join(", ")} joined the group.`,
    });
  }
  await persist();
  notify();
}

/** Phase 3: remove one project from a live group (human-only). Clears that
 *  participant's machinery; a group reduced to one participant ends. */
export async function removeParticipant(
  groupId: string,
  projectId: string,
): Promise<void> {
  const g = groups.get(groupId);
  if (!g || g.endedAt !== null) return;
  const p = g.participants.find((x) => x.projectId === projectId);
  if (!p) return;
  teardownSessionMachinery(p.sessionId);
  if (g.coordinator.kind === "agent" && g.coordinator.projectId === projectId) {
    g.coordinator = { kind: "user" };
  }
  g.participants = g.participants.filter((x) => x.projectId !== projectId);
  sessionGroups.delete(p.sessionId);
  if (g.participants.length <= 1) {
    g.endedAt = g.endedAt ?? Date.now();
    for (const rest of g.participants) sessionGroups.delete(rest.sessionId);
  }
  void appendGroupMessage(g.id, {
    from: "system", projectId, sessionId: "",
    text: `${p.name} was removed from the group.`,
  });
  await persist();
  notify();
}
