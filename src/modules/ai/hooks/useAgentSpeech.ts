import { useEffect, useRef, type MutableRefObject } from "react";
import type { UIMessage } from "@ai-sdk/react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { pickSpeakSegments, speakText } from "../lib/voiceTts";
import { isGroupDeliveryText } from "../store/groupChatStore";

/**
 * useAgentSpeech — the bridge's auto-speak effect, extracted 2026-11-10
 * (god-file cleanup; the TTS causality contracts are pinned by
 * lib/ttsCausality.test.ts against THIS file now).
 *
 * Speaks the reply THIS run produced, once, when it settles — never a
 * previous turn's reply (causality boundary), never a group-provoked run
 * (spoken replies are reserved for 1:1 user↔agent chats).
 *
 * The full design commentary (two-phase arm, object-identity boundary,
 * mid-run TTS enable, session-switch resets) lives inline below exactly as
 * it did in AgentRunBridge — several of those lines are source-pinned.
 */
export function useAgentSpeech(args: {
  sessionId: string;
  status: string;
  messages: UIMessage[];
  isActive: boolean;
}): { busyWasGroupRef: MutableRefObject<boolean> } {
  const { sessionId, status, messages, isActive } = args;
  const voiceTtsEnabled = usePreferencesStore((s) => s.voiceTtsMode !== "off");
  const ttsActive = isActive && voiceTtsEnabled;
  // Id of the last assistant message already spoken (dedupe by MESSAGE
  // identity, not array length - compaction changes lengths).
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
    // Snapshot the pre-run tail on EVERY busy transition - including when
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
      // queued - in that case the run answers the USER, not the group, and
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
      // void - a new run superseded it.
      runEndedRef.current = false;
      return;
    }
    if (!ttsActive) return;
    if (wasStreaming && !isBusy) {
      // A run just settled - arm the speak (fires once messages settle).
      runEndedRef.current = true;
    }
    if (!runEndedRef.current) return;
    // THE SPEAK DECISION is resolve-then-consume (the group-mirror throttle
    // contract, 2026-11-01): useChat throttles message flushes, so status
    // can settle BEFORE the final text lands. A pass that finds nothing
    // keeps the arm AND the boundary - `messages` is a dep of this effect,
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
    // narration while the final answer was skipped - or nothing at all when
    // the settle raced the throttled flush. The shared helper speaks the
    // FIRST part (the immediate lead-in) joined with the LAST (the final
    // answer); the step-by-step middle is skipped.
    const seg = pickSpeakSegments(msgs, from, boundaryObj);
    if (!seg) {
      // Stale pass: keep the arm for the throttled late flush - UNLESS the
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
    if (wasGroupRun) return; // group chats never speak - reserved for 1:1
    if (spokenForRef.current === seg.lastMessageId) return;
    spokenForRef.current = seg.lastMessageId;
    void speakText(seg.text);
  }, [status, ttsActive, messages, sessionId]);

  // The bridge's group-mirror gate reads this ref (MIRROR GATE ON RUN
  // PROVENANCE, 2026-11-04 review MUST 1): it is armed at busy-arm from the
  // triggering user message and lives with the busy-transition tracking
  // here. Returning it keeps ONE arming site.
  return { busyWasGroupRef };
}
