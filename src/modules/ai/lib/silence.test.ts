import { describe, expect, it } from "vitest";
import { frameRms, SilenceDetector, trimTrailingSilence } from "./silence";

function record(d: SilenceDetector, frames: Array<[number, number]>) {
  for (const [rms, ms] of frames) d.feed(rms, ms);
}

describe("SilenceDetector", () => {
  it("does not fire before any speech (silence never ends an empty recording)", () => {
    const d = new SilenceDetector({ onSpeechEnd: () => expect.unreachable() });
    record(d, [[0, 100], [0.001, 100], [0, 5000]]);
    expect(d.hasSpeech).toBe(false);
    expect(d.hasEnded).toBe(false);
  });

  it("fires after sustained silence following speech", () => {
    let fired = false;
    const d = new SilenceDetector({ silenceMs: 1600, onSpeechEnd: () => (fired = true) });
    record(d, [[0.05, 100], [0.05, 100], [0.02, 100]]);
    expect(d.hasSpeech).toBe(true);
    record(d, [[0.001, 1000]]);
    expect(fired).toBe(false); // not yet 1600ms of quiet
    record(d, [[0, 700]]);
    expect(fired).toBe(true);
  });

  it("a late speech frame resets the silence window", () => {
    let fired = false;
    const d = new SilenceDetector({ silenceMs: 1600, onSpeechEnd: () => (fired = true) });
    record(d, [[0.05, 100], [0.001, 1200], [0.06, 100], [0.001, 1500]]);
    expect(fired).toBe(false);
    record(d, [[0, 200]]);
    expect(fired).toBe(true);
  });

  it("fires on the hard cap after first speech", () => {
    let fired = false;
    const d = new SilenceDetector({
      silenceMs: 60_000,
      maxMs: 2000,
      onSpeechEnd: () => (fired = true),
    });
    record(d, [[0.05, 100], [0.04, 2000]]);
    expect(fired).toBe(true);
  });

  it("ignores frames after firing", () => {
    const calls: number[] = [];
    const d = new SilenceDetector({
      silenceMs: 500,
      onSpeechEnd: () => calls.push(1),
    });
    record(d, [[0.05, 100], [0, 600], [0.05, 100], [0, 600]]);
    expect(calls.length).toBe(1);
  });

  it("frameRms computes sane levels", () => {
    expect(frameRms(new Float32Array(1000))).toBe(0);
    const ones = frameRms(new Float32Array(1000).fill(0.5));
    expect(ones).toBeCloseTo(0.5, 5);
    expect(frameRms(new Float32Array(0))).toBe(0);
  });
});

describe("trimTrailingSilence (whisper repetition-loop guard)", () => {
  // 16kHz: 16000 samples = 1s. Speech threshold 0.015 (SILENCE_DEFAULTS).
  const rate = 16000;

  it("cuts the detector's own dead-air tail but keeps speech + pad", () => {
    // 1s of speech followed by 2s of silence (the auto-end detector fires
    // at 1.6s - so a real capture carries at least that much dead air).
    const speech = new Float32Array(rate).fill(0.05);
    const tail = new Float32Array(rate * 2);
    const samples = new Float32Array([...speech, ...tail]);
    const out = trimTrailingSilence(samples, rate);
    // Everything the detector waited through is gone; only speech + the
    // 250ms pad survives. The pad is QUIET BY DESIGN, so the kept samples
    // are speech followed by a short silent tail.
    expect(out.length).toBeLessThanOrEqual(rate + Math.round(rate * 0.25) + 256);
    expect(out.length).toBeGreaterThan(rate * 0.9);
    // All SPEECH samples survive at the front, in order (float32 storage
    // rounds 0.05 - compare approximately).
    for (let i = 0; i < rate; i++) expect(out[i]).toBeCloseTo(0.05, 5);
    // The 250ms pad after them is quiet (zeros), not leftover speech.
    expect(out[rate + 100]).toBe(0);
  });

  it("keeps a fully-silent capture BY IDENTITY (never deletes the dictation)", () => {
    // A quiet mic capture where NO window clears the threshold: returning a
    // trimmed (empty) buffer would DELETE the user's recording.
    const samples = new Float32Array(rate).fill(0.001);
    expect(trimTrailingSilence(samples, rate)).toBe(samples);
  });

  it("returns normal speech BY IDENTITY when there is nothing to cut", () => {
    const samples = new Float32Array(rate).fill(0.05);
    expect(trimTrailingSilence(samples, rate)).toBe(samples);
  });

  it("handles mid-capture gaps (trims only the TRAILING silence)", () => {
    // speech, 0.5s gap, speech, 1s tail: the gap stays, only the tail goes.
    const sp = (n: number) => new Float32Array(n).fill(0.05);
    const q = (n: number) => new Float32Array(n);
    const samples = new Float32Array([...sp(rate), ...q(rate / 2), ...sp(rate), ...q(rate)]);
    const out = trimTrailingSilence(samples, rate);
    // Kept: 1s + 0.5s + 1s + pad - the FINAL second of silence is gone.
    expect(out.length).toBeGreaterThan(rate * 2.4);
    expect(out.length).toBeLessThan(rate * 3.3);
  });
});
