/**
 * Project monitoring bridge ("send project to assistant") - Telegram as a
 * remote-control surface for projects you own on the desktop.
 *
 * TWO SEPARATE CONCERNS, deliberately kept apart:
 *
 *  1. The assistant's OWN toolset stays fenced to ~/.kai/assistant
 *     (makeAssistantToolContext in index.ts). Nothing here widens it - no
 *     project file ever reaches the assistant persona.
 *
 *  2. This module routes the OWNER'S messages into a PROJECT's agent
 *     session via chatStore.injectMessage - the same primitive watches and
 *     cross-project groups use. The project agent keeps its own sandbox,
 *     approvals, and model config exactly as if the user typed at the desk.
 *     Telegram is a transport, not a capability.
 *
 * SECURITY:
 *  - The Rust owner gate runs first (non-owner chats are dropped before any
 *    JS handler sees the event) - /tell inherits it. Only the bound owner
 *    can reach projects.
 *  - Every routed message + every mirrored reply is audited
 *    (auditAppend, kind "assistant.exec") so a transcript exists of what a
 *    Telegram-originated prompt drove.
 *  - Reply mirroring uses the group-chat causality contract: a reply is
 *    mirrored only when it was PROVOKED by a /tell delivery (delivery
 *    boundary snapshot + one-shot provision), never background chatter.
 *
 * BUSY SEMANTICS: injectMessage already gives us the whole contract for
 * free - an idle session wakes immediately; a busy run lets the injected
 * message ride the in-flight history (passive), so mid-run /tells steer
 * rather than clobber, exactly like steering from the composer.
 */

import { getTelegramToken, loadAssistantPrefs, saveAssistantPrefs, telegramNative } from "./prefs";
import { auditAppend, AUDIT_KINDS } from "@/modules/ai/lib/audit";
import {
  getSessionAgentMeta,
  getOrCreateChat,
  subscribeSessionAgentMeta,
  useChatStore,
} from "@/modules/ai/store/chatStore";

// ── Bindings ────────────────────────────────────────────────────────────

export type BoundProject = { root: string; name: string; sessionId: string | null };

export async function listBoundProjects(): Promise<Record<string, BoundProject>> {
  const prefs = await loadAssistantPrefs();
  return prefs.boundProjects;
}

export async function bindProjectForTelegram(projectId: string): Promise<boolean> {
  // ChatStore is the source of truth for what a project IS; the assistant
  // module must not import it statically (settings-window weight), so the
  // DESKTOP caller passes identity in. This variant is for tests/internal.
  const root = useChatStore.getState().live.getWorkspaceRoot();
  if (!root) return false;
  const prefs = await loadAssistantPrefs();
  const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
  const sessionId = useChatStore.getState().activeSessionId;
  prefs.boundProjects = {
    ...prefs.boundProjects,
    [projectId]: { root, name, sessionId },
  };
  await saveAssistantPrefs(prefs);
  auditAppend(AUDIT_KINDS.sandboxChange, "telegram-bind", `bound ${name} (${projectId})`, root);
  return true;
}

/** Desktop-side bind with explicit identity (avoids a chatStore import in
 *  the UI layer): call from the session menu of the ACTIVE project. */
export async function bindProjectForTelegramWith(
  projectId: string,
  root: string,
  name: string,
  sessionId: string | null,
): Promise<void> {
  const prefs = await loadAssistantPrefs();
  prefs.boundProjects = { ...prefs.boundProjects, [projectId]: { root, name, sessionId } };
  await saveAssistantPrefs(prefs);
  auditAppend(AUDIT_KINDS.sandboxChange, "telegram-bind", `bound ${name} (${projectId})`, root);
}

export async function unbindProjectFromTelegram(projectId: string): Promise<void> {
  const prefs = await loadAssistantPrefs();
  if (!prefs.boundProjects[projectId]) return;
  const { [projectId]: removed, ...rest } = prefs.boundProjects;
  void removed;
  prefs.boundProjects = rest;
  await saveAssistantPrefs(prefs);
  auditAppend(AUDIT_KINDS.sandboxChange, "telegram-unbind", `unbound ${projectId}`, "");
}

export function isProjectBound(projectId: string, prefs: { boundProjects: Record<string, BoundProject> }): boolean {
  return Object.prototype.hasOwnProperty.call(prefs.boundProjects, projectId);
}

// ── Session resolution (group-store pattern) ─────────────────────────────

