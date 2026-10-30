import { useChat, type UIMessage } from "@ai-sdk/react";
import type { ToolUIPart, UIMessagePart } from "ai";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { native } from "../lib/native";
import { checkReadable } from "../lib/security";
import { resolvePath } from "../tools/tools";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  flushPersist,
  getOrCreateChat,
  getProjectActiveSession,
  subscribeProjectActiveSessions,
  useChatStore,
  getSessionAutoApprove,
  patchSessionAgentMeta,
  type AgentMeta,
  getSessionSteeringMessage,
  setSessionSteeringMessage,
  type AgentRunStatus,
} from "../store/chatStore";
import { verifyIfDirtyAtRunEnd } from "../lib/autoVerify";
import { isApprovalDenied, noteApprovalDenied } from "../lib/approvalLatch";
import { speakText } from "../lib/voiceTts";
import { useProjectRuntime } from "@/modules/workspace";
import {
  appendGroupMessage,
  coordinatorGroupForSession,
  coordinatorPreamble,
  getGroupForSession,
  noteCoordinatorRoundDone,
  noteParticipantReply,
  noteSessionBusy,
  noteSessionIdle,
  takeReplyProvision,
} from "../store/groupChatStore";

/**
 * Headless bridge that mirrors chat lifecycle into the store, so the status
 * pill / mini-window / panel can react without being inside the chat hook tree.
 *
 * Side effects:
 *  - Patches `agentMeta` on every status / approvals change.
 *  - Auto-opens the mini-window when an approval is pending — the user has
 *    to act on it; hiding it would be hostile.
 *  - For pending `write_file` calls, opens an AI diff tab in the editor area
 *    so the user can review the proposed change before approving.
 *  - Persists messages of the active session on every change.
 */

export type DiffOpenInput = {
  path: string;
  originalContent: string;
  proposedContent: string;
  approvalId: string;
  isNewFile: boolean;
};

export type AgentRunBridgeProps = {
  openAiDiffTab: (input: DiffOpenInput) => number | null;
  closeAiDiffTab: (approvalId: string) => void;
  /** Only the foreground project may open windows, previews, or speak. */
  isActive?: boolean;
};

export function AgentRunBridge(props: AgentRunBridgeProps) {
  const runtime = useProjectRuntime();
  const foregroundId = useChatStore((s) => s.activeSessionId);
  const projectSessionId = useSyncExternalStore(
    subscribeProjectActiveSessions,
    () => runtime ? getProjectActiveSession(runtime.id) : foregroundId,
  );
  // Each workspace stays bound to ITS OWN session. A background bridge must
  // never follow the foreground chat or duplicate its approvals/diff effects.
  const sessionId = runtime ? projectSessionId : foregroundId;
  if (!sessionId) return null;
  return <Bridge sessionId={sessionId} {...props} />;
}

type BridgeProps = { sessionId: string } & AgentRunBridgeProps;

type WriteFileInput = { path?: unknown; content?: unknown };

type ToolPartLike = ToolUIPart & {
  approval?: { id: string };
  input?: WriteFileInput;
};

type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

/**
 * Tools whose approval card is a PRIVACY boundary — auto-approve never
 * applies, even under autoApprove: "all". The user must click every time.
 * `look_at_screen` reads the whole display; it joins elevated bash_run and
 * signed commits (handled inline below) in the never-auto-approve set.
 */
const PRIVACY_APPROVAL_TOOLS: ReadonlySet<string> = new Set([
  "look_at_screen",
]);

/**
 * Detect a `git commit` invocation inside a bash_run command, so we can force
 * an approval when commit signing is set to "ask for approval". Matches bare
 * `git commit`, `git commit -m ...`, and chained variants (`git add -A; git
 * commit ...`), but not plumbing commands like `git commit-tree`.
 */
function isGitCommitCommand(command: string | undefined): boolean {
  if (!command) return false;
  return /\bgit\s+commit(?:\s|$)/.test(command) && !/\bgit\s+commit-tree\b/.test(command);
}

