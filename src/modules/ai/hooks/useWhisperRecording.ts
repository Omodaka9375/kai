import { createOpenAI } from "@ai-sdk/openai";
import { experimental_transcribe as transcribe } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStore } from "../store/chatStore";
import { encodeWav, transcribeLocal } from "../lib/voiceTts";
import { frameRms, SilenceDetector, trimTrailingSilence } from "../lib/silence";
import { usePreferencesStore } from "@/modules/settings/preferences";

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

/** How long to wait for the browser to grant a mic stream before giving up.
 *  A WebView2 / preview host that never answers the permission prompt leaves
 *  `getUserMedia` pending forever — without this cap the toggle hangs and the
 *  voice UI appears broken. */
const GET_MEDIA_TIMEOUT_MS = 8_000;
/** Cap on one cloud transcription round-trip for a short clip. */
const TRANSCRIBE_TIMEOUT_BASE_MS = 45_000;
/** If the Speech API fires neither `onend` nor `onerror` after starting (e.g.
 *  a permission prompt is never answered), force a stop so the toggle resets. */
const SPEECH_WATCHDOG_MS = 20_000;function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

/** Race a promise against a timeout so a hanging native call can't wedge the UI. */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function transcribeBlob(blob: Blob, apiKey: string): Promise<string> {
  const openai = createOpenAI({ apiKey });
  const buf = new Uint8Array(await blob.arrayBuffer());
  const modelId = usePreferencesStore.getState().voiceSttApiModel || "whisper-1";
  const { text } = await transcribe({
    model: openai.transcription(modelId),
    audio: buf,
  });
  return text;
}

/** Minimal shape of the (vendor-prefixed) Web Speech Recognition API as
 *  exposed by WebView2/Chromium. TypeScript's DOM lib does not ship these
 *  types, so only the members this hook uses are declared here. */
interface SpeechResultItem {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: { transcript: string };
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    [index: number]: SpeechResultItem;
  };
}

