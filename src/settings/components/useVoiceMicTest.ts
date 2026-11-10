import { createOpenAI } from "@ai-sdk/openai";
import { experimental_transcribe as transcribe } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { getKey } from "@/modules/ai/lib/keyring";
import { encodeWav, transcribeLocal } from "@/modules/ai/lib/voiceTts";
import { usePreferencesStore } from "@/modules/settings/preferences";

/**
 * Settings-panel MIC TEST (2026-11-01) — the STT sibling of the TTS panels'
 * "Test voice" button. Gives every speech-to-text engine card the SAME test
 * affordance: click "Test mic", speak, click "Stop & transcribe", and the
 * transcript the engine heard appears under the button.
 *
 * A deliberately TRIMMED twin of the composer's useWhisperRecording:
 *   - same routes (api → OpenAI whisper; assemblyai → Sync STT; local →
 *     PCM tap → WAV → whisper.cpp; browser → WebView SpeechRecognition),
 *     same MIME candidates, same getUserMedia timeout;
 *   - but manual start/stop only (no silence detector, no auto-submit,
 *     no composer coupling) — a settings test row, not an input surface.
 *
 * The key is read lazily per call from the OS keyring (settings window
 * safe), and the transcript/error surface as state the panel renders.
 */

type MicState = "idle" | "recording" | "transcribing";

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

/** Same cap as the composer hook: an unanswered permission prompt must not
 *  hang the test button forever. */
const GET_MEDIA_TIMEOUT_MS = 8_000;
/** Cap on one cloud transcription round-trip for a short clip. */
const TRANSCRIBE_TIMEOUT_MS = 45_000;
/** Local whisper.cpp can be slower on CPU — same cap as the composer. */
const LOCAL_TRANSCRIBE_TIMEOUT_MS = 120_000;

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

/** Race a promise against a timeout so a hanging call can't wedge the row. */
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

async function transcribeViaOpenAi(blob: Blob, model: string): Promise<string> {
  const key = await getKey("openai");
  if (!key) {
    throw new Error("OpenAI STT needs an API key (Settings → Models).");
  }
  const openai = createOpenAI({ apiKey: key });
  const buf = new Uint8Array(await blob.arrayBuffer());
  const { text } = await transcribe({
    model: openai.transcription(model || "whisper-1"),
    audio: buf,
  });
  return text;
}

const hasSpeechRecognition =
  typeof window !== "undefined" &&
  !!((window as { SpeechRecognition?: unknown }).SpeechRecognition ||
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition);