/** Resolve the session a /tell should land in: the bound session if it still
 *  exists, else the project's current active session, else the bound id as
 *  a last resort (injectMessage rehydrates persisted history into a fresh
 *  Chat). Re-binds the resolved id so the binding follows the live project. */
async function resolveBoundSession(
  projectId: string,
  binding: BoundProject,
): Promise<string | null> {
  const state = useChatStore.getState();
  const sessions = state.sessions;
  const bound = binding.sessionId;
  if (bound && sessions.some((s) => s.id === bound)) return bound;
  // Re-resolve: find the session meta whose workspaceRoot matches the bound
  // project root (forward-slash normalized compare, same identity rule as
  // projectIdFor).
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const candidate = sessions.find(
    (s) => s.workspaceRoot && norm(s.workspaceRoot) === norm(binding.root),
  );
  if (candidate) {
    // Persist the re-resolution.
    const prefs = await loadAssistantPrefs();
    if (prefs.boundProjects[projectId]?.sessionId !== candidate.id) {
      prefs.boundProjects = {
        ...prefs.boundProjects,
        [projectId]: { ...binding, sessionId: candidate.id },
      };
      await saveAssistantPrefs(prefs);
    }
    return candidate.id;
  }
  return bound;
}

// ── /projects status listing ────────────────────────────────────────────

export async function formatProjectsStatus(): Promise<string> {
  const bound = await listBoundProjects();
  const entries = Object.entries(bound);
  if (entries.length === 0) {
    return [
      "No projects monitored.",
      "Bind one from its session menu on the desktop (Monitor via Telegram).",
    ].join("\n");
  }
  const lines = entries.map(([id, b]) => {
    let status = "idle";
    let step = "";
    const sid = b.sessionId;
    if (sid) {
      const meta = getSessionAgentMeta(sid);
      status =
        meta.status === "streaming" || meta.status === "thinking"
          ? "working"
          : meta.status === "awaiting-approval"
            ? "needs approval (desktop)"
            : meta.status === "error"
              ? "error"
              : "idle";
      step = meta.step ? ` - ${meta.step}` : "";
    }
    return `- ${b.name} (${id}): ${status}${step}`;
  });
  return [
    `Monitored projects (${entries.length}):`,
    ...lines,
    "",
    "/tell <name|id> <message> - prompt a project's agent from here.",
  ].join("\n");
}

// ── /tell routing + reply mirroring ──────────────────────────────────────

/** Mirrored-reply provision: projectId -> { boundaryId, provision } for the
 *  NEXT assistant reply of that session. One delivery = one mirrored reply
 *  (the group-chat contract); a second /tell overwrites the pending wake. */
type MirrorProvision = {
  chatId: number;
  boundaryId: string | null;
};
const mirrorProvisions = new Map<string, MirrorProvision>();

/** Find a bound project by user text (case-insensitive name or exact id). */
async function findBoundProject(
  text: string,
): Promise<{ id: string; binding: BoundProject } | null> {
  const bound = await listBoundProjects();
  const needle = text.trim().toLowerCase();
  for (const [id, binding] of Object.entries(bound)) {
    if (id.toLowerCase() === needle || binding.name.toLowerCase() === needle) {
      return { id, binding };
    }
  }
  // Prefix match as a convenience ("kai" matches "KAI-terminal").
  for (const [id, binding] of Object.entries(bound)) {
    if (binding.name.toLowerCase().startsWith(needle)) {
      return { id, binding };
    }
  }
  return null;
}

/** All bound projects, for routing plain text (the "current" one is the
 *  single- binding convenience: with exactly one project bound, plain text
 *  routes to it; /tell names the target when several are bound). */
export async function soleBoundProject(): Promise<{ id: string; binding: BoundProject } | null> {
  const bound = await listBoundProjects();
  const entries = Object.entries(bound);
  return entries.length === 1 ? { id: entries[0]![0], binding: entries[0]![1] } : null;
}

/** Route an owner message into a bound project's agent session.
 *  `allowSoleFallback` = true when the routing is implicit (plain text /
 *  voice to the single bound project); an EXPLICIT /tell target that
 *  doesn't match should error, not silently hit the only binding.
 *  Returns a human-readable outcome for the Telegram reply. */
