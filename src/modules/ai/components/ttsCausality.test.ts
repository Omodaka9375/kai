import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * TTS speak-causality contract (2026-10-31) — "I turned TTS on mid-
 * conversation and it read the reply from BEFORE my request; then it read
 * nothing for the replies after that."
 *
 * Root causes fixed in AgentRunBridge's auto-speak effect:
 *  1. UNBOUNDED WALK-BACK: extraction searched the WHOLE history for "the
 *     last assistant text". A run whose reply had no speakable text (tool-
 *     only reply, stopped run, a voice_settings toggle mid-run) fell through
 *     to the PREVIOUS turn's reply and spoke it. Fix: a causality boundary —
 *     the pre-run tail (length + last assistant OBJECT) is snapshotted on
 *     every busy transition, and extraction never reaches back past it.
 *  2. STALE ARM: the `!text` path returned WITHOUT consuming runEndedRef, so
 *     the next unrelated messages-change re-ran extraction and spoke the old
 *     reply from nowhere. Fix (2026-11-01): resolve-then-consume — a pass
 *     that finds nothing KEEPS the arm (the throttled late flush re-runs
 *     the decision and speaks then); it is consumed only when a speak
 *     actually happens, and the next busy transition voids it.
 *  3. LENGTH-KEYED DEDUPE: `${sessionId}:${msgs.length}` collided across
 *     compaction / steering strips and skipped real replies; spokenFor is
 *     now the spoken MESSAGE ID.
 *  4. BOUNDARY SNAPSHOT ONLY WHEN TTS ENABLED: enabling mid-run (the
 *     voice_settings tool) left the boundary dating from an older run. The
 *     snapshot now happens on every busy transition regardless of ttsActive.
 */

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8") as string;