export function useVoiceMicTest() {
  const sttMode = usePreferencesStore((s) => s.voiceSttMode);
  const sttApiModel = usePreferencesStore((s) => s.voiceSttApiModel);
  const [state, setState] = useState<MicState>("idle");
  const [transcript, setTranscript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Ref-mirrors: the route is chosen at START; stop must use the SAME route
  // even if the user flips the mode card mid-recording.
  const modeRef = useRef(sttMode);
  modeRef.current = sttMode;
  const modelRef = useRef(sttApiModel);
  modelRef.current = sttApiModel;

  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  // Local route: raw PCM tap → WAV, encoded at stop (same as the composer).
  const ctxRef = useRef<AudioContext | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const pcmRef = useRef<Float32Array[]>([]);
  // Browser route: WebView SpeechRecognition (no TS lib types).
  const speechRef = useRef<{ start: () => void; stop: () => void } | null>(null);
  const speechTextRef = useRef("");

  const micCaptureSupported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";
  const supported =
    sttMode === "browser" ? hasSpeechRecognition : micCaptureSupported;

  const cleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    try {
      procRef.current?.disconnect();
    } catch {
      /* best effort */
    }
    procRef.current = null;
    try {
      void ctxRef.current?.close();
    } catch {
      /* best effort */
    }
    ctxRef.current = null;
  }, []);

  // Teardown on unmount: a recording must never outlive the section.
  useEffect(() => {
    return () => {
      cleanup();
      try {
        if (recRef.current && recRef.current.state !== "inactive") {
          recRef.current.stop();
        }
      } catch {
        /* best effort */
      }
      recRef.current = null;
      try {
        speechRef.current?.stop();
      } catch {
        /* best effort */
      }
      speechRef.current = null;
    };
  }, [cleanup]);

  const fail = useCallback(
    (msg: string) => {
      cleanup();
      setError(msg);
      setState("idle");
    },
    [cleanup],
  );

  const deliver = useCallback((text: string) => {
    setTranscript(text);
    setState("idle");
  }, []);

  /** Stop the local route: flush PCM → WAV → whisper.cpp. */
  const stopLocal = useCallback(async () => {
    const ctx = ctxRef.current;
    const chunks = pcmRef.current;
    pcmRef.current = [];
    cleanup();
    const sampleRate = ctx?.sampleRate ?? 16000;
    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (total === 0) {
      setState("idle");
      return;
    }
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    const wav = encodeWav(merged, sampleRate);
    if (wav.size <= 44) {
      setState("idle");
      return;
    }
    setState("transcribing");
    try {
      const text = await withTimeout(
        transcribeLocal(wav),
        LOCAL_TRANSCRIBE_TIMEOUT_MS,
        "Local transcription timed out",
      );
      deliver(text.trim());
    } catch (e) {
      fail(
        (e as Error)?.message
          ? `Local transcription failed: ${(e as Error).message}`
          : "Local transcription failed — is the engine installed?",
      );
    }
  }, [cleanup, deliver, fail]);

  /** Browser route: WebView SpeechRecognition, finals accumulate until stop. */
  const startBrowser = useCallback(() => {
    const Ctor =
      (window as { SpeechRecognition?: new () => never }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => never })
        .webkitSpeechRecognition;
    if (!Ctor) {
      fail("Speech recognition isn't available in this WebView.");
      return;
    }
    const sr = new Ctor() as unknown as {
      continuous: boolean;
      interimResults: boolean;
      lang: string;
      start: () => void;
      stop: () => void;
      onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean } & { 0: { transcript: string } }> }) => void) | null;
      onend: (() => void) | null;
      onerror: ((e: { error?: string }) => void) | null;
    };
    sr.continuous = true;
    sr.interimResults = false;
    sr.lang = navigator.language || "en-US";
    speechTextRef.current = "";
    sr.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) speechTextRef.current += r[0].transcript + " ";
      }
    };
    sr.onend = () => {
      speechRef.current = null;
      deliver(speechTextRef.current.trim());
    };
    sr.onerror = (e) => {
      const code = String(e?.error ?? "");
      fail(
        /not-allowed|notallowed|service-not-allowed|audio-capture/i.test(code)
          ? "Microphone permission denied. Enable mic access in your OS / WebView settings."
          : code
            ? `Speech recognition error: ${code}`
            : "Speech recognition failed.",
      );
    };
    try {
      sr.start();
      speechRef.current = sr;
      setState("recording");
    } catch (e) {
      fail(`Could not start speech recognition: ${String(e)}`);
    }
  }, [deliver, fail]);

  /** api + assemblyai routes: MediaRecorder capture, transcribe on stop. */
  const startRecorder = useCallback(async () => {
    let stream: MediaStream;
    try {
      stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ audio: true }),
        GET_MEDIA_TIMEOUT_MS,
        "Timed out waiting for microphone access",
      );
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      fail(
        /permission|not\s*allowed|denied|securityerror|notfound|not.?captured|audio.?capture/i.test(
          msg,
        )
          ? "Microphone permission denied. Enable mic access for this app in your OS / WebView settings."
          : `Could not start microphone: ${msg}`,
      );
      return;
    }
    streamRef.current = stream;
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
      cleanup();
      if (blob.size === 0) {
        setState("idle");
        return;
      }
      setState("transcribing");
      try {
        const text =
          modeRef.current === "assemblyai"
            ? await withTimeout(
                (await import("@/modules/ai/lib/assemblyai"))
                  .transcribeViaAssemblyAi(blob),
                TRANSCRIBE_TIMEOUT_MS,
                "Transcription timed out",
              )
            : await withTimeout(
                transcribeViaOpenAi(blob, modelRef.current),
                TRANSCRIBE_TIMEOUT_MS,
                "Transcription timed out",
              );
        deliver(text.trim());
      } catch (e) {
        fail(
          (e as Error)?.message
            ? `Transcription failed: ${(e as Error).message}`
            : "Transcription failed.",
        );
      }
    };
    recRef.current = rec;
    try {
      rec.start();
      setState("recording");
    } catch (e) {
      cleanup();
      fail(`Could not start the recorder: ${String(e)}`);
    }
  }, [cleanup, deliver, fail]);

  /** Local route: mic → ScriptProcessor PCM tap (16 kHz), WAV at stop. */
  const startLocal = useCallback(async () => {
    let stream: MediaStream;
    try {
      stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ audio: true }),
        GET_MEDIA_TIMEOUT_MS,
        "Timed out waiting for microphone access",
      );
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      fail(
        /permission|not\s*allowed|denied|securityerror|notfound|not.?captured|audio.?capture/i.test(
          msg,
        )
          ? "Microphone permission denied. Enable mic access for this app in your OS / WebView settings."
          : `Could not start microphone: ${msg}`,
      );
      return;
    }
    streamRef.current = stream;
    // Default device rate — a forced 16 kHz context makes Windows resample
    // the live WASAPI capture path (system-wide input stutter while the mic
    // is open; see useWhisperRecording.ts for the full rationale). encodeWav
    // resamples to 16 kHz at stop regardless of the context rate.
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    procRef.current = proc;
    pcmRef.current = [];
    proc.onaudioprocess = (e) => {
      // Copy — the buffer is reused by the audio thread.
      pcmRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    src.connect(proc);
    // ScriptProcessor requires a destination to pump; a muted gain avoids
    // speaker feedback while keeping the graph live.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    proc.connect(mute);
    mute.connect(ctx.destination);
    setState("recording");
  }, [cleanup, fail]);

  const start = useCallback(async () => {
    setError(null);
    setTranscript(null);
    if (modeRef.current === "browser") {
      startBrowser();
      return;
    }
    if (!micCaptureSupported) {
      fail("Mic test isn't supported in this WebView.");
      return;
    }
    if (modeRef.current === "local") {
      await startLocal();
    } else {
      await startRecorder();
    }
  }, [startBrowser, startLocal, startRecorder, fail, micCaptureSupported]);

  const stop = useCallback(() => {
    const sr = speechRef.current;
    if (sr) {
      try {
        sr.stop(); // onend delivers the accumulated transcript
      } catch {
        fail("Speech recognition failed to stop.");
      }
      return;
    }
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop(); // onstop transcribes
      } catch {
        fail("Could not stop the recorder.");
      }
      return;
    }
    if (ctxRef.current) {
      void stopLocal();
    }
  }, [fail, stopLocal]);

  const toggle = useCallback(() => {
    if (state === "idle") void start();
    else if (state === "recording") stop();
    // "transcribing" — the button is disabled; nothing to toggle.
  }, [state, start, stop]);

  return {
    state,
    transcript,
    error,
    supported,
    toggle,
  };
}