function Bridge({
  sessionId,
  openAiDiffTab,
  closeAiDiffTab,
  isActive = true,
}: BridgeProps) {
  const runtime = useProjectRuntime();
  // Group-mirror plumbing: latest messages + last mirrored assistant id.
  // Separate refs (not the TTS ones) so the two concerns stay independent.
  const messagesRefForGroup = useRef<UIMessage[]>([]);
  const lastMirroredIdRef = useRef<string | null>(null);
  // getOrCreateChat returns a cached Chat instance per session id. On fast
  // session switches the useMemo swaps the reference, but since Chat instances
  // are long-lived and keyed by id, useChat simply reconnects to the existing
  // subscription — no state is lost.
  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const { status, messages, addToolApprovalResponse } = useChat<UIMessage>({
    chat,
    // Cap message-notification re-renders at ~20fps. During thinking bursts
    // the SDK fires replaceMessage (with a structuredClone of the whole
    // message) per chunk; unthrottled, several setStates land inside one
    // commit window, chain as re-entrant sync flushes, and React throws
    // "Maximum update depth exceeded" (#185) mid-stream. 50ms is
    // imperceptible (text parts already batch at 12fps) and the trailing
    // edge guarantees the final state lands.
    experimental_throttle: 50,
  });
  // Group mirror reads the settled messages — keep the ref current every
  // render (cheap; the effect only dereferences it on idle transitions).
  messagesRefForGroup.current = messages;
  const patch = useCallback((next: Partial<AgentMeta>) => {
    patchSessionAgentMeta(sessionId, next);
  }, [sessionId]);
  const openMini = useChatStore((s) => s.openMini);
  const persistMessages = useChatStore((s) => s.persistMessages);
  const setApprovalResponder = useChatStore((s) => s.setApprovalResponder);
  const setSessionResponder = useChatStore((s) => s.setApprovalResponderForSession);

  // Expose the approval responder so the diff tab can resolve approvals.
  // We keep it in a ref-stable closure so identity is stable per render.
  // Wrapped in try-catch: if the agent was stopped/restarted between the
  // approval card opening and the user clicking Accept/Reject, the Chat
  // may no longer have the tool call (stripped by stripIncompleteToolCalls)
  // and addToolApprovalResponse throws "Tool call not found". Swallow it.
  // Single choke-point for EVERY approval decision (human click, diff-tab
  // accept/reject, and — via `respond` below — the deferred auto-approve
  // paths). Denial is monotonic: a deny is latched so a later `approved:true`
  // on the same id is dropped, and an `approved:true` is dropped if that id
  // was already denied. This removes the last-writer race between a scheduled
  // auto-approve and a human Deny — order can only reduce permission.
  const respond = useCallback(
    (id: string, approved: boolean) => {
      if (!approved) noteApprovalDenied(id);
      else if (isApprovalDenied(id)) return;
      try {
        addToolApprovalResponse({ id, approved });
      } catch (e) {
        console.debug("[kai] stale approval ignored:", id, e);
      }
    },
    [addToolApprovalResponse],
  );
  useEffect(() => {
    setSessionResponder(sessionId, respond);
    if (isActive) setApprovalResponder(respond);
    return () => {
      setSessionResponder(sessionId, null);
      if (isActive) setApprovalResponder(null);
    };
    // respond is recreated each render but its deps (addToolApprovalResponse)
    // are stable; keep the responder identity tied to that so the SDK call is
    // always current.
  }, [sessionId, isActive, setSessionResponder, setApprovalResponder, respond]);

  useEffect(() => {
    persistMessages(sessionId, messages);
  }, [sessionId, messages, persistMessages]);

  // Flush the debounced write whenever the chat goes idle (or errors),
  // and on unmount, so a closed app or session-switch never loses the tail.
  useEffect(() => {
    if (status !== "submitted" && status !== "streaming") {
      flushPersist(sessionId);
    }
  }, [sessionId, status]);
  useEffect(() => {
    return () => flushPersist(sessionId);
  }, [sessionId]);

  const approvalsPending = useMemo(() => {
    let n = 0;
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const p of m.parts) {
        if ((p as { state?: string }).state === "approval-requested") n++;
      }
    }
    return n;
  }, [messages]);

  // ---- Auto-approve state --------------------------------------------------
  // Declared before the background-notification effect: that effect must
  // know which pending approvals auto-approve will NOT resolve on its own.
  const autoApprove = getSessionAutoApprove(sessionId);
  const markAutoApproved = useChatStore((s) => s.markAutoApproved);
  const autoApprovedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    autoApprovedRef.current = new Set();
  }, [sessionId]);

  // Commit-signing "ask for approval" must outrank autoApprove: "all". A signed
  // commit is a stronger, user-owned assertion than a routine file edit, so a
  // `git commit` from the agent should still surface a confirmation card.
  const signingApprovalRequired = usePreferencesStore(
    (s) => s.commitSigningEnabled && s.commitSigningMode === "approval",
  );

  // ---- Background completion bookkeeping ---------------------------------
  // OS notification popups were REMOVED here (2026-10-29): they interrupted
  // on every project switch and app focus change. The project rail's status
  // dot already tracks running/awaiting/idle per project live, and it now
  // pulses with a distinct color when THIS project needs user input (Ask
  // mode, or an approval auto-approve won't resolve) — visible in
  // peripheral vision without stealing focus. Nothing else needed here:
  // approvalsPending still feeds the status effect below.

  // ── Stale-approval reaper ─────────────────────────────────────────────
  // `approval-requested` parts can outlive their run: an aborted or errored
  // turn may leave one behind, and the approvalsPending counter above scans
  // ALL history — a single stale part pins the session in "awaiting-approval"
  // forever (busy UI, blocked sends, spinning status pill). The user's only
  // escape was the Stop button, which strips these parts manually.
  // The store's releaseStaleApprovals decides which parts are stale: it
  // spares a LIVE card (pending part on the LAST assistant message with a
  // non-error status — the run is paused for the user's click) and strips
  // everything else. Safe to call whenever approvals are pending but no run
  // is in flight; it's a no-op when the card is live.
  //
  // Deferred to its own macrotask: reassigning chat.messages notifies the
  // SDK store synchronously, which is one more nested-update level when it
  // fires inside an ongoing commit cascade (React #185 counts those).
  const releaseStaleApprovals = useChatStore((s) => s.releaseStaleApprovals);
  useEffect(() => {
    if (approvalsPending <= 0) return;
    if (status === "submitted" || status === "streaming") return;
    const t = setTimeout(() => releaseStaleApprovals(sessionId), 0);
    return () => clearTimeout(t);
  }, [approvalsPending, status, sessionId, releaseStaleApprovals]);
  // ---- Steering message injection -------------------------------------------
  // When the user sends a message while the agent is busy, stop the current
  // run first (so incomplete tool_use parts get cleaned up by
  // stripIncompleteToolCalls in the transport), then inject the steering
  // message once the status settles to idle. The queued payload is full
  // message PARTS (text + image files) — attachments survive the redirect.
  const steeringMessage = getSessionSteeringMessage(sessionId);
  const setSteeringMessage = useChatStore((s) => s.setSteeringMessage);
  // Keep a ref so the send callback always sees the latest value without
  // being a reactive dep (avoids the cleanup-cancels-timeout race).
  const steeringRef = useRef<AnyPart[] | null>(null);
  steeringRef.current = steeringMessage;

  useEffect(() => {
    if (!steeringMessage) return;
    if (status === "submitted" || status === "streaming") {
      // Agent is still running — stop it; the effect will re-fire once
      // status settles to "ready" and send the queued message then.
      chat.stop();
      return;
    }
    // Consume the message before sending: reading `steeringRef.current` first
    // and clearing the store second keeps the value stable across the
    // re-render that setSteeringMessage(null) triggers.
    setSessionSteeringMessage(sessionId, null);
    setSteeringMessage(null);
    const parts = steeringRef.current ?? steeringMessage;
    void chat.sendMessage({
      role: "user",
      parts,
    });
  }, [steeringMessage, status, chat, setSteeringMessage]);

  // ── Group chat: delegation preamble (Phase 2) ─────────────────────────
  // When this session becomes the group's AGENT coordinator (user action in
  // the panel), inject the coordination preamble as its next user message.
  // Runs once per delegation (keyed by group id); re-delegation after a
  // reclaim re-injects. Idle-gated: a busy agent gets it via the queue
  // (injectMessage's passive ride-along) rather than a hijack wake.
  //
  // TOP LEVEL on purpose: this block previously lived INSIDE the status-patch
  // effect below — hooks called from an effect callback hit a null dispatcher
  // ("Invalid hook call", minified React #321) and crashed the app on mount.
  const preambleGivenRef = useRef<string | null>(null);
  useEffect(() => {
    const coordGroup = coordinatorGroupForSession(sessionId);
    if (!coordGroup) {
      preambleGivenRef.current = null;
      return;
    }
    if (preambleGivenRef.current === coordGroup.id) return;
    preambleGivenRef.current = coordGroup.id;
    void useChatStore.getState().injectMessage(sessionId, coordinatorPreamble(coordGroup));
  }, [sessionId, status]);

  useEffect(() => {
    let runStatus: AgentRunStatus;
    if (approvalsPending > 0) runStatus = "awaiting-approval";
    else if (status === "submitted") runStatus = "thinking";
    else if (status === "streaming") runStatus = "streaming";
    else if (status === "error") runStatus = "error";
    else runStatus = "idle";
    patch({
      status: runStatus,
      approvalsPending,
      ...(runStatus === "idle" || runStatus === "error"
        ? { step: null }
        : {}),
      ...(runStatus === "idle" ? { error: null } : {}),
    });

  // ── Group chat hooks ──────────────────────────────────────────────────
  // Two responsibilities, both driven off the same status transition:
  //  1. When THIS session belongs to a group and a run just settled to
  //     idle, mirror its last assistant reply into the group transcript
  //     (the bridge is the only place that sees message transitions per
  //     session — the group store itself has no Chat subscription).
  //  2. Flush any group messages that queued while the agent was busy —
  //     deliver-on-idle is the group's no-interruption contract.
    if (runStatus === "idle") {
      // MIRROR GATE: a reply is mirrored into the group transcript ONLY
      // when this session had a group delivery awaiting an answer. Without
      // the gate, any idle reply from a member session — e.g. the user
      // chatting with that same project's agent locally — would leak into
      // the group transcript (and relay to the coordinator) uninvited.
      const provisionedGroupId = takeReplyProvision(sessionId);
      const group = provisionedGroupId ? getGroupForSession(sessionId) : null;
      const coordGroup = coordinatorGroupForSession(sessionId);
      const lastAssistant = [...messagesRefForGroup.current].reverse().find((m) => m.role === "assistant");
      const lastText = lastAssistant
        ? (lastAssistant.parts ?? [])
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n")
            .trim()
        : "";
      // 1a. PARTICIPANT mirror: this session's reply lands in the transcript.
      if (group && lastText && lastAssistant && lastAssistant.id !== lastMirroredIdRef.current) {
        lastMirroredIdRef.current = lastAssistant.id;
        void appendGroupMessage(group.id, {
          from: "agent",
          projectId: group.participants.find((p) => p.sessionId === sessionId)?.projectId ?? "",
          sessionId,
          text: lastText,
        });
        // 1b. RELAY (Phase 2): if an agent-coordinator is waiting on this
        // participant, feed the reply to the coalescing buffer. When all
        // expected participants answered, the store returns ONE merged wake
        // message — injected here, the yield-and-resume contract (no polling).
        if (coordGroup && coordGroup.coordinator.kind === "agent") {
          const myProjectId =
            group.participants.find((p) => p.sessionId === sessionId)?.projectId ?? "";
          const wake = noteParticipantReply(coordGroup.id, myProjectId, lastText);
          if (wake) {
            void useChatStore.getState().injectMessage(
              coordGroup.coordinator.sessionId,
              wake,
            );
          }
        }
      }
      // 2. COORDINATOR round bookkeeping: its own run settled — reset hop
      // depth for the next round.
      if (coordGroup) noteCoordinatorRoundDone(sessionId);
      noteSessionIdle(sessionId);
    } else if (runStatus === "error") {
      // A group participant that errored (bad key, provider outage, context
      // overflow) used to look like silence in the group transcript — the
      // coordinator kept waiting for a reply that would never come. Consume
      // the reply provision and surface the failure as a system note.
      const provisionedGroupId = takeReplyProvision(sessionId);
      const group = provisionedGroupId ? getGroupForSession(sessionId) : null;
      if (group) {
        const who = group.participants.find((p) => p.sessionId === sessionId)?.name ?? "A participant";
        void appendGroupMessage(group.id, {
          from: "system",
          projectId: "",
          sessionId: "",
          text: `${who} hit an error and stopped — open that project's AI panel to see the failure or send another message to retry.`,
        });
      }
      noteSessionIdle(sessionId);
    } else {
      noteSessionBusy(sessionId);
    }
    // Background starts keep the current surface; the composer explicitly
    // opens the transcript for ordinary sends. Background notifications use
    // the same session-scoped status updates without stealing focus.
  }, [isActive, status, approvalsPending, patch, openMini]);

  useEffect(() => {
    if (isActive && approvalsPending > 0) openMini();
  }, [isActive, approvalsPending, openMini]);

  // ---- Watch wake-up flush --------------------------------------------------
  // (REMOVED) A watch that fired mid-run used to queue a self-initiated wake
  // here that fired the moment the run settled — hijacking the user's
  // conversation with an unsolicited narrated response mid-exchange.
  // Mid-run fires are now PASSIVE: they sit in history and ride the next
  // request (any next request carries the full history, fire included).
  // Idle fires wake inline from injectMessage; nothing left to flush.

  // ---- End-of-run auto-verify -----------------------------------------------
  // Write tools only mark the project dirty (zero latency on the tool result);
  // the verification runs ONCE here, when the run settles to idle — never on
  // half-edited mid-refactor states. On failure the wake message injects the
  // exact errors, so the agent gets another turn to fix them before finishing.
  const injectMessage = useChatStore((s) => s.injectMessage);
  useEffect(() => {
    if (status === "submitted" || status === "streaming") return;
    const root = runtime?.root ?? useChatStore.getState().live.getWorkspaceRoot();
    void verifyIfDirtyAtRunEnd(sessionId, root, injectMessage, runtime?.native);
  }, [runtime, status, sessionId, injectMessage]);

  // ---- Auto-speak finished replies (Voice settings) -----------------------
  // When a run settles to idle after streaming, read the last assistant text
  // aloud via the configured TTS mode (local Piper / OpenAI). Selecting any
  // TTS mode other than "off" IS the opt-in — there is no separate checkbox.
  // Tracked with a ref so a re-mount (session switch) doesn't re-speak an
  // old message: only transitions count.
  //
  // Two-phase on purpose: useChat throttles MESSAGE notifications
  // (experimental_throttle: 50) but NOT status notifications, so at end of
  // run the status flips to idle up to 50ms before the final message commit
  // lands. Acting on the status change alone reads a stale messages array
  // and speaks the PREVIOUS turn's reply (always one turn behind). Phase 1
  // (the transition) only arms runEndedRef; phase 2 — re-entered when the
  // final messages land — actually speaks.
  // Hooks must be UNCONDITIONAL: `isActive` flips when this workspace moves
  // between background and foreground (project switch) while the component
  // stays mounted. A conditional hook shifts every later hook's position;
  // React's production deps comparison then reads a non-effect hook's
  // memoizedState (deps === undefined) → TypeError reading 'length' inside
  // areHookInputsEqual → the whole tree unmounts (themed blank window).
  const voiceTtsEnabled = usePreferencesStore((s) => s.voiceTtsMode !== "off");
  const ttsActive = isActive && voiceTtsEnabled;
  const spokenForRef = useRef<string | null>(null);
  const prevStatusRef = useRef(status);
  const prevSessionRef = useRef(sessionId);
  // True between a streaming→idle transition and the speak actually firing.
  const runEndedRef = useRef(false);
  // Latest render's state, read at speak time (after messages settle).
  const statusRef = useRef(status);
  statusRef.current = status;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => {
    // Session switch: refs carry over (Bridge is not remounted), so reset the
    // transition tracking rather than speaking the new session's old tail.
    if (prevSessionRef.current !== sessionId) {
      prevSessionRef.current = sessionId;
      prevStatusRef.current = status;
      runEndedRef.current = false;
      return;
    }
    const wasStreaming = prevStatusRef.current === "streaming";
    prevStatusRef.current = status;
    if (!ttsActive) {
      runEndedRef.current = false;
      return;
    }
    if (wasStreaming && status !== "submitted" && status !== "streaming") {
      // A run just settled — arm the speak (fires once messages settle).
      runEndedRef.current = true;
    }
    if (!runEndedRef.current) return;
    if (status === "submitted" || status === "streaming") {
      // A NEW run started before the settled one produced speakable text —
      // disarm so it can never speak a stale message from an earlier turn.
      runEndedRef.current = false;
      return;
    }
    // The last assistant message that has text is the reply just finished.
    const msgs = messagesRef.current;
    let text = "";
    for (let i = msgs.length - 1; i >= 0 && !text; i--) {
      const m = msgs[i];
      if (m.role !== "assistant") continue;
      // Multi-step runs accumulate EVERY step's text parts into the one
      // assistant message — narrations like "Let me check that…" land
      // alongside the final answer. Speak only the LAST text part (the
      // actual reply), not the join of all parts (the step-by-step lead-up).
      for (let j = m.parts.length - 1; j >= 0; j--) {
        const p = m.parts[j];
        if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
          text = p.text.trim();
          break;
        }
      }
    }
    if (!text) return; // final message not landed yet (throttle trailing edge)
    const key = `${sessionId}:${msgs.length}`;
    runEndedRef.current = false;
    if (spokenForRef.current === key) return;
    spokenForRef.current = key;
    void speakText(text);
  }, [status, ttsActive, messages, sessionId]);

  // ---- Auto-approve effect --------------------------------------------------
  // (autoApprove / markAutoApproved / autoApprovedRef / signingApprovalRequired
  // are declared above, before the background-notification effect that
  // consumes manualApprovalsPending.)

  useEffect(() => {
    // Approvals are per-call in Ask mode; Allow auto-approves the session,
    // with the stronger consent boundaries below always kept manual.
    if (autoApprove !== "all") return;
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const p of m.parts as AnyPart[]) {
        const state = (p as { state?: string }).state;
        if (state !== "approval-requested") continue;
        const id = (p as { approval?: { id?: string } }).approval?.id;
        if (!id || autoApprovedRef.current.has(id)) continue;
        // Determine the tool name.
        const type = (p as { type?: string }).type ?? "";
        const toolName = type.replace(/^tool-/, "");
        const input = (p as { input?: Record<string, unknown> }).input;
        // Elevation is a stronger trust boundary — never auto-approve it, even
        // under autoApprove: "all". The user must click the elevation card.
        const isElevated =
          toolName === "bash_run" && input?.elevated === true;
        if (isElevated) continue;
        // Screen capture reads EVERYTHING visible on the monitor (other apps,
        // documents, passwords). Its approval card IS the privacy boundary, so
        // auto-approve — even "all" — must never silently take a screenshot.
        // This is the enforcement half of the fix; the prompt rules only make
        // the model less eager, they can't guarantee consent.
        if (PRIVACY_APPROVAL_TOOLS.has(toolName)) continue;
        // Commit signing "ask for approval" — a `git commit` from the agent
        // must be reviewed before signing, even under autoApprove: "all".
        const isSignedCommit =
          toolName === "bash_run" &&
          signingApprovalRequired &&
          isGitCommitCommand(input?.command as string | undefined);
        if (isSignedCommit) continue;
        autoApprovedRef.current.add(id);
        markAutoApproved(id);
        // Defer each response to its own macrotask. Approving N pending tool
        // calls synchronously in one effect pass chains N SDK store
        // notifications inside a single React commit cascade (approval write
        // → commit → effect → next write → …); each approval adds ~2 nested
        // levels (state write + tool-output write), so a multi-file batch
        // step with ~25 tool calls exceeded React's 50-update depth and
        // threw Minified error #185 mid-stream. One timer per response gives
        // React a full commit between approvals — depth resets per task —
        // while auto-approve still completes within milliseconds.
        setTimeout(() => {
          // Latch-checked at fire time: a Deny that arrived after this was
          // scheduled must win over session-level auto-approve.
          respond(id, true);
        }, 0);
      }
    }
  }, [messages, autoApprove, respond, markAutoApproved, signingApprovalRequired]);

  // ---- AI diff tab management ----------------------------------------------
  // We track which approvalIds have already opened a tab so re-renders don't
  // open duplicates. Reset when the session changes.
  const openedRef = useRef<Set<string>>(new Set());
  const fileMutationFingerprintRef = useRef<string>("");
  useEffect(() => {
    openedRef.current = new Set();
    fileMutationFingerprintRef.current = "";
  }, [sessionId]);

  // Cheap fingerprint of file-mutation tool parts only. The diff-tab effect
  // is the most expensive thing on the streaming path, so we skip it when
  // only text/reasoning tokens have arrived (the common case).
  const fileMutationFingerprint = useMemo(() => {
    let fp = "";
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const p of m.parts as AnyPart[]) {
        const t = (p as { type?: string }).type;
        if (
          t === "tool-write_file" ||
          t === "tool-edit" ||
          t === "tool-multi_edit" ||
          t === "tool-batch_edit"
        ) {
          const state = (p as { state?: string }).state ?? "";
          const id =
            (p as { approval?: { id?: string } }).approval?.id ?? "";
          fp += `${id}:${state}|`;
        }
      }
    }
    return fp;
  }, [messages]);

  useEffect(() => {
    type Pending = {
      approvalId: string;
      path: string;
      /**
       * Either a literal proposed content (write_file), or a function that
       * derives proposed content from the on-disk original (edit/multi_edit).
       */
      derive:
        | { kind: "literal"; content: string }
        | { kind: "edits"; edits: EditOp[] };
    };
    if (fileMutationFingerprint === fileMutationFingerprintRef.current) {
      return;
    }
    fileMutationFingerprintRef.current = fileMutationFingerprint;

    const pending: Pending[] = [];
    const toClose = new Set<string>();

    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const part of m.parts as AnyPart[]) {
        for (const info of extractFileMutations(part)) {
        const { state, approvalId, path, derive } = info;
        if (!approvalId) continue;
        // Keyed by approval AND path: one batch_edit approval opens one
        // diff tab per file it touches.
        const dedupeKey = `${approvalId}:${path}`;
        if (state === "approval-requested") {
          if (!openedRef.current.has(dedupeKey)) {
            openedRef.current.add(dedupeKey);
            pending.push({ approvalId, path, derive });
          }
        } else if (
          state === "approval-responded" ||
          state === "output-available" ||
          state === "output-error"
        ) {
          if (openedRef.current.has(dedupeKey)) toClose.add(approvalId);
        }
        }
      }
    }

    for (const id of toClose) {
      // closeAiDiffTab(approvalId) closes ALL tabs for that approval.
      for (const key of [...openedRef.current]) {
        if (key.startsWith(`${id}:`)) openedRef.current.delete(key);
      }
      closeAiDiffTab(id);
    }

    if (pending.length === 0) return;

    let cancelled = false;
    void (async () => {
      const cwd = runtime?.root ?? useChatStore.getState().live.getCwd();
      for (const p of pending) {
        if (cancelled) return;
        let abs: string;
        try {
          abs = resolvePath(p.path, cwd);
        } catch {
          abs = p.path;
        }
        const original = await readOriginal(abs, runtime?.native);
        if (cancelled) return;
        let proposed = "";
        if (p.derive.kind === "literal") {
          proposed = p.derive.content;
        } else {
          const r = applyEditsLocally(original.content, p.derive.edits);
          if (r.ok) {
            proposed = r.content;
          } else {
            // Edit precondition failed — show a best-effort diff by
            // concatenating the new_string values so the user can still
            // review what the model proposed.
            proposed = original.content + "\n/* [Kai: edit could not be applied cleanly — showing raw proposal] */\n" +
              p.derive.edits.map((e) => e.new_string).join("\n");
          }
        }
        openAiDiffTab({
          path: abs,
          originalContent: original.content,
          proposedContent: proposed,
          approvalId: p.approvalId,
          isNewFile: original.isNewFile,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [messages, fileMutationFingerprint, openAiDiffTab, closeAiDiffTab]);

  return null;
}

type EditOp = { old_string: string; new_string: string; replace_all?: boolean };

type FileMutation =
  | {
      state: string;
      approvalId: string | null;
      path: string;
      derive: { kind: "literal"; content: string };
    }
  | {
      state: string;
      approvalId: string | null;
      path: string;
      derive: { kind: "edits"; edits: EditOp[] };
    };

function extractFileMutations(part: AnyPart): FileMutation[] {
  const type = (part as { type?: string }).type;
  const p = part as ToolPartLike;
  const state = (p as { state?: string }).state ?? "";
  const approvalId = p.approval?.id ?? null;

  if (type === "tool-write_file") {
    const input = (p.input ?? {}) as WriteFileInput;
    const path = typeof input.path === "string" ? input.path : "";
    const content = typeof input.content === "string" ? input.content : "";
    if (!path) return [];
    return [{ state, approvalId, path, derive: { kind: "literal", content } }];
  }
  if (type === "tool-edit") {
    const input = (p.input ?? {}) as {
      path?: unknown;
      old_string?: unknown;
      new_string?: unknown;
      replace_all?: unknown;
    };
    const path = typeof input.path === "string" ? input.path : "";
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    if (!path) return [];
    return [
      {
        state,
        approvalId,
        path,
        derive: {
          kind: "edits",
          edits: [
            {
              old_string: oldStr,
              new_string: newStr,
              replace_all: Boolean(input.replace_all),
            },
          ],
        },
      },
    ];
  }
  if (type === "tool-multi_edit" || type === "tool-batch_edit") {
    // multi_edit is retired but old transcripts replay it — keep the
    // top-level-path arm. batch_edit groups its edits per path so one
    // approval yields one mutation per file it touches.
    const input = (p.input ?? {}) as { path?: unknown; edits?: unknown };
    if (!Array.isArray(input.edits)) return [];
    const rawEdits = input.edits as Record<string, unknown>[];
    const groups = new Map<string, EditOp[]>();
    for (const e of rawEdits) {
      const path =
        typeof e.path === "string" && e.path.length > 0
          ? e.path
          : typeof input.path === "string"
            ? input.path
            : "";
      const oldStr = typeof e.old_string === "string" ? e.old_string : "";
      if (!path || oldStr.length === 0) continue;
      const op: EditOp = {
        old_string: oldStr,
        new_string: typeof e.new_string === "string" ? e.new_string : "",
        replace_all: Boolean(e.replace_all),
      };
      const g = groups.get(path);
      if (g) g.push(op);
      else groups.set(path, [op]);
    }
    if (groups.size === 0) return [];
    return [...groups.entries()].map(([path, edits]) => ({
      state,
      approvalId,
      path,
      derive: { kind: "edits" as const, edits },
    }));
  }
  return [];
}

function applyEditsLocally(
  original: string,
  edits: EditOp[],
): { ok: true; content: string } | { ok: false } {
  let content = original;
  for (const e of edits) {
    if (e.old_string === e.new_string || e.old_string.length === 0)
      return { ok: false };
    if (e.replace_all) {
      if (!content.includes(e.old_string)) return { ok: false };
      content = content.split(e.old_string).join(e.new_string);
    } else {
      const first = content.indexOf(e.old_string);
      if (first === -1) return { ok: false };
      const second = content.indexOf(e.old_string, first + 1);
      if (second !== -1) return { ok: false };
      content =
        content.slice(0, first) +
        e.new_string +
        content.slice(first + e.old_string.length);
    }
  }
  return { ok: true, content };
}

async function readOriginal(
  abs: string,
  client?: import("../lib/native").NativeClient,
): Promise<{ content: string; isNewFile: boolean }> {
  // The fs guard rejects sensitive paths even on read; mirror that here so
  // the user sees an empty "before" rather than an error tab.
  const safety = checkReadable(abs);
  if (!safety.ok) return { content: "", isNewFile: false };
  try {
    const r = await (client ?? native).readFile(abs);
    if (r.kind === "text") return { content: r.content, isNewFile: false };
    // Binary or oversized — we can't render the original sensibly. Show the
    // proposed content as a "new" view; the user can still cancel.
    return { content: "", isNewFile: false };
  } catch (e) {
    const msg = String(e).toLowerCase();
    const notFound =
      msg.includes("no such file") ||
      msg.includes("not found") ||
      msg.includes("os error 2");
    return { content: "", isNewFile: notFound };
  }
}
