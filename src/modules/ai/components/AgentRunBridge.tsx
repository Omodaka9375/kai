import { useChat, type UIMessage } from "@ai-sdk/react";
import type { UIMessagePart } from "ai";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { resolvePath } from "../tools/tools";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  flushPersist,
  getOrCreateChat,
  getProjectActiveSession,
  stopSession,
  subscribeProjectActiveSessions,
  subscribeSessionAutoApprove,
  useChatStore,
  getSessionAutoApprove,
  getSessionAutoApproveVersion,
  patchSessionAgentMeta,
  type AgentMeta,
  getSessionSteeringMessage,
  setSessionSteeringMessage,
  type AgentRunStatus,
} from "../store/chatStore";
import { verifyIfDirtyAtRunEnd } from "../lib/autoVerify";
import {
  applyEditsLocally,
  extractFileMutations,
  readOriginal,
  type EditOp,
} from "../lib/aiDiffExtract";
import { hasLeakedToolCall } from "../lib/leakedToolCall";
import { setProjectHasNews } from "../store/projectStatus";
import { offerToDigest } from "../lib/desktopDigest";
import { predictAutoApproval } from "../lib/autoApprovePrediction";
import { activeProjectId, projectIdForSession } from "../store/chatStore";
import { isApprovalDenied, noteApprovalDenied } from "../lib/approvalLatch";
import { applyApprovalResponseToChat } from "../store/chatStore";
import { pickSpeakSegments, speakText } from "../lib/voiceTts";
import { useProjectRuntime } from "@/modules/workspace";
import {
  appendGroupMessage,
  deliverAgentMentions,
  coordinatorGroupForSession,
  consumeCoordinatorPreamble,
  coordinatorPreamble,
  getGroup,
  noteCoordinatorRoundDone,
  noteParticipantReply,
  noteSessionBusy,
  noteSessionIdle,
  resolveMirrorReply,
  peekReplyProvision,
  takeReplyProvision,
  isGroupDeliveryText,
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
  // CAUSALITY BOUNDARY: the id of the last assistant message that existed
  // BEFORE the current run began (snapshotted in the busy arm). A group
  // reply is mirrored only when the run produced a NEW assistant message
  // AFTER the delivery - a run that stopped/errored before emitting text
  // must not mirror the PREVIOUS turn's reply as this round's answer (the
  // old gate compared only against lastMirroredIdRef, so any older
  // un-mirrored message could leak through).
  const deliveryBoundaryIdRef = useRef<string | null>(null);
  // Busy-transition tracker for the boundary snapshot below: the snapshot
  // must fire ONLY on idle->busy transitions. The busy arm re-runs on every
  // effect re-execution while busy (approvalsPending toggles, message
  // updates now that `messages` is a dep) — re-snapshotting mid-run would
  // move the boundary onto a message the run itself produced, making the
  // final reply equal the boundary so the mirror gate never fires.
  const prevBusyRef = useRef<{ sid: string | null; busy: boolean }>({
    sid: null,
    busy: false,
  });
  // CROSS-PROJECT NEWS boundary (same causality contract as the group
  // delivery boundary above, kept as its own ref): the last assistant id
  // that existed BEFORE the current run began. A news flag is set ONLY
  // when a run that just settled to idle produced a NEW assistant message
  // AFTER its busy-arm snapshot - mount-time recomputes, aborted runs and
  // unrelated effect re-runs must never flag.
  const newsBoundaryIdRef = useRef<string | null>(null);
  // Previous runStatus for transition detection (null on first run):
  // the news flag fires ONLY on a busy (thinking/streaming) -> idle
  // transition, never on mount or on idle->idle recomputes.
  const prevRunStatusRef = useRef<AgentRunStatus | null>(null);
  const prevNewsSessionRef = useRef<string | null>(null);
  // Desktop-digest transition refs (see the status effect): prev pending
  // count for the approval-rose check + prev runStatus for the settled
  // error/done check. Both reset on session switch so a stale count from
  // the outgoing session can't fire a phantom digest offer.
  const prevApprovalsPendingRef = useRef(0);
  const prevRunStatusForDigestRef = useRef<AgentRunStatus | null>(null);
  const digestSessionRef = useRef<string | null>(null);
  // Leak-nudge latch: one correction per session - a local model that emits
  // its tool-call template as text gets exactly one "use function calling"
  // nudge; repeating it is noise.
  const leakNudgedRef = useRef(false);
  // getOrCreateChat returns a cached Chat instance per session id. On fast
  // session switches the useMemo swaps the reference, but since Chat instances
  // are long-lived and keyed by id, useChat simply reconnects to the existing
  // subscription — no state is lost.
  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const { status, messages } = useChat<UIMessage>({
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
        // applyApprovalResponseToChat (not the hook's addToolApprovalResponse):
        // the SDK applier only rewrites the LAST message, so an approval part
        // stranded under a ride-along message (reminder/watch fire, steering,
        // user text appended while the run was parked on the card) made every
        // later response a silent no-op — click did nothing, card pinned
        // forever. The helper flips the part in place on ANY message and
        // continues the run.
        applyApprovalResponseToChat(chat, id, approved);
      } catch (e) {
        console.debug("[kai] stale approval ignored:", id, e);
      }
    },
    [chat],
  );
  useEffect(() => {
    setSessionResponder(sessionId, respond);
    if (isActive) setApprovalResponder(respond);
    return () => {
      setSessionResponder(sessionId, null);
      if (isActive) setApprovalResponder(null);
    };
    // respond is recreated each render but its deps (chat) are stable; keep
    // the responder identity tied to that so the applied response is always
    // against the current Chat instance.
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

  // ---- Auto-approve state --------------------------------------------------
  // Declared before the background-notification effect: that effect must
  // know which pending approvals auto-approve will NOT resolve on its own.
  const autoApproveVersion = useSyncExternalStore(
    subscribeSessionAutoApprove,
    getSessionAutoApproveVersion,
    getSessionAutoApproveVersion,
  );
  // Version-derived memo: the Map read is not reactive by itself. Without
  // this subscription, toggling Allow/Ask on an idle approval-pinned session
  // never re-ran the auto-approve effect and the toggle looked inert.
  const autoApprove = useMemo(
    () => getSessionAutoApprove(sessionId),
    [sessionId, autoApproveVersion],
  );
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

  // ---- Manual-attention count -------------------------------------------
  // (2026-11-02 report: "left an agent in auto mode, got 'needs your
  // approval' notification, but switching there showed auto executing
  // fine - wiring bug".) approvalsPending counts RAW approval-requested
  // parts; under autoApprove "all" every tool call transiently lands
  // there before the auto-approve effect resolves it a macrotask later,
  // so every "needs USER attention" consumer fired on cards nobody
  // needed to click: the awaiting-approval status (pill/group notes),
  // the desktop digest's approval toast, and the openMini nudge.
  // manualApprovalsPending counts ONLY the parts auto-approve will NOT
  // resolve on its own - the same carve-outs the bridge effect applies
  // (elevated / privacy / signed commit), mirrored by
  // predictAutoApproval (kept in lockstep by
  // autoApprovePrediction.test.ts). Ask mode ("off"):
  // predictAutoApproval is false for everything, so manual === raw and
  // behavior is unchanged.
  // ONE pass computes BOTH pending counts (2026-11-03 perf pass): these were
  // two separate useMemos, each iterating EVERY message x part on EVERY 50ms
  // token flush - pure wasted full scans (approvals are rare, and a HIDDEN
  // background bridge streamed through them invisible to the user). The
  // result values are identical to the old pair:
  //   approvalsPending = raw approval-requested parts (feeds the stale
  //     reaper, which intentionally scans ALL history, + the awaiting dot);
  //   manualApprovalsPending = the subset auto-approve will NOT resolve
  //     (predictAutoApproval, in lockstep via autoApprovePrediction.test.ts).
  const { approvalsPending, manualApprovalsPending } = useMemo(() => {
    let approvals = 0;
    let manual = 0;
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const p of m.parts as AnyPart[]) {
        if ((p as { state?: string }).state !== "approval-requested") continue;
        approvals++;
        const id = (p as { approval?: { id?: string } }).approval?.id;
        if (!id) continue;
        const type = (p as { type?: string }).type ?? "";
        const input = (p as { input?: Record<string, unknown> }).input;
        if (
          predictAutoApproval({
            autoApprove,
            toolName: type.replace(/^tool-/, ""),
            input,
            signingApprovalRequired,
          })
        ) {
          // Auto-approve WILL resolve this one on its own - not manual.
          continue;
        }
        manual++;
      }
    }
    return { approvalsPending: approvals, manualApprovalsPending: manual };
  }, [messages, autoApprove, signingApprovalRequired]);

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
  //
  // REACTIVITY (2026-11-04 report: "when long command is running if I
  // accidentally send a message it gets swallowed and I have to click stop
  // for my message to appear"): getSessionSteeringMessage is a plain Map
  // read, NOT a store subscription — the queue write only took effect on
  // this bridge's NEXT render. During a long bash_run the SDK streams
  // nothing (no token flushes, no re-renders), so a queued steering message
  // sat unprocessed until the user clicked Stop (a status change finally
  // re-rendered the bridge). Subscribe to the store's steeringMessage so
  // the queue write re-renders this bridge immediately; the session-scoped
  // read below then sees the fresh value and the effect stops the run and
  // sends it right away.
  useChatStore((s) => s.steeringMessage);
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
      // stopSession (NOT bare chat.stop()): Chat.stop() is a documented
      // silent no-op when the status is neither streaming nor submitted —
      // an agent paused ON an approval card sits at `ready`, so bare stop()
      // left the steering message queued forever AND the run itself
      // streaming (stopSession also fires the run's own AbortController
      // and strips the now-orphaned approval parts).
      stopSession(sessionId);
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
  //
  // PREAMBLE TERM GATE (2026-11-02 audit SHOULD 4): the flag lives in the
  // STORE (persisted per group, cleared on reclaim/re-delegate/end) — the
  // old React-ref gate reset every boot and re-injected the preamble,
  // waking the coordinator with an unrequested model run per restart.
  // consumeCoordinatorPreamble is atomic: exactly one injection per term
  // even if this effect re-runs on every status change.
  useEffect(() => {
    const coordGroup = coordinatorGroupForSession(sessionId);
    if (!coordGroup) return;
    if (!consumeCoordinatorPreamble(coordGroup.id)) return;
    void useChatStore.getState().injectMessage(sessionId, coordinatorPreamble(coordGroup));
  }, [sessionId, status]);

  useEffect(() => {
    let runStatus: AgentRunStatus;
    // MANUAL gate (2026-11-02): auto-approvable cards under "all" mode are
    // resolved by the bridge within a macrotask - they must not pin the
    // session in awaiting-approval (pill, group delivery notes, digest).
    if (manualApprovalsPending > 0) runStatus = "awaiting-approval";
    else if (status === "submitted") runStatus = "thinking";
    else if (status === "streaming") runStatus = "streaming";
    else if (status === "error") runStatus = "error";
    else runStatus = "idle";
    // DESKTOP DIGEST (2026-10-31): OS toasts return for the HIDDEN window -
    // approval needed / error settled / run COMPLETELY finished. Never a
    // toast while visible, and parallel bursts coalesce into one multi-line
    // toast (see lib/desktopDigest.ts). The visibility gate + queue live
    // there; this bridge only OFFERS the three classes of event. Background
    // sessions only (`isActive` here means the foreground session - the one
    // whose panel is in front of the user).
    //
    // A NOTE ON busy->idle: `status` settles to "ready" (mapped to idle)
    // only when the WHOLE run ends - mid-run tool steps keep it at
    // "streaming". So the idle offer below fires on complete-run
    // completion, never per step. `awaiting-approval` is excluded from the
    // completion pair: pausing on a card is not finishing.
    if (!isActive) {
      // Session switch: reset the prev-refs so a stale count/status from
      // the outgoing session can't fire a phantom digest offer.
      if (digestSessionRef.current !== sessionId) {
        prevApprovalsPendingRef.current = 0;
        prevRunStatusForDigestRef.current = null;
        digestSessionRef.current = sessionId;
      }
      const projectName = digestProjectName(sessionId);
      // Approval: the MANUAL pending count ROSE (0 -> 1, or a new card
      // after the previous one was answered) - a card auto-approve will
      // resolve on its own never pings (2026-11-02 phantom-toast fix).
      // Prev-count ref mirrors the news-boundary pattern - mount
      // recomputes must not fire.
      if (manualApprovalsPending > prevApprovalsPendingRef.current) {
        offerToDigest({
          project: projectName,
          kind: "approval",
          detail: `${manualApprovalsPending} pending`,
        });
      }
      // Error / done: the run SETTLED (prev was thinking/streaming - a real
      // run just ended). The stall-recovery path patches back to streaming
      // instantly, so its blip never lands as a settled error here.
      const prevForDigest = prevRunStatusForDigestRef.current;
      if (
        (runStatus === "error" || runStatus === "idle") &&
        (prevForDigest === "thinking" || prevForDigest === "streaming")
      ) {
        offerToDigest({
          project: projectName,
          kind: runStatus === "error" ? "error" : "done",
          detail: "",
        });
      }
    }
    prevApprovalsPendingRef.current = manualApprovalsPending;
    prevRunStatusForDigestRef.current = runStatus;
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
      // MIRROR GATE (resolveMirrorReply — PURE, NON-CONSUMING): a reply is
      // mirrored into the group transcript ONLY when this session had a
      // group delivery awaiting an answer. Without the gate, any idle reply
      // from a member session — e.g. the user chatting with that same
      // project's agent locally — would leak into the group transcript.
      //
      // THROTTLE-RACE CONTRACT (2026-11-01, the 3rd "agent replies outside
      // the group"): useChat runs with experimental_throttle: 50, so status
      // can settle to ready BEFORE the final message flush lands in a
      // re-render. resolve() consumes NOTHING: against a stale messages
      // array it returns null (last assistant === boundary) and the
      // provision STAYS ARMED; `messages` is a dep of this effect, so the
      // late flush re-runs the arm and resolves with fresh messages.
      // Consumption happens only below, at the append, after the text
      // exists. An arm that consumed on stale messages burned the
      // provision against a reply it never saw — the reply then stayed in
      // the project chat forever.
      //
      // BOUNDARY LIFETIME (2026-11-04 review MUST 2): do NOT null the
      // boundary on this pass. Nulling made it single-use: a later idle
      // re-run (messages identity change — reaper, Stop cleanup,
      // compaction — while the provision is still armed) resolved with
      // boundaryId=null, so the causality check could not reject and a
      // pre-delivery LOCAL reply could mirror into the group. The ref is
      // overwritten by the next busy-arm snapshot (deliveryBoundaryIdRef
      // assignment there); until then keeping the last boundary is both
      // harmless (a consumed provision gates the whole resolve) and
      // load-bearing for the re-runs.
      const boundary = deliveryBoundaryIdRef.current;
      const coordGroup = coordinatorGroupForSession(sessionId);
      // MIRROR GATE ON RUN PROVENANCE (2026-11-04 review MUST 1): only a
      // run PROVOKED by a group delivery may mirror. busyWasGroupRef is
      // armed at busy-arm from the triggering user message
      // (isGroupDeliveryText) and was previously consulted by TTS muting
      // only. Without this gate, a provision-armed run that settled with
      // NO text (tool-only turn, denied tool, step cap) left the provision
      // armed forever — and the next LOCAL reply in that project chat
      // passed every id check and mirrored into the group transcript as
      // the group answer (leaking local content, re-waking the
      // coordinator, routing mentions out of local text). A non-provoked
      // settle with a provision armed means the delivery went UNANSWERED:
      // consume it and tell the group instead of leaving it armed.
      const provisionedGroupId = peekReplyProvision(sessionId);
      if (!busyWasGroupRef.current) {
        if (provisionedGroupId) {
          const g = getGroup(provisionedGroupId);
          if (g && g.endedAt === null) {
            takeReplyProvision(sessionId);
            const who =
              g.participants.find((p) => p.sessionId === sessionId)?.name ??
              "A participant";
            void appendGroupMessage(g.id, {
              from: "system",
              projectId: "",
              sessionId: "",
              text: `${who} did not reply to the last group delivery (its run produced no reply) — send again if you still need an answer.`,
            });
          }
        }
      } else {
      const mirror = resolveMirrorReply(
        sessionId,
        messagesRefForGroup.current,
        boundary,
        lastMirroredIdRef.current,
      );
      // 1a. PARTICIPANT mirror: this session's reply lands in the transcript.
      // CAUSALITY (inside resolveMirrorReply): the reply must post-date the
      // delivery (id !== boundary) and differ from the last mirrored id —
      // the PREVIOUS turn's reply can never masquerade as this round's
      // answer, and the provision stays armed for the next real reply.
      if (mirror) {
        takeReplyProvision(sessionId); // consume: this delivery is answered
        lastMirroredIdRef.current = mirror.assistantId;
        void appendGroupMessage(mirror.group.id, {
          from: "agent",
          projectId: mirror.projectId,
          sessionId,
          text: mirror.text,
        });
        // 1b. RELAY (Phase 2): if an agent-coordinator is waiting on this
        // participant, feed the reply to the coalescing buffer. When all
        // expected participants answered, the store returns ONE merged wake
        // message — injected here, the yield-and-resume contract (no polling).
        // The gate is the MIRRORED group's coordinator — the group this
        // session is answering a delivery for.
        if (
          mirror.group.coordinator.kind === "agent" &&
          mirror.group.coordinator.sessionId !== sessionId
        ) {
          const wake = noteParticipantReply(
            mirror.group.id,
            mirror.projectId,
            mirror.text,
          );
          if (wake) {
            void useChatStore.getState().injectMessage(
              mirror.group.coordinator.sessionId,
              wake,
            );
          }
        }
        // AGENT @-MENTION ROUTING (2026-11-01): the mirrored reply may
        // @-mention another member (the delivery prefix taught it the
        // roster + convention) — route those mentions so agents can
        // address each other in the group, not just the coordinator.
        // Fire-and-forget: routing must never fail the mirror itself.
        // PERSONAS are routed where their reply is produced
        // (runPersonaReply) — they never settle here.
        void deliverAgentMentions(
          mirror.group.id,
          mirror.projectId,
          mirror.text,
        ).catch(() => {});
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
      const provisionedGroupId = peekReplyProvision(sessionId)
        ? takeReplyProvision(sessionId)
        : null;
      // Same rule as the idle mirror: the provision names the group directly.
      const group = provisionedGroupId ? getGroup(provisionedGroupId) : null;
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
      // Causality boundary: snapshot the last assistant id BEFORE this run
      // can emit messages of its own — but ONLY on the idle->busy TRANSITION
      // (see prevBusyRef above). Mid-run re-runs (approvals toggling,
      // throttled message updates landing) must not clobber it, or the
      // final reply equals the boundary and is never mirrored.
      const justWentBusy =
        prevBusyRef.current.sid !== sessionId || !prevBusyRef.current.busy;
      prevBusyRef.current = { sid: sessionId, busy: true };
      if (justWentBusy) {
        const lastPre = [...messagesRefForGroup.current]
          .reverse()
          .find((m) => m.role === "assistant");
        deliveryBoundaryIdRef.current = lastPre?.id ?? null;
        newsBoundaryIdRef.current = lastPre?.id ?? null;
      }
    }
    // Background starts keep the current surface; the composer explicitly
    // opens the transcript for ordinary sends. Background notifications use
    // the same session-scoped status updates without stealing focus.

    // CROSS-PROJECT NEWS: a run that just produced its reply in a project
    // the user is NOT looking at is exactly the "it completed while I was
    // elsewhere and I never noticed" case. Surface it on the rail (amber
    // pulse) instead of relying on the user to poll project tiles.
    //
    // GATED (the first cut fired on every effect re-run while a background
    // bridge sat ready - mount, approvalsPending recomputes, message loads -
    // flagging every background project with a phantom "something new"):
    //  1. TRANSITION: prev status was thinking/streaming (a real run just
    //     ended), not a mount or an idle->idle recompute. Tracked per
    //     session so a sessionId switch can't smuggle a stale prev in.
    //  2. CAUSALITY: the run produced a NEW assistant message after the
    //     busy-arm boundary snapshot - an aborted/empty run doesn't flag.
    if (prevNewsSessionRef.current !== sessionId) prevRunStatusRef.current = null;
    prevNewsSessionRef.current = sessionId;
    const prevRunStatus = prevRunStatusRef.current;
    prevRunStatusRef.current = runStatus;
    if (
      runStatus === "idle" &&
      !isActive &&
      (prevRunStatus === "thinking" || prevRunStatus === "streaming")
    ) {
      const newsBoundary = newsBoundaryIdRef.current;
      newsBoundaryIdRef.current = null;
      const lastAssistant = [...messagesRefForGroup.current]
        .reverse()
        .find((m) => m.role === "assistant");
      if (lastAssistant && lastAssistant.id !== newsBoundary) {
        const owner = projectIdForSession(sessionId);
        if (owner && owner !== activeProjectId()) {
          setProjectHasNews(owner, true);
        }
      }
    }

    // LEAKED TOOL-CALL NUDGE: small/local models sometimes print their
    // tool-call template as text instead of emitting a structured call; the
    // run then "finishes" with zero tool parts and looks like the agent
    // stopped mid-task. Detect that shape ONCE per session and nudge.
    if (
      runStatus === "idle" &&
      !leakNudgedRef.current &&
      approvalsPending === 0
    ) {
      const msgs = messagesRefForGroup.current;
      const last = [...msgs].reverse().find((m) => m.role === "assistant");
      const hadToolCall = msgs.some(
        (m) => m.role === "assistant" && (m.parts ?? []).some((p) => String((p as { type?: string }).type ?? "").startsWith("tool-")),
      );
      const text = last
        ? (last.parts ?? [])
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n")
        : "";
      if (!hadToolCall && text && hasLeakedToolCall(text)) {
        leakNudgedRef.current = true;
        void useChatStore.getState().injectMessage(
          sessionId,
          "Your last message contained tool-call markup written as plain text instead of a real function call. Call tools with native function calling - do not write tool syntax, XML, or JSON blobs in your reply.",
        );
      }
    }
  }, [isActive, status, approvalsPending, manualApprovalsPending, patch, openMini, sessionId, messages]);

  useEffect(() => {
    // MANUAL gate (2026-11-02): same fix as the digest - an auto-approvable
    // card must not flash-open the mini window for a bridge-resolved call.
    if (isActive && manualApprovalsPending > 0) openMini();
  }, [isActive, manualApprovalsPending, openMini]);

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
    // APPROVAL PAUSE IS NOT RUN END (2026-11-03 report: "when a command
    // takes long the model's response is delayed after it and it seems to
    // forget what it was doing"). Every bash_run ends the request on the
    // approval card, so the SDK status settles to "ready" MID-RUN here —
    // and this effect used to fire the verify (up to 240s of tsc/cargo)
    // and inject a "[verify] Fix these failures" redirect while the run
    // was merely paused on a click. Skip whenever ANY approval card is
    // pending (raw count: auto-approvable cards resolve a macrotask later
    // and re-enter streaming); the run's final, post-approval idle is the
    // real run end and fires the verify there.
    if (approvalsPending > 0) return;
    const root = runtime?.root ?? useChatStore.getState().live.getWorkspaceRoot();
    void verifyIfDirtyAtRunEnd(sessionId, root, injectMessage, runtime?.native);
  }, [runtime, status, sessionId, injectMessage, approvalsPending]);

  // ---- Auto-speak finished replies (Voice settings) -----------------------
  // When a run settles to idle after streaming, read the reply THIS run
  // produced aloud via the configured TTS mode (local Piper / OpenAI /
  // AssemblyAI). Selecting any TTS mode other than "off" IS the opt-in —
  // there is no separate checkbox.
  //
  // CAUSALITY BOUNDARY (2026-10-31 fix): the pre-run tail (array length +
  // the last assistant message OBJECT) is snapshotted on every busy
  // transition, and the extraction NEVER walks back past it. The old code
  // searched the whole history for "the last assistant text" — a run whose
  // final message had no speakable text (tool-only replies, a stopped run,
  // a TTS toggle made through the voice_settings tool mid-run) fell through
  // to the PREVIOUS turn's reply and spoke it: "I turned TTS on and it
  // read the message from before my request." It also left the arm set on
  // that path (!text return), so the NEXT unrelated messages-change effect
  // re-fired extraction and spoke the old reply from nowhere, and its
  // dedupe key (session-id + array LENGTH — forbidden by the ttsCausality
  // pin) collided across compaction and steering strips, silently skipping
  // later replies.
  //
  // Two-phase on purpose: useChat throttles MESSAGE notifications
  // (experimental_throttle: 50) but NOT status notifications, so at end of
  // run the status flips to idle up to 50ms before the final message commit
  // lands. Phase 1 (the transition) only arms runEndedRef; phase 2 —
  // re-entered when the final messages land — actually speaks. (The status
  // flip render reads the LIVE array via getSnapshot, so the reply is
  // normally already there; phase 2 only waits out the throttle's trailing
  // edge when the settle and the last commit land in the same tick.)
  // Hooks must be UNCONDITIONAL: `isActive` flips when this workspace moves
  // between background and foreground (project switch) while the component
  // stays mounted. A conditional hook shifts every later hook's position;
  // React's production deps comparison then reads a non-effect hook's
  // memoizedState (deps === undefined) → TypeError reading 'length' inside
  // areHookInputsEqual → the whole tree unmounts (themed blank window).
  const voiceTtsEnabled = usePreferencesStore((s) => s.voiceTtsMode !== "off");
  const ttsActive = isActive && voiceTtsEnabled;
  // Id of the last assistant message already spoken (dedupe by MESSAGE
  // identity, not array length — compaction changes lengths).
  const spokenForRef = useRef<string | null>(null);
  const prevStatusRef = useRef(status);
  const prevSessionRef = useRef(sessionId);
  // True between a streaming→idle transition and the speak decision.
  const runEndedRef = useRef(false);
  // CAUSALITY BOUNDARY: what the tail looked like BEFORE the current run.
  // busyTailRef = array length snapshot at busy-arm; busyLastAssistantRef =
  // the last assistant message OBJECT at that moment (null when none).
  // Object identity, not id: the SDK deep-clones on replaceMessage, so a
  // regenerated reply is a NEW object with the same id and still counts as
  // "this run produced it".
  const busyTailRef = useRef<number | null>(null);
  const busyLastAssistantRef = useRef<UIMessage | null>(null);
  // TTS BOUNDARY: true when THIS run was provoked by a GROUP delivery:
  // a cross-project participant delivery, an agent-coordinator wake, or
  // the coordinator prompt. Group runs never speak: spoken replies are
  // reserved for one-to-one user↔agent chats (the reply is mirrored into
  // the group transcript instead, where it belongs). Snapshotted at
  // busy-arm alongside the tail, BEFORE the ttsActive gate, so a mid-run
  // TTS enable cannot resurrect a group run's voice either.
  const busyWasGroupRef = useRef<boolean>(false);
  // Latest render's state, read at speak time (after messages settle).
  const statusRef = useRef(status);
  statusRef.current = status;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => {
    const isBusy = status === "submitted" || status === "streaming";
    // Session switch: refs carry over (Bridge is not remounted), so reset
    // ALL transition tracking rather than speaking the new session's old
    // tail. spokenFor too: the key embeds no session, and a stale id from
    // the outgoing session must not skip the incoming one's first reply.
    if (prevSessionRef.current !== sessionId) {
      prevSessionRef.current = sessionId;
      prevStatusRef.current = status;
      runEndedRef.current = false;
      busyTailRef.current = null;
      busyLastAssistantRef.current = null;
      busyWasGroupRef.current = false;
      spokenForRef.current = null;
      return;
    }
    const wasStreaming = prevStatusRef.current === "streaming";
    const wasBusy =
      prevStatusRef.current === "streaming" ||
      prevStatusRef.current === "submitted";
    prevStatusRef.current = status;
    // Snapshot the pre-run tail on EVERY busy transition — including when
    // ttsActive is false. TTS can be enabled MID-RUN (voice_settings tool),
    // and a boundary snapshotted only-while-enabled would date from some
    // earlier run and mis-gate the settle.
    if (isBusy && !wasBusy) {
      const msgs = messagesRef.current;
      busyTailRef.current = msgs.length;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant") {
          busyLastAssistantRef.current = msgs[i];
          break;
        }
      }
      // Group-provoked? The triggering user message is the LAST user text
      // in the array at busy-arm (a queued group delivery may sit behind an
      // even later user message only when the user typed while it was still
      // queued — in that case the run answers the USER, not the group, and
      // speaking is correct).
      busyWasGroupRef.current = false;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role !== "user") continue;
        const text = m.parts
          ?.map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
          .join("")
          .trim();
        busyWasGroupRef.current = !!text && isGroupDeliveryText(text);
        break;
      }
    }
    if (isBusy) {
      // Mid-run: no settle to process. Any arm from a previous settle is
      // void — a new run superseded it.
      runEndedRef.current = false;
      return;
    }
    if (!ttsActive) return;
    if (wasStreaming && !isBusy) {
      // A run just settled — arm the speak (fires once messages settle).
      runEndedRef.current = true;
    }
    if (!runEndedRef.current) return;
    // THE SPEAK DECISION is resolve-then-consume (the group-mirror throttle
    // contract, 2026-11-01): useChat throttles message flushes, so status
    // can settle BEFORE the final text lands. A pass that finds nothing
    // keeps the arm AND the boundary — `messages` is a dep of this effect,
    // so the late flush re-runs and speaks then. The arm is consumed only
    // when a speak actually happens; the next busy transition voids it.
    const msgs = messagesRef.current;
    const from =
      busyTailRef.current != null
        ? Math.max(busyTailRef.current, 0)
        : 0;
    // Regenerate/stall-recovery replace the tail in place: the length may
    // equal the boundary while the OBJECT differs. pickSpeakSegments treats
    // any assistant message after `from` OR replacing the boundary object
    // as this run's.
    const boundaryObj = busyLastAssistantRef.current;
    // FIRST + LAST (2026-11-01 report: "voice says one random sentence, and
    // a fast agent never speaks at all"): multi-step runs accumulate every
    // step's text parts, and speaking only the last said a random middle
    // narration while the final answer was skipped — or nothing at all when
    // the settle raced the throttled flush. The shared helper speaks the
    // FIRST part (the immediate lead-in) joined with the LAST (the final
    // answer); the step-by-step middle is skipped.
    const seg = pickSpeakSegments(msgs, from, boundaryObj);
    if (!seg) {
      // Stale pass: keep the arm for the throttled late flush — UNLESS the
      // array was rewritten under us (compaction removed the pre-run reply
      // object), in which case `from` no longer means anything: void the
      // arm rather than risk speaking a stale tail.
      if (boundaryObj != null && from > 0 && !msgs.includes(boundaryObj)) {
        runEndedRef.current = false;
        busyTailRef.current = null;
        busyLastAssistantRef.current = null;
        busyWasGroupRef.current = false;
      }
      return;
    }
    runEndedRef.current = false;
    const wasGroupRun = busyWasGroupRef.current;
    busyTailRef.current = null;
    busyLastAssistantRef.current = null;
    busyWasGroupRef.current = false;
    if (wasGroupRun) return; // group chats never speak — reserved for 1:1
    if (spokenForRef.current === seg.lastMessageId) return;
    spokenForRef.current = seg.lastMessageId;
    void speakText(seg.text);
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
        // SHAPE-based (2026-10-31): the gate no longer requires
        // `toolName === "bash_run"` — an MCP (`server__*`) wrapper of shell
        // execution passing elevated:true is the same OS-privilege request
        // and must stop for the same click. The auto-allow carve-outs hold
        // for MCP tools too.
        const isElevated = input?.elevated === true;
        if (isElevated) continue;
        // Screen capture reads EVERYTHING visible on the monitor (other apps,
        // documents, passwords). Its approval card IS the privacy boundary, so
        // auto-approve — even "all" — must never silently take a screenshot.
        // This is the enforcement half of the fix; the prompt rules only make
        // the model less eager, they can't guarantee consent.
        if (PRIVACY_APPROVAL_TOOLS.has(toolName)) continue;
        // Commit signing "ask for approval" — a `git commit` from the agent
        // must be reviewed before signing, even under autoApprove: "all".
        // SHAPE-based (2026-10-31): any command-shaped input (command / cmd /
        // script — the same field set the central tool guards probe for MCP
        // tools) carries the gate, not just first-party bash_run. An MCP git
        // wrapper committing while signing is "ask" stops for the click.
        const isSignedCommit =
          signingApprovalRequired &&
          isGitCommitCommand(
            (input?.command ?? input?.cmd ?? input?.script) as
              | string
              | undefined,
          );
        if (isSignedCommit) continue;
        autoApprovedRef.current.add(id);
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
          // scheduled must win over session-level auto-approve. The MODE is
          // re-checked too (2026-11-06 "toggle loses all power" report):
          // switching Allow → Ask mid-step must also cancel every scheduled
          // approval for calls not yet approved — the timer fires a
          // macrotask after schedule, and a multi-tool step queued several.
          if (getSessionAutoApprove(sessionId) !== "all") return;
          respond(id, true);
          // Mark the store only after the deferred response fired: marking
          // at schedule time grew autoApprovedIds with ids whose cards were
          // reaped before the timer ran (part gone = decision can't land).
          markAutoApproved(id);
        }, 0);
      }
    }
  }, [messages, autoApprove, respond, markAutoApproved, signingApprovalRequired]);

  // ---- AI diff tab management ----------------------------------------------
  // We track which approvalIds have already opened a tab so re-renders don't
  // open duplicates. Reset when the session changes.
  const openedRef = useRef<Set<string>>(new Set());
  const fileMutationFingerprintRef = useRef<string>("");
  const wasActiveRef = useRef(isActive);
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
          t === "tool-replace_exact" ||
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
      /** openedRef key (approval AND path) - marked only when we OPEN. */
      dedupeKey: string;
      /**
       * Either a literal proposed content (write_file), or a function that
       * derives proposed content from the on-disk original (edit/multi_edit).
       */
      derive:
        | { kind: "literal"; content: string }
        | { kind: "edits"; edits: EditOp[]; expectedOccurrences?: number };
    };
    // Re-scan on activation change too: a hidden pass skips OPENS (below) but
    // advances the fingerprint, so the moment we come forward we must
    // re-derive the still-pending diffs and open them. `justActivated` forces
    // that bypass without re-opening already-resolved mutations.
    const justActivated = isActive && !wasActiveRef.current;
    wasActiveRef.current = isActive;
    if (
      !justActivated &&
      fileMutationFingerprint === fileMutationFingerprintRef.current
    ) {
      return;
    }
    fileMutationFingerprintRef.current = fileMutationFingerprint;

    const pending: Pending[] = [];
    const toClose = new Set<string>();
    const pendingSeen = new Set<string>();

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
          // Do NOT claim in openedRef here: a hidden pass defers opens, and
          // claiming now would leave the key "opened" without a tab, so
          // activation would never open it. Local dedupe (pendingSeen) keeps
          // the list unique; openedRef is claimed just before the batch
          // opens and RELEASED if an open never happens (see the cleanup).
          if (!openedRef.current.has(dedupeKey) && !pendingSeen.has(dedupeKey)) {
            pendingSeen.add(dedupeKey);
            pending.push({ approvalId, path, derive, dedupeKey });
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

    // Defer opens while HIDDEN (2026-11-03 perf pass): the diff-tab effect is
    // the most expensive work on the streaming path, so a backgrounded
    // project's file-edit approvals must NOT mount Monaco diff editors (and
    // read originals from disk) into an invisible tree - that was competing
    // with a project switch for the main thread. The CLOSE pass above still
    // ran (cheap: tears down any tab left open when we switched away). On
    // activation, justActivated re-runs this effect and opens what is still
    // pending. Keys are CLAIMED below before the batch opens and RELEASED
    // in the cleanup if an open never happened (race fix, see below).
    if (!isActive) return;

    if (pending.length === 0) return;

    // CLAIM NOW, RELEASE ON CANCEL (2026-11-03 review SHOULD): claim
    // synchronously so a re-run's scan dedupes against this in-flight
    // batch, and release in the cleanup the keys the IIFE never actually
    // opened. Claim-without-release was the race: a project switch
    // mid-flight set cancelled=true, the IIFE aborted before
    // openAiDiffTab, and the claimed-but-never-opened key made the
    // activation re-scan skip it forever - that approval's diff tab never
    // opened.
    for (const p of pending) openedRef.current.add(p.dedupeKey);

    let cancelled = false;
    const actuallyOpened = new Set<string>();
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
          const r = applyEditsLocally(
            original.content,
            p.derive.edits,
            p.derive.expectedOccurrences,
          );
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
        actuallyOpened.add(p.dedupeKey);
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
      // Release the claims this run never turned into tabs; keys that DID
      // open keep their claims (the close pass tears their tabs down when
      // the approval resolves). Without this, a cancelled in-flight open
      // permanently hid the diff for a still-pending approval.
      for (const p of pending) {
        if (!actuallyOpened.has(p.dedupeKey)) openedRef.current.delete(p.dedupeKey);
      }
    };
  }, [messages, fileMutationFingerprint, openAiDiffTab, closeAiDiffTab, isActive]);

  return null;
}

/** Desktop-digest display name for a session's owning project (root's last
 *  path segment). Sessions with no project (assistant) fall back to the
 *  session id. */
function digestProjectName(sessionId: string): string {
  const root = projectRootForSession(sessionId);
  if (!root) return sessionId.slice(0, 12);
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

function projectRootForSession(sessionId: string): string | null {
  const id = projectIdForSession(sessionId);
  if (!id) return null;
  // ProjectRuntime roots are not directly reachable from here; the rail's
  // items carry them. Fall back to the project id (stable, readable enough
  // in a toast) when the root is unavailable.
  return id;
}
