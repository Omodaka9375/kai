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
 *     reply from nowhere. Fix: the arm is consumed on every decision path.
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
  const src = read("./AgentRunBridge.tsx");

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
    // The search loop is bounded by `from`, derived from the busy snapshot —
    // NOT the old `i >= 0 && !text` whole-history walk.
    expect(src).toContain("for (let i = msgs.length - 1; i >= from && !text; i--) {");
    expect(src).not.toContain("i >= 0 && !text");
  });

  it("a run with no speakable text says NOTHING (arm consumed, no walk-back)", () => {
    expect(src).toContain("if (!text) return; // THIS run produced nothing speakable — say nothing");
    // The arm is consumed BEFORE extraction, on every exit path.
    const consumeIdx = src.indexOf("runEndedRef.current = false;\n    // The reply THIS run produced");
    expect(consumeIdx).toBeGreaterThan(-1);
  });

  it("spokenFor dedupes by MESSAGE ID, not array length", () => {
    expect(src).not.toContain("${sessionId}:${msgs.length}");
    expect(src).toContain("if (spokenForRef.current === spokenId) return;");
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
    // Object-identity compare against the boundary object: the loop stops at
    // the pre-run assistant object; anything newer (new object, same slot)
    // is the regenerated reply.
    expect(src).toContain("if (m === boundaryObj) break;");
  });

  it("mid-run state clears any stale arm (a new run supersedes a prior settle)", () => {
    const midRun = src.slice(
      src.indexOf("if (isBusy) {"),
      src.indexOf("if (!ttsActive) return;"),
    );
    expect(midRun).toContain("runEndedRef.current = false;");
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