describe("AgentRunBridge auto-speak: causality boundary (source pins)", () => {
  const src = read("../hooks/useAgentSpeech.ts");
  const tts = read("../lib/voiceTts.ts");

  it("snapshots the pre-run tail (length + last assistant object) on busy transitions", () => {
    expect(src).toContain("busyTailRef.current = msgs.length;");
    expect(src).toContain("busyLastAssistantRef.current = msgs[i];");
    // Snapshot is taken BEFORE the ttsActive gate, so a mid-run enable still
    // has a boundary from THIS run.
    const snapIdx = src.indexOf("busyTailRef.current = msgs.length;");
    const gateIdx = src.indexOf("if (!ttsActive) return;");
    expect(snapIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(snapIdx);
  });

  it("extraction never reaches back past the pre-run boundary", () => {
    // Extraction lives in voiceTts.pickSpeakSegments (2026-11-01): the
    // bridge passes the busy-snapshot boundary (from + the pre-run
    // assistant object) — never the whole history.
    expect(src).toContain(
      "const seg = pickSpeakSegments(msgs, from, boundaryObj);",
    );
    expect(src).not.toContain("i >= 0 && !text");
    // The tail-walk to the final message starts at the boundary, never
    // at the array head.
    expect(tts).toContain("for (let i = msgs.length - 1; i >= start; i--) {");
  });

  it("no speakable text: the arm stays for the throttled late flush, never walks back", () => {
    // RESOLVE-THEN-CONSUME (2026-11-01): the old code consumed the arm
    // before extraction, so the settle-vs-throttled-flush race permanently
    // lost the reply's voice ("a fast agent never says anything"). A null
    // pick now returns WITHOUT consuming; the consume sits after the null
    // gate on the spoke path.
    const nullGate = src.indexOf("if (!seg) {");
    const consume = src.indexOf("runEndedRef.current = false;", nullGate);
    expect(nullGate).toBeGreaterThan(-1);
    expect(consume).toBeGreaterThan(nullGate);
    // The old consume-first + no-text forms are gone.
    expect(src).not.toContain("if (!text) return;");
    expect(src).not.toMatch(
      /runEndedRef\.current = false;\s*\n\s*\/\/ The reply THIS run produced/,
    );
  });

  it("spokenFor dedupes by MESSAGE ID, not array length", () => {
    expect(src).not.toContain("${sessionId}:${msgs.length}");
    expect(src).toContain(
      "if (spokenForRef.current === seg.lastMessageId) return;",
    );
    expect(src).toContain("spokenForRef.current = seg.lastMessageId;");
  });

  it("session switch resets the boundary AND spokenFor (key has no session)", () => {
    const switchBlock = src.slice(
      src.indexOf("prevSessionRef.current !== sessionId"),
      src.indexOf("return;\n    }\n    const wasStreaming"),
    );
    expect(switchBlock).toContain("busyTailRef.current = null;");
    expect(switchBlock).toContain("busyLastAssistantRef.current = null;");
    expect(switchBlock).toContain("spokenForRef.current = null;");
  });

  it("regenerate / stall-recovery in-place tail replacement is still this run's reply", () => {
    // Object-identity compare against the boundary object lives in
    // pickSpeakSegments now: the walk stops at the pre-run assistant
    // object; anything newer (new object, same slot) is the regenerated
    // reply. The bridge hands the snapshot object to the helper.
    expect(src).toContain("const boundaryObj = busyLastAssistantRef.current;");
    // The regenerated reply is detected by slot identity: the boundary
    // slot (start-1) holding a NEW object counts as this run's answer.
    expect(tts).toContain(
      "if (slot && slot !== boundaryObj && isAnswer(slot)) finalMsg = slot;",
    );
  });

  it("mid-run state clears any stale arm (a new run supersedes a prior settle)", () => {
    const midRun = src.slice(
      src.indexOf("if (isBusy) {"),
      src.indexOf("if (!ttsActive) return;"),
    );
    expect(midRun).toContain("runEndedRef.current = false;");
  });
});

describe("TTS is reserved for one-to-one chats — group runs never speak", () => {
  // 2026-10-31: "make sure group chats do not trigger TTS" — a group
  // delivery landing in a participant's (or coordinator's) session used
  // to settle and hit the same auto-speak effect, so multi-agent chatter
  // was read aloud. The fix: every group injection carries a FIXED marker
  // (isGroupDeliveryText), the bridge snapshots "group-provoked" at
  // busy-arm — BEFORE the ttsActive gate, so a mid-run enable can't
  // resurrect it — and the speak decision refuses group runs.
  const src = read("../hooks/useAgentSpeech.ts");
  const store = read("../store/groupChatStore.ts");

  it("the speech hook imports the group-delivery marker check", () => {
    expect(src).toContain("isGroupDeliveryText");
  });

  it("group-provoked is snapshotted at busy-arm BEFORE the ttsActive gate", () => {
    const armIdx = src.indexOf(
      "busyWasGroupRef.current = !!text && isGroupDeliveryText(text);",
    );
    const gateIdx = src.indexOf("if (!ttsActive) return;");
    expect(armIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(armIdx);
  });

  it("the speak decision refuses group runs (and consumes the snapshot)", () => {
    expect(src).toContain("const wasGroupRun = busyWasGroupRef.current;");
    expect(src).toMatch(
      /if \(wasGroupRun\) return; \/\/ group chats never speak/,
    );
    // Snapshot cleared on the decision path so the NEXT one-to-one run
    // speaks normally: the read immediately precedes the boundary clears.
    // (lastIndexOf: the session-switch block also clears the ref, EARLIER
    // in the file — the decision block's clear is the last one.)
    const readIdx = src.lastIndexOf(
      "const wasGroupRun = busyWasGroupRef.current;",
    );
    const clearIdx = src.lastIndexOf("busyWasGroupRef.current = false;");
    expect(readIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(readIdx);
    expect(clearIdx - readIdx).toBeLessThan(200);
  });

  it("session switch resets the group snapshot with the other boundaries", () => {
    const switchBlock = src.slice(
      src.indexOf("prevSessionRef.current !== sessionId"),
      src.indexOf("const wasStreaming"),
    );
    expect(switchBlock).toContain("busyWasGroupRef.current = false;");
  });

  it("the store's markers match every group injection template", () => {
    // The three injection shapes, in lockstep with isGroupDeliveryText.
    // 2026-11-02 audit NIT: the cross-project marker is ANCHORED at the
    // start of the message now (GROUP_DELIVERY_PREFIX_RE) — a pasted
    // transcript line no longer false-positives the group check.
    expect(store).toContain(" · cross-project group] ");
    expect(store).toContain("GROUP_DELIVERY_PREFIX_RE");
    expect(store).toContain("`[group] ${r.name} replied:");
    expect(store).toContain("[group: ");
    expect(store).toContain("export function isGroupDeliveryText");
  });

  it("persona runs have no speak path at all (headless generateText)", () => {
    // The ONLY production speakText call site is the bridge effect —
    // groupChatStore never speaks.
    expect(store).not.toContain("speakText");
  });
});

describe("speakText supersede semantics (the replies-after case)", () => {
  // The "then it doesn't read anything in front" half: a NEW run that
  // produces a reply must never be silenced by a stale spokenFor key. That
  // is covered by the id-dedupe pin above (ids differ across turns). This
  // block additionally pins the voiceTts queue contract the effect relies
  // on: each new speakText supersedes the previous one, so consecutive
  // replies each start clean.
  const tts = read("../lib/voiceTts.ts");

  it("a new utterance invalidates the queued remainder of an older one", () => {
    expect(tts).toContain("const token = ++runToken;");
    expect(tts).toContain("if (token !== runToken) return true;");
  });

  it("speakText reads the mode lazily — a mid-conversation enable applies to the next reply", () => {
    expect(tts).toContain('if (mode === "off") return false;');
  });
});

describe("speak the FINAL message in full, with length tiers (2026-11-01 redesign)", () => {
  // Research pass: the industry's three models are speech-native
  // generation (ChatGPT Live), a voice layer over summaries (VS Code Voice
  // Mode), or verbatim read-aloud with user-paced controls (Safari
  // Listen-to-Page). KAI narrates its own agent's prose, so the fit is
  // the third: READ the reply — the run's FINAL assistant message, all
  // its text parts — and give the user pacing controls. First+last read
  // as an incoherent abridgment and is retired.
  const src = read("../hooks/useAgentSpeech.ts");
  const tts = read("../lib/voiceTts.ts");

  it("the bridge picks the plan via the shared helper (old part loops gone)", () => {
    expect(src).toContain(
      "const seg = pickSpeakSegments(msgs, from, boundaryObj);",
    );
    expect(src).toContain("void speakText(seg.text);");
    // The hand-rolled backwards part scans are banned from the bridge.
    expect(src).not.toMatch(
      /for \(let j = m\.parts\.length - 1; j >= 0; j--\) \{/,
    );
    expect(src).not.toContain("void speakText(text);");
  });

  it("the helper speaks the final message's parts joined; tiers trim long answers honestly", () => {
    // Full-final-message contract + the length-tier machinery live in
    // pickSpeakSegments (behaviorally pinned in voiceTts.test.ts). Here:
    // the retired first+last join must not return, the tier constants
    // exist, and the sign-off names what's on screen.
    expect(tts).not.toContain("const first = texts[0]!;");
    expect(tts).toContain("export const SPEAK_FULL_CHARS = 700;");
    expect(tts).toContain(
      'const LONG_REPLY_SIGNOFF = "The full answer is on screen."',
    );
    expect(tts).toMatch(/text\.length > SPEAK_FULL_CHARS/);
  });

  it("pacing controls exist: pause/resume/skip/rate, and stop clears them", () => {
    // Safari Listen-to-Page parity: the user paces the narration.
    expect(tts).toContain("export function ttsPause(): void");
    expect(tts).toContain("export function ttsResume(): void");
    expect(tts).toContain("export function ttsSkip(): void");
    expect(tts).toContain("export function ttsSetRate(rate: number): void");
    // Stop must clear pause/skip so a stopped utterance can't leave the
    // next one latched.
    expect(tts).toMatch(/ttsStop[\s\S]*?skipRequested = false;/);
  });
});
