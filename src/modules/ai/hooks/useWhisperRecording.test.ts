import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * SOURCE PINS for the 2026-11-06 voice complaint ("Ctrl+M voice input
 * repeated the same sentence many times in the chat" - reported on another
 * user's machine). The hook drives MediaRecorder/AudioContext/SpeechRecognition
 * - not unit-mockable here without jsdom audio shims - so the BEHAVIORAL
 * coverage lives in silence.test.ts (trimTrailingSilence) and these pins
 * hold the wiring of the three guards in the hook itself.
 */
describe("useWhisperRecording voice-repeat guards (source pins)", () => {
  const src = readFileSync(
    new URL("./useWhisperRecording.ts", import.meta.url),
    "utf8",
  );
  const silence = readFileSync(
    new URL("../lib/silence.ts", import.meta.url),
    "utf8",
  );

  it("browser STT delivers a transcript ONCE even when onerror precedes onend", () => {
    // The deliver-once flag gates BOTH handlers.
    expect(src).toContain("let delivered = false;");
    expect(src.match(/if \(text && !delivered\)/g)?.length).toBe(2);
    expect(src).toContain("delivered = true;");
  });

  it("browser STT ignores replayed resultIndex (transcript accumulation)", () => {
    // The watermark: a reset/replayed resultIndex must not re-append finals.
    expect(src).toContain("let lastResultIndex = -1;");
    expect(src).toContain("if (start <= lastResultIndex && lastResultIndex >= 0) return; // replay");
  });

  it("local whisper route trims the detector's dead-air tail before encoding", () => {
    // The hallucination guard: the silence detector fires ~1.6s AFTER the
    // quiet frames were pushed - that tail must not reach whisper.cpp.
    expect(src).toContain("trimTrailingSilence(merged, sampleRate)");
    expect(src).toContain('import { frameRms, SilenceDetector, trimTrailingSilence } from "../lib/silence";');
    // The trimmer itself exists with the quiet-capture identity contract.
    expect(silence).toContain("export function trimTrailingSilence(");
    expect(silence).toContain("if (lastSpeechEnd === -1) return samples;");
  });

  it("local whisper stop is flush-once (a second stop cannot re-deliver)", () => {
    expect(src).toContain("if (!ctx) return; // already flushed (or never started)");
  });
});