export async function tellProject(
  targetText: string,
  message: string,
  chatId: number,
  allowSoleFallback = false,
): Promise<string> {
  const token = await getTelegramToken();
  if (!token) return "assistant bridge not running";
  const found = (await findBoundProject(targetText)) ??
    (allowSoleFallback ? await soleBoundProject() : null);
  if (!found) {
    return `No monitored project matches "${targetText}". /projects lists them.`;
  }
  const { id, binding } = found;
  const sessionId = await resolveBoundSession(id, binding);
  if (!sessionId) {
    return `${binding.name} has no chat session to prompt - open its AI panel on the desktop first.`;
  }
  const chat = getOrCreateChat(sessionId);
  // CAUSALITY: snapshot the last assistant message id NOW; the mirror hook
  // sends only a reply that appears AFTER this boundary (group-chat
  // contract - never background chatter).
  const lastAssistant = [...chat.messages].reverse().find((m) => m.role === "assistant");
  mirrorProvisions.set(sessionId, { chatId, boundaryId: lastAssistant?.id ?? null });

  const text = `[via Telegram] ${message}`;
  const state = useChatStore.getState();
  await state.injectMessage(sessionId, text);
  auditAppend(
    AUDIT_KINDS.assistantExec,
    "telegram-tell",
    `${binding.name} <- "${message.slice(0, 120)}"`,
    binding.root,
  );
  const meta = getSessionAgentMeta(sessionId);
  const busy =
    meta.status === "streaming" ||
    meta.status === "thinking" ||
    meta.status === "awaiting-approval";
  return busy
    ? `Sent to ${binding.name} (agent busy - your message will steer the run).`
    : `Sent to ${binding.name} - reply follows here.`;
}

/**
 * Mirror a session's settled reply to Telegram when a /tell provision is
 * pending. Called from the assistant module's reply-mirror hook (wired in
 * index.ts against chatStore meta transitions); one-shot: the provision is
 * consumed whether or not the text was usable, so a follow-up /tell always
 * gets its own reply.
 */
export async function mirrorProjectReply(
  sessionId: string,
  replyText: string,
): Promise<void> {
  const provision = mirrorProvisions.get(sessionId);
  if (!provision) return;
  mirrorProvisions.delete(sessionId);
  const token = await getTelegramToken();
  const prefs = await loadAssistantPrefs();
  if (!token || !prefs.enabled || prefs.ownerChatId == null) return;
  // Find the project for a readable prefix.
  let name = "project";
  for (const b of Object.values(prefs.boundProjects)) {
    if (b.sessionId === sessionId) {
      name = b.name;
      break;
    }
  }
  const body = replyText.trim() || "(no output)";
  const capped =
    body.length > 3_800 ? `${body.slice(0, 3_800)}\n… (truncated - full reply on desktop)` : body;
  await telegramNative
    .sendMessage(token, provision.chatId, `${name}:\n${capped}`)
    .catch(() => {});
  auditAppend(AUDIT_KINDS.assistantExec, "telegram-reply", `${name} -> owner (${body.length} ch)`, "");
}

/** Drop a pending mirror (session deleted / project unbound). */
export function clearMirrorProvision(sessionId: string): void {
  mirrorProvisions.delete(sessionId);
}

/** Is a mirror pending for this session? (Idle-ping suppression: a bound
 *  project's "reply ready" ping is redundant when we're about to mirror the
 *  reply itself.) */
export function hasMirrorProvision(sessionId: string): boolean {
  return mirrorProvisions.has(sessionId);
}

// ── Proactive monitor (meta-transition hook) ────────────────────────────

/**
 * Module-level status watcher for bound projects. Same lifetime as the main
 * window's Telegram delivery ownership (installed by App's assistant
 * bootstrap, after the bridge starts). On every agent-meta bump it compares
 * each bound session's status to the previous tick:
 *
 *  - busy -> idle with a FRESH assistant reply:
 *      - a pending /tell mirror provision exists -> mirror the reply text
 *        to Telegram (one-shot; causality = reply id != provision boundary)
 *      - else -> "reply ready" ping (the AFK monitoring contract: you left
 *        a run going; here's when it lands). Ping-side causality: only when
 *        the last assistant id CHANGED since the previous ping, so a
 *        re-notify of the same reply never double-pings.
 *  - * -> awaiting-approval: ping "needs your approval (desktop)" once per
 *    transition (approving from the phone is a later phase - the desktop
 *    card is the human gate).
 *
 * The chatStore meta subscription carries no session id, so the tick scans
 * bound sessions (bounded by the number of bindings - tiny) and diffs
 * against a local prev map.
 */
const monitorPrevStatus = new Map<string, string>();
const monitorLastReplyId = new Map<string, string>();
let monitorUnlisten: (() => void) | null = null;
let monitorTick = 0;

