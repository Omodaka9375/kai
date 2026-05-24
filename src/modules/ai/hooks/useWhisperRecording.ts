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

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
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

export function useWhisperRecording({
  onResult,
}: {
  onResult: (text: string) => void;
}) {
  const apiKey = useChatStore((s) => s.apiKeys.openai);
  const [state, setState] = useState<State>("idle");
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const speechRef = useRef<SpeechRec | null>(null);

  const useWhisper = !!apiKey;
  const supported =
    typeof navigator !== "undefined" &&
    (hasSpeechRecognition ||
      (!!navigator.mediaDevices?.getUserMedia &&
        typeof MediaRecorder !== "undefined"));

  const teardownStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const stop = useCallback(() => {
    if (speechRef.current) {
      speechRef.current.stop();
      return;
    }
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);

  const startSpeechApi = useCallback(() => {
    const sr = createSpeechRecognition();
    if (!sr) return;
    speechRef.current = sr;
    let transcript = "";
    sr.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          transcript += e.results[i][0].transcript + " ";
        }
      }
    };
    sr.onend = () => {
      speechRef.current = null;
      setState("idle");
      const text = transcript.trim();
      if (text) onResult(text);
    };
    sr.onerror = (e: any) => {
      console.error("SpeechRecognition error:", (e as any).error);
      speechRef.current = null;
      setState("idle");
      const text = transcript.trim();
      if (text) onResult(text);
    };
    sr.start();
    setState("recording");
  }, [onResult]);

  const startWhisper = useCallback(async () => {
    if (!apiKey) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
          const text = await transcribeBlob(blob, apiKey);
          if (text.trim()) onResult(text.trim());
        } catch (e) {
          console.error("whisper.transcribe", e);
        } finally {
          setState("idle");
        }
      };
      recRef.current = rec;
      rec.start();
      setState("recording");
    } catch (e) {
      console.error("whisper.getUserMedia", e);
      teardownStream();
      setState("idle");
    }
  }, [apiKey, onResult]);

  const start = useCallback(async () => {
    if (state !== "idle" || !supported) return;
    if (useWhisper) {
      await startWhisper();
    } else {
      startSpeechApi();
    }
  }, [state, supported, useWhisper, startWhisper, startSpeechApi]);

  useEffect(() => {
    return () => {
      recRef.current?.stop();
      speechRef.current?.stop();
      teardownStream();
    };
  }, []);

  return {
    state,
    recording: state === "recording",
    transcribing: state === "transcribing",
    start,
    stop,
    supported,
    /** Always true now — Browser Speech API works without a key. */
    hasKey: true,
  };
}
