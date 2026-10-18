/**
 * Silence detection for voice input "Auto" end mode.
 *
 * Pure state machine fed per-audio-frame RMS levels (no Web Audio deps) so
 * it's unit-testable. Semantics:
 *  - The recording must first OBSERVE speech (level ≥ speech threshold) —
 *    a permanently noisy room never re-arms the detector, and silence before
 *    the user starts talking does not end the recording.
 *  - After speech, SILENCE_MS of consecutive quiet frames ends the recording.
 *  - An optional hard cap (maxMs from the first observed speech) bounds a
 *    runaway mic (user walked away); off (0) = no cap.
 */

export type SilenceDetectorOptions = {
  /** RMS level (0..1) at or above which a frame counts as speech. */
  speechThreshold?: number;
  /** Quiet milliseconds after the last speech frame before firing. */
  silenceMs?: number;
  /** Hard cap in ms from the first speech frame; 0 = no cap. */
  maxMs?: number;
  /** Fired when the user appears done speaking. */
  onSpeechEnd: () => void;
};

/** Conservative defaults: quiet speech hovers around RMS 0.02–0.05 on a
 *  typical mic; fans/rooms sit below 0.01. 1.6s covers natural pauses. */
export const SILENCE_DEFAULTS = {
  speechThreshold: 0.015,
  silenceMs: 1600,
  maxMs: 60_000,
} as const;

export class SilenceDetector {
  private readonly speechThreshold: number;
  private readonly silenceMs: number;
  private readonly maxMs: number;
  private readonly onSpeechEnd: () => void;
  private speechSeen = false;
  private lastSpeechAt = 0;
  private firstSpeechAt = 0;
  private startedAt = 0;
  /** Monotonic frame clock, in ms, fed by the caller (audio thread time). */
  private now = 0;
  private ended = false;

  constructor(opts: SilenceDetectorOptions) {
    this.speechThreshold = opts.speechThreshold ?? SILENCE_DEFAULTS.speechThreshold;
    this.silenceMs = opts.silenceMs ?? SILENCE_DEFAULTS.silenceMs;
    this.maxMs = opts.maxMs ?? SILENCE_DEFAULTS.maxMs;
    this.onSpeechEnd = opts.onSpeechEnd;
  }

  /** Feed one audio frame. `rms` is the frame's root-mean-square level (0..1),
   *  `frameMs` its duration. Frames are assumed contiguous and in order. */
  feed(rms: number, frameMs: number): void {
    if (this.ended) return;
    this.now += frameMs;
    if (this.startedAt === 0) this.startedAt = this.now;
    const isSpeech = rms >= this.speechThreshold;
    if (isSpeech) {
      if (!this.speechSeen) {
        this.speechSeen = true;
        this.firstSpeechAt = this.now;
      }
      this.lastSpeechAt = this.now;
      // Hard cap: a runaway recording (user walked away) must not run forever.
      if (this.maxMs > 0 && this.now - this.firstSpeechAt >= this.maxMs) {
        this.ended = true;
        this.onSpeechEnd();
      }
      return;
    }
    if (!this.speechSeen) return;
    const quietMs = this.now - this.lastSpeechAt;
    if (quietMs >= this.silenceMs) {
      this.ended = true;
      this.onSpeechEnd();
    }
  }

  /** True once the detector has fired (stops accepting frames). */
  get hasEnded(): boolean {
    return this.ended;
  }

  /** True after speech has been observed at least once. */
  get hasSpeech(): boolean {
    return this.speechSeen;
  }
}

/** RMS level of a Float32 PCM frame (0..1). */
export function frameRms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i];
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}
