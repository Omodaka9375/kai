import { createOpenAI } from "@ai-sdk/openai";
import { experimental_transcribe as transcribe } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStore } from "../store/chatStore";

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
/** Cap on one whisper transcription round-trip, so `transcribing` can never
 *  stick (the mic button stays disabled while `transcribing`). */
const TRANSCRIBE_TIMEOUT_MS = 45_000;
/** If the Speech API fires neither `onend` nor `onerror` after starting (e.g.
 *  a permission prompt is never answered), force a stop so the toggle resets. */
const SPEECH_WATCHDOG_MS = 20_000;

function pickMime(): string | undefined {
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
  const { text } = await transcribe({
    model: openai.transcription("whisper-1"),
    audio: buf,
  });
  return text;
}

/** Check if the Browser Speech Recognition API is available (WebView2/Chromium). */
const hasSpeechRecognition =
  typeof window !== "undefined" &&
  !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

type SpeechRec = any; // WebView2 SpeechRecognition — no TS lib types

function createSpeechRecognition(): SpeechRec | null {
  const Ctor =
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
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
}: {
  onResult: (text: string) => void;
}) {
  const apiKey = useChatStore((s) => s.apiKeys.openai);
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const speechRef = useRef<SpeechRec | null>(null);
  const startingRef = useRef(false);
  /** Ensure a recording can't overrun an unanswered permission / stuck API. */
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Keep the latest transcript callback without re-creating closures. */
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

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
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const stop = useCallback(() => {
    startingRef.current = false;
    clearWatchdog();
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
    }
  }, [fail]);

  const startSpeechApi = useCallback(() => {
    const sr = createSpeechRecognition();
    if (!sr) {
      fail("Speech recognition isn't available in this WebView.");
      return;
    }
    speechRef.current = sr;
    let transcript = "";
    let settled = false;
    const reset = () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      speechRef.current = null;
      startingRef.current = false;
      setState("idle");
    };
    sr.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          transcript += e.results[i][0].transcript + " ";
        }
      }
    };
    sr.onend = () => {
      const text = transcript.trim();
      reset();
      if (text) onResultRef.current(text);
    };
    sr.onerror = (e: any) => {
      const code = String((e as any)?.error ?? "");
      console.error("SpeechRecognition error:", code);
      if (/not-allowed|notallowed|service-not-allowed|audio-capture/i.test(code)) {
        setError("Microphone permission denied. Enable mic access in your OS / WebView settings.");
      } else {
        setError(code ? `Speech recognition error: ${code}` : "Speech recognition failed.");
      }
      const text = transcript.trim();
      reset();
      if (text) onResultRef.current(text);
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
  }, [fail]);

  const startWhisper = useCallback(async () => {
    if (!apiKey) {
      fail("Whisper voice input needs an OpenAI API key (Settings → AI).");
      return;
    }
    try {
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ audio: true }),
        GET_MEDIA_TIMEOUT_MS,
        "Timed out waiting for microphone access",
      );
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
        teardownStream();
        if (blob.size === 0) {
          setState("idle");
          return;
        }
        setState("transcribing");
        try {
          const text = await withTimeout(
            transcribeBlob(blob, apiKey),
            TRANSCRIBE_TIMEOUT_MS,
            "Speech transcription timed out",
          );
          if (text.trim()) onResultRef.current(text.trim());
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
  }, [apiKey, fail, teardownStream]);

  const start = useCallback(() => {
    if (startingRef.current || state !== "idle") return;
    if (!supported) {
      setError("Voice input isn't supported in this WebView.");
      return;
    }
    setError(null);
    startingRef.current = true;
    if (useWhisper) {
      // startWhisper is async and catches its own errors; keep it non-blocking.
      void startWhisper();
    } else {
      startSpeechApi();
    }
  }, [state, supported, useWhisper, startWhisper, startSpeechApi]);

  const clearError = useCallback(() => setError(null), []);

  useEffect(() => {
    return () => {
      clearWatchdog();
      recRef.current?.stop();
      speechRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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