async function monitorBoundSessions(): Promise<void> {
  const prefs = await loadAssistantPrefs();
  if (!prefs.enabled) return;
  const entries = Object.entries(prefs.boundProjects);
  for (const [, binding] of entries) {
    const sessionId = binding.sessionId;
    if (!sessionId) continue;
    const meta = getSessionAgentMeta(sessionId);
    const prev = monitorPrevStatus.get(sessionId) ?? "idle";
    monitorPrevStatus.set(sessionId, meta.status);
    const busyPrev = prev === "thinking" || prev === "streaming";
    const settled = meta.status === "idle" && busyPrev;

    if (meta.status === "awaiting-approval" && prev !== "awaiting-approval") {
      // Rich approval ping (Phase 2): the tool + summary + one-tap command
      // ids for phone-approvable calls; the generic "respond on the
      // desktop" line remains for privacy/elevated carve-outs.
      let text: string | null = null;
      try {
        const { approvalPingText } = await import("./telegramApprovals");
        text = await approvalPingText(sessionId);
      } catch {
        text = null;
      }
      await pingOwnerBound(
        text ?? `${binding.name}: agent needs your approval (respond on the desktop).`,
      );
      continue;
    }

    if (!settled) continue;

    // The live chat is the source of truth for the reply text. getOrCreate
    // would resurrect a deleted session - guard on the session list first.
    const state = useChatStore.getState();
    if (!state.sessions.some((s) => s.id === sessionId)) continue;
    const chat = getOrCreateChat(sessionId);
    const lastAssistant = [...chat.messages].reverse().find((m) => m.role === "assistant");
    const replyText = lastAssistant
      ? (lastAssistant.parts ?? [])
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim()
      : "";

    const provision = mirrorProvisions.get(sessionId);
    if (provision && lastAssistant && lastAssistant.id !== provision.boundaryId) {
      // The /tell round-trip completes: mirror the provoked reply.
      await mirrorProjectReply(sessionId, replyText);
      monitorLastReplyId.set(sessionId, lastAssistant.id);
      continue;
    }
    // Plain monitor ping: only when a genuinely new reply landed (not the
    // same one re-notified by a later idle flip).
    if (lastAssistant && monitorLastReplyId.get(sessionId) !== lastAssistant.id) {
      monitorLastReplyId.set(sessionId, lastAssistant.id);
      await pingOwnerBound(
        `${binding.name}: agent finished${replyText ? ` - "${replyText.slice(0, 140)}${replyText.length > 140 ? "\u2026" : ""}"` : "."}`,
      );
    }
  }
}

/** Install the monitor (idempotent). Lives in the MAIN window alongside the
 *  Telegram delivery ownership - App.tsx calls this from the assistant
 *  bootstrap effect. */
export function installTelegramProjectMonitor(): void {
  if (monitorUnlisten) return;
  monitorUnlisten = subscribeSessionAgentMeta(() => {
    // Debounce coalesced patches (steps/usage bump the version rapidly
    // during a run): one scan per macrotask is plenty.
    if (monitorTick) return;
    monitorTick = window.setTimeout(() => {
      monitorTick = 0;
      void monitorBoundSessions().catch((e) =>
        console.warn("[kai:assistant] project monitor tick failed:", e),
      );
    }, 250);
  });
}

/** Test seam: reset monitor state between tests. */
export function __resetProjectMonitorForTest(): void {
  monitorUnlisten?.();
  monitorUnlisten = null;
  if (monitorTick) window.clearTimeout(monitorTick);
  monitorTick = 0;
  monitorPrevStatus.clear();
  monitorLastReplyId.clear();
  mirrorProvisions.clear();
}

// ── Proactive pings (monitor without prompting) ──────────────────────────

/**
 * Ping the owner about a bound project's state transition. Called from the
 * desktop bridge on busy->idle settles and approval transitions for bound
 * projects. Fail-soft like telegramPing. `text` should already name the
 * project.
 */
export async function pingOwnerBound(text: string): Promise<void> {
  const token = await getTelegramToken();
  const prefs = await loadAssistantPrefs();
  if (!token || !prefs.enabled || prefs.ownerChatId == null) return;
  await telegramNative.sendMessage(token, prefs.ownerChatId, text).catch(() => {});
}

/** Proactive-ping gate: is this session bound? (Desktop hook consults this
 *  before formatting a ping, so unbound projects never ping.) */
export async function sessionOwnerName(sessionId: string): Promise<string | null> {
  const prefs = await loadAssistantPrefs();
  for (const b of Object.values(prefs.boundProjects)) {
    if (b.sessionId === sessionId) return b.name;
  }
  return null;
}
