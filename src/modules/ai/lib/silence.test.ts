import { describe, expect, it } from "vitest";
import { frameRms, SilenceDetector } from "./silence";

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