interface SpeechRecognitionErrorEventLike {
  readonly error?: string;
}

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface WindowWithSpeech {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

/** Check if the Browser Speech Recognition API is available (WebView2/Chromium). */
const hasSpeechRecognition = speechCtor() != null;

function speechCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as WindowWithSpeech;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

function createSpeechRecognition(): SpeechRecognitionLike | null {
  const Ctor = speechCtor();
  if (!Ctor) return null;
  const sr = new Ctor();
  sr.continuous = true;
  sr.interimResults = false;
  sr.lang = navigator.language || "en-US";
  return sr;
}

type State = "idle" | "recording" | "transcribing";

function looksLikeDenied(msg: string): boolean {
  return /permission|not\s*allowed|denied|securityerror|notfound|not.?captured|audio.?capture/i.test(
    msg,
  );
}

export function useWhisperRecording({
  onResult,
  autoSubmit,
  onAutoSubmit,
}: {
  onResult: (text: string) => void;
  /** When true, a finished transcription also fires `onAutoSubmit` —
   *  hands-free voice: the transcript is sent to the agent without a
   *  manual Enter. The composer keeps this fresh per render. */
  autoSubmit?: boolean;
  /** Fired with the final transcript after `onResult` when `autoSubmit`
   *  is on. The composer composes it with any pre-typed input and submits. */
  onAutoSubmit?: (transcript: string) => void;
}) {
  const apiKey = useChatStore((s) => s.apiKeys.openai);
  const sttMode = usePreferencesStore((s) => s.voiceSttMode);
  const endMode = usePreferencesStore((s) => s.voiceSttEndMode);
  // Ref-mirror: startWhisper/startLocalWhisper are memoized callbacks whose
  // dep arrays don't include the detector builders — a closure over `endMode`
  // there would go stale after a settings change and silently disable the
  // detector. Reading through a ref keeps every closure current.
  const endModeRef = useRef(endMode);
  endModeRef.current = endMode;
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const speechRef = useRef<SpeechRecognitionLike | null>(null);
  // Local (whisper.cpp) route: raw PCM tap → WAV, encoded at stop.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const pcmRef = useRef<Float32Array[]>([]);
  /** Late-bound stop for the local route — `stop` is declared before the
   *  local callbacks; a ref breaks the TDZ cycle without reordering. */
  const stopLocalRef = useRef<(() => void) | null>(null);
  const startingRef = useRef(false);
  /** Ensure a recording can't overrun an unanswered permission / stuck API. */
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Keep the latest transcript callback without re-creating closures. */
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  /** Latest auto-submit flag + callback — same freshness pattern. */
  const autoSubmitRef = useRef(!!autoSubmit);
  autoSubmitRef.current = !!autoSubmit;
  const onAutoSubmitRef = useRef(onAutoSubmit);
  onAutoSubmitRef.current = onAutoSubmit;
  /** Silence auto-end (Voice → "Auto" end mode). Local + API routes feed the
   *  live mic levels into a SilenceDetector that calls stop() once the user
   *  appears done speaking. Browser STT has no audio access — no detector. */
  const detectorRef = useRef<SilenceDetector | null>(null);
  /** Late-bound stop for the silence detector (stop is defined below). */
  const stopRef = useRef<(() => void) | null>(null);
  /** Cleanup for the parallel detector audio tap (API route). */
  const detachTapRef = useRef<(() => void) | null>(null);

  /** Build a fresh detector armed to stop this recording. */
  const makeDetector = useCallback(() => {
    if (endModeRef.current !== "auto") return null;
    const d = new SilenceDetector({
      onSpeechEnd: () => {
        // Fire on a microtask so a throwing stop() can't break the audio thread.
        try {
          stopRef.current?.();
        } catch {
          // ignore — user can still click stop
        }
      },
    });
    detectorRef.current = d;
    return d;
  }, []);

  /** Shared PCM level tap builder: feeds the detector from any route's
   *  audio graph. Returns a cleanup that tears the tap down. */
  const attachDetectorTap = useCallback(
    (stream: MediaStream) => {
      const detector = makeDetector();
      if (!detector) return () => {};
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      proc.onaudioprocess = (e) => {
        const frame = e.inputBuffer.getChannelData(0);
        // ScriptProcessor frames are ~2048 samples at the context rate —
        // frameMs derived from the actual rate, not hardcoded.
        detector.feed(frameRms(frame), (frame.length / ctx.sampleRate) * 1000);
      };
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      return () => {
        try {
          proc.disconnect();
          src.disconnect();
          mute.disconnect();
          void ctx.close();
        } catch {
          // ignore — best effort
        }
      };
    },
    [makeDetector],
  );

  /** Deliver a final transcript: always populate, then auto-submit if on. */
  const deliver = useCallback((text: string) => {
    onResultRef.current(text);
    if (autoSubmitRef.current) onAutoSubmitRef.current?.(text);
  }, []);

  const assemblyAiKey = useChatStore((s) => s.apiKeys.assemblyai);
  const useWhisper = !!apiKey;
  const supported =
    typeof navigator !== "undefined" &&
    (hasSpeechRecognition ||
      (!!navigator.mediaDevices?.getUserMedia &&
        typeof MediaRecorder !== "undefined"));

  const clearWatchdog = () => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  };

  const fail = useCallback((msg: string) => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    let sr = speechRef.current;
    if (sr) {
      try {
        sr.stop();
      } catch {
        // ignore — onend/onerror handles cleanup
      }
      sr = null;
    }
    speechRef.current = null;
    startingRef.current = false;
    clearWatchdog();
    setError(msg);
    setState("idle");
  }, []);

  const teardownStream = useCallback(() => {
    detachTapRef.current?.();
    detachTapRef.current = null;
    detectorRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    // Local route teardown: disconnect the tap and close the context.
    try {
      procRef.current?.disconnect();
      audioCtxRef.current?.close();
    } catch {
      // ignore — best effort
    }
    procRef.current = null;
    audioCtxRef.current = null;
  }, []);

  const stop = useCallback(() => {
    startingRef.current = false;
    clearWatchdog();
    detectorRef.current = null; // fired or manual — detector is done
    const sr = speechRef.current;
    if (sr) {
      // onend/onerror triggers the idle reset + transcript flush.
      try {
        sr.stop();
      } catch {
        fail("Speech recognition failed to stop.");
      }
      return;
    }
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop(); // onstop triggers transcription
      } catch {
        fail("Could not stop the recorder.");
      }
      return;
    }
    // Local route: PCM tap active — flush and transcribe.
    if (audioCtxRef.current) {
      void stopLocalRef.current?.();
    }
  }, [fail]);

  stopRef.current = stop;

  const startSpeechApi = useCallback(() => {
    const sr = createSpeechRecognition();
    if (!sr) {
      fail("Speech recognition isn't available in this WebView.");
      return;
    }
    speechRef.current = sr;
    let transcript = "";
    let settled = false;
    // DELIVER-ONCE GUARD (2026-11-06 voice complaint: "repeated same
    // sentence many times"): per the Web Speech spec onend fires after
    // onerror, and BOTH handlers used to deliver the partial transcript -
    // a transient mid-capture error (no-speech, network, audio-capture)
    // delivered TWICE, and with hands-free auto-submit both copies landed
    // in the chat. One capture, one delivery.
    let delivered = false;
    const reset = () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      speechRef.current = null;
      startingRef.current = false;
      setState("idle");
    };
    // RESULT WATERMARK: some WebView2/OS recognizers resend results with a
    // RESET resultIndex (e.g. after a network retry), re-flagging finals
    // the loop below already consumed - appending the same sentences into
    // `transcript` again (one message with the sentence repeated many
    // times). Never consume a result index twice; a negative reset still
    // appends (engines that never set the field) because indices are
    // only trusted when they advance.
    let lastResultIndex = -1;
    sr.onresult = (e: SpeechRecognitionEventLike) => {
      const start = typeof e.resultIndex === "number" && e.resultIndex >= 0
        ? e.resultIndex
        : 0;
      if (start <= lastResultIndex && lastResultIndex >= 0) return; // replay
      if (start > lastResultIndex) lastResultIndex = start;
      for (let i = start; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          transcript += e.results[i][0].transcript + " ";
        }
      }
    };
    sr.onend = () => {
      const text = transcript.trim();
      reset();
      if (text && !delivered) {
        delivered = true;
        deliver(text);
      }
    };
    sr.onerror = (e: SpeechRecognitionErrorEventLike) => {
      const code = String(e?.error ?? "");
      console.error("SpeechRecognition error:", code);
      if (/not-allowed|notallowed|service-not-allowed|audio-capture/i.test(code)) {
        setError("Microphone permission denied. Enable mic access in your OS / WebView settings.");
      } else {
        setError(code ? `Speech recognition error: ${code}` : "Speech recognition failed.");
      }
      const text = transcript.trim();
      reset();
      if (text && !delivered) {
        delivered = true;
        deliver(text);
      }
    };
    try {
      sr.start();
      setState("recording");
      // Shield: if neither onend nor onerror arrives (unanswered permission
      // prompt / broken recognizer), force a stop so the toggle resets.
      clearWatchdog();
      watchdogRef.current = setTimeout(() => {
        try {
          sr.stop();
        } catch {
          fail("Speech recognition stalled.");
        }
      }, SPEECH_WATCHDOG_MS);
    } catch (e) {
      console.error("SpeechRecognition start", e);
      reset();
      setError(looksLikeDenied(String(e)) ? "Microphone permission denied." : "Could not start speech recognition.");
    }
  }, [fail, deliver]);

  /** AssemblyAI Sync-STT route: same MediaRecorder capture as the OpenAI
   *  route (WebM/Opus accepted as-is by the Sync API - no transcoding), one
   *  multipart call, transcript in the same response. */
  const startAssemblyAi = useCallback(
    async () => {
      if (!assemblyAiKey) {
        fail("AssemblyAI voice input needs an AssemblyAI API key (Settings \u2192 Models).");
        return;
      }
      try {
        const stream = await withTimeout(
          navigator.mediaDevices.getUserMedia({ audio: true }),
          GET_MEDIA_TIMEOUT_MS,
          "Timed out waiting for microphone access",
        );
        streamRef.current = stream;
        detachTapRef.current?.();
        detachTapRef.current = attachDetectorTap(stream);
        const mimeType = pickMime();
        const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        chunksRef.current = [];
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        rec.onstop = async () => {
          const blob = new Blob(chunksRef.current, {
            type: rec.mimeType || "audio/webm",
          });
          chunksRef.current = [];
          detachTapRef.current?.();
          detachTapRef.current = null;
          teardownStream();
          if (blob.size === 0) {
            setState("idle");
            return;
          }
          setState("transcribing");
          try {
            const { transcribeViaAssemblyAi } = await import("../lib/assemblyai");
            const text = await withTimeout(
              transcribeViaAssemblyAi(blob),
              TRANSCRIBE_TIMEOUT_BASE_MS,
              "Speech transcription timed out",
            );
            if (text.trim()) deliver(text.trim());
          } catch (e) {
            console.error("assemblyai.transcribe", e);
            setError(
              typeof (e as Error)?.message === "string" &&
                String((e as Error).message).length > 0
                ? `Transcription failed: ${String((e as Error).message)}`
                : "Transcription failed.",
            );
          } finally {
            setState("idle");
          }
        };
        recRef.current = rec;
        rec.start();
        startingRef.current = false;
        clearWatchdog();
        setState("recording");
      } catch (e) {
        const msg = typeof (e as Error)?.message === "string"
          ? String((e as Error).message)
          : String(e);
        teardownStream();
        startingRef.current = false;
        setError(
          looksLikeDenied(msg)
            ? "Microphone permission denied. Enable mic access for this app in your OS / WebView settings."
            : `Could not start microphone: ${msg}`,
        );
        setState("idle");
      }
    },
    [assemblyAiKey, fail, teardownStream, deliver],
  );

  const startWhisper = useCallback(
    async () => {
      if (!apiKey) {
        fail("Whisper voice input needs an OpenAI API key (Settings → AI).");
        return;
      }
      const cloudKey = apiKey ?? "";
      try {
        const stream = await withTimeout(
          navigator.mediaDevices.getUserMedia({ audio: true }),
          GET_MEDIA_TIMEOUT_MS,
          "Timed out waiting for microphone access",
        );
        streamRef.current = stream;
        // API route: parallel muted tap feeds the silence detector.
        detachTapRef.current?.();
        detachTapRef.current = attachDetectorTap(stream);
        const mimeType = pickMime();
        const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        chunksRef.current = [];
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        rec.onstop = async () => {
          const blob = new Blob(chunksRef.current, {
            type: rec.mimeType || "audio/webm",
          });
          chunksRef.current = [];
          detachTapRef.current?.();
          detachTapRef.current = null;
          teardownStream();
          if (blob.size === 0) {
            setState("idle");
            return;
          }
          setState("transcribing");
          try {
            const text = await withTimeout(
              transcribeBlob(blob, cloudKey),
              TRANSCRIBE_TIMEOUT_BASE_MS,
              "Speech transcription timed out",
            );
            if (text.trim()) deliver(text.trim());
          } catch (e) {
            console.error("whisper.transcribe", e);
            setError(
              typeof (e as Error)?.message === "string" &&
                String((e as Error).message).length > 0
                ? `Transcription failed: ${String((e as Error).message)}`
                : "Transcription failed.",
            );
          } finally {
            setState("idle");
          }
        };
        recRef.current = rec;
        rec.start();
        startingRef.current = false;
        clearWatchdog();
        setState("recording");
      } catch (e) {
        const msg = typeof (e as Error)?.message === "string"
          ? String((e as Error).message)
          : String(e);
        teardownStream();
        startingRef.current = false;
        setError(
          looksLikeDenied(msg)
            ? "Microphone permission denied. Enable mic access for this app in your OS / WebView settings."
            : `Could not start microphone: ${msg}`,
        );
        setState("idle");
      }
    },
    [apiKey, fail, teardownStream, deliver],
  );

  /** Local whisper.cpp route: mic → ScriptProcessor PCM tap → WAV → Rust
   *  voice_transcribe → transcript. No key needed; engine must be installed
   *  (Settings → Voice). */
  const startLocalWhisper = useCallback(async () => {
    try {
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ audio: true }),
        GET_MEDIA_TIMEOUT_MS,
        "Timed out waiting for microphone access",
      );
      streamRef.current = stream;
      const ctx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      procRef.current = proc;
      pcmRef.current = [];
      // Silence auto-end (local route): same PCM tap feeds the detector.
      const detector = makeDetector();
      proc.onaudioprocess = (e) => {
        // Copy — the buffer is reused by the audio thread.
        const copy = new Float32Array(e.inputBuffer.getChannelData(0));
        pcmRef.current.push(copy);
        if (detector) {
          detector.feed(frameRms(copy), (copy.length / ctx.sampleRate) * 1000);
        }
      };
      src.connect(proc);
      // ScriptProcessor requires a destination to pump; a muted gain avoids
      // speaker feedback while keeping the graph live.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      proc.connect(mute);
      mute.connect(ctx.destination);
      startingRef.current = false;
      clearWatchdog();
      setState("recording");
    } catch (e) {
      const msg = typeof (e as Error)?.message === "string"
        ? String((e as Error).message)
        : String(e);
      teardownStream();
      startingRef.current = false;
      setError(
        looksLikeDenied(msg)
          ? "Microphone permission denied. Enable mic access for this app in your OS / WebView settings."
          : `Could not start microphone: ${msg}`,
      );
      setState("idle");
    }
  }, [teardownStream]);

  /** Stop the local route: flush PCM → WAV → transcribe. FLUSH-ONCE: a
   * second stop (silence-fire racing the manual toggle, or a stray window
   * event) must not re-run the flush - teardownStream() already nulls the
   * context, and a double deliver() would put the same transcript in the
   * chat twice (2026-11-06 voice complaint class). */
  const stopLocalWhisper = useCallback(async () => {
    const ctx = audioCtxRef.current;
    if (!ctx) return; // already flushed (or never started)
    const chunks = pcmRef.current;
    pcmRef.current = [];
    teardownStream();
    const sampleRate = ctx?.sampleRate ?? 16000;
    if (chunks.length === 0) {
      setState("idle");
      return;
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    // TRIM THE DETECTOR'S OWN TAIL: the silence detector fires only after
    // ~1.6s of quiet frames have ALREADY been pushed into this buffer, so
    // every auto-ended capture ends with that dead air - the textbook
    // whisper.cpp repetition-loop trigger ("same sentence many times",
    // intermittent: depends on the audio). Cut it before encoding.
    const trimmed = trimTrailingSilence(merged, sampleRate);
    const wav = encodeWav(trimmed, sampleRate);
    if (wav.size <= 44) {
      setState("idle");
      return;
    }
    setState("transcribing");
    try {
      const text = await withTimeout(
        transcribeLocal(wav),
        120_000,
        "Local transcription timed out",
      );
      if (text.trim()) deliver(text.trim());
    } catch (e) {
      console.error("local stt", e);
      setError(
        typeof (e as Error)?.message === "string" && (e as Error).message
          ? `Local transcription failed: ${(e as Error).message}`
          : "Local transcription failed — is the engine installed in Settings → Voice?",
      );
    } finally {
      setState("idle");
    }
  }, [teardownStream, deliver]);
  stopLocalRef.current = () => void stopLocalWhisper();

  const start = useCallback(() => {
    if (startingRef.current || state !== "idle") return;
    if (!supported) {
      setError("Voice input isn't supported in this WebView.");
      return;
    }
    setError(null);
    startingRef.current = true;

    // Route by configured STT mode (freshest prefs each toggle):
    //   local      → whisper.cpp via WAV tap (needs engine, no key)
    //   assemblyai → AssemblyAI Sync STT (needs key; falls back to browser STT)
    //   api        → OpenAI whisper (needs key; falls back to browser STT)
    //   browser    → WebView SpeechRecognition (no key)
    if (sttMode === "local") {
      void startLocalWhisper();
    } else if (sttMode === "assemblyai" && !!assemblyAiKey) {
      void startAssemblyAi();
    } else if (sttMode === "api" && useWhisper) {
      // startWhisper is async and catches its own errors; keep non-blocking.
      void startWhisper();
    } else {
      startSpeechApi();
    }
  }, [state, supported, sttMode, useWhisper, assemblyAiKey, startWhisper, startAssemblyAi, startLocalWhisper, startSpeechApi]);

  const clearError = useCallback(() => setError(null), []);

  useEffect(() => {
    return () => {
      clearWatchdog();
      detachTapRef.current?.();
      detachTapRef.current = null;
      recRef.current?.stop();
      speechRef.current?.stop();
      try {
        procRef.current?.disconnect();
        audioCtxRef.current?.close();
      } catch {
        // ignore
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return {
    state,
    recording: state === "recording",
    transcribing: state === "transcribing",
    start,
    stop,
    supported,
    error,
    clearError,
    /** Always true now — Browser Speech API works without a key. */
    hasKey: true,
  };
}