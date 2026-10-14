import { Button } from "@/components/ui/button";
import {
  native,
  type VoiceStatus,
  type VoiceSetupEvent,
} from "@/modules/ai/lib/native";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setVoiceSttMode,
  setVoiceSttModel,
  setVoiceSttApiModel,
  setVoiceTtsMode,
  setVoiceTtsApiVoice,
  setVoiceTtsApiModel,
  setVoiceTtsLocalVoice,
  setVoiceSpeakReplies,
} from "@/modules/settings/store";
import { Channel } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

/** Local STT models (whisper.cpp quantized ggml — mirrors Rust STT_MODELS). */
const STT_MODELS = [
  { id: "tiny.en", label: "Tiny (English)", size: "31 MB", note: "fastest" },
  { id: "base.en", label: "Base (English)", size: "57 MB", note: "balanced" },
  { id: "small.en", label: "Small (English)", size: "181 MB", note: "most accurate" },
];

/** Local TTS voices (Piper — mirrors Rust TTS_VOICES). */
const TTS_VOICES = [
  { id: "en_US-lessac-medium", label: "Lessac (medium)", size: "60 MB" },
  { id: "en_US-amy-low", label: "Amy (low)", size: "60 MB" },
];

/** OpenAI STT models. */
const STT_API_MODELS = [
  { id: "whisper-1", label: "whisper-1" },
  { id: "gpt-4o-mini-transcribe", label: "gpt-4o-mini-transcribe" },
];

/** OpenAI TTS models + voices. */
const TTS_API_MODELS = [
  { id: "gpt-4o-mini-tts", label: "gpt-4o-mini-tts" },
  { id: "tts-1", label: "tts-1" },
  { id: "tts-1-hd", label: "tts-1-hd" },
];
const TTS_API_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer",
];

type SttMode = "api" | "local" | "browser";
type TtsMode = "off" | "api" | "local";

function ModeCard({
  active,
  title,
  description,
  onClick,
  disabled,
}: {
  active: boolean;
  title: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors ${
        active
          ? "border-primary bg-primary/10"
          : "border-border hover:bg-accent"
      } ${disabled ? "opacity-60" : ""}`}
    >
      <span className="text-[12.5px] font-medium">{title}</span>
      <span className="text-[11.5px] text-muted-foreground">{description}</span>
    </button>
  );
}

function Select({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: string }[];
  ariaLabel: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 rounded-md border border-border bg-background px-2 text-[12px] outline-none focus:border-primary"
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Progress({ ev }: { ev: VoiceSetupEvent }) {
  if (!ev) return null;
  if (ev.total > 0) {
    return (
      <div className="flex flex-col gap-1">
        <div className="h-1 w-56 overflow-hidden rounded-full bg-border">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${Math.round((ev.downloaded / ev.total) * 100)}%` }}
          />
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">
          {formatBytes(ev.downloaded)} / {formatBytes(ev.total)}
        </span>
      </div>
    );
  }
  return (
    <span className="text-[11.5px] text-muted-foreground">
      {ev.message ?? ev.phase}
    </span>
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function VoiceSection() {
  const prefs = usePreferencesStore();
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [busy, setBusy] = useState<"" | "stt" | "tts" | "remove">("");
  const [progress, setProgress] = useState<VoiceSetupEvent | null>(null);
  const [error, setError] = useState("");

  const refreshStatus = () => {
    void native.voiceStatus().then(setStatus).catch(() => setStatus(null));
  };
  useEffect(() => {
    refreshStatus();
  }, []);

  const onSetupStt = async (model: string) => {
    if (busy) return;
    setBusy("stt");
    setError("");
    setProgress(null);
    const onEvent = new Channel<VoiceSetupEvent>();
    onEvent.onmessage = (e) => setProgress(e);
    try {
      await native.voiceSetupStt(model, onEvent);
      refreshStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  const onSetupTts = async (voice: string) => {
    if (busy) return;
    setBusy("tts");
    setError("");
    setProgress(null);
    const onEvent = new Channel<VoiceSetupEvent>();
    onEvent.onmessage = (e) => setProgress(e);
    try {
      await native.voiceSetupTts(voice, onEvent);
      refreshStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  const onRemove = async () => {
    if (busy) return;
    setBusy("remove");
    setError("");
    try {
      await native.voiceRemoveLocal();
      refreshStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  const sttMode = prefs.voiceSttMode;
  const ttsMode = prefs.voiceTtsMode;
  const setSttMode = (m: SttMode) => void setVoiceSttMode(m);
  const setTtsMode = (m: TtsMode) => void setVoiceTtsMode(m);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Voice"
        description="Speech-to-text for the composer mic, and text-to-speech for agent replies. Local engines run fully offline on your machine."
      />

      {/* ── Speech-to-text ── */}
      <div className="flex flex-col gap-2">
        <span className="text-[12.5px] font-semibold">Speech to text (mic input)</span>
        <div className="flex flex-col gap-1.5">
          <ModeCard
            active={sttMode === "api"}
            title="API (OpenAI)"
            description="Transcribes via your OpenAI key. Works everywhere, sends audio to OpenAI."
            onClick={() => setSttMode("api")}
          />
          <ModeCard
            active={sttMode === "local"}
            title="Local (whisper.cpp)"
            description="Runs whisper.cpp on your CPU. Fully offline. Click install below — engine (~9 MB) + model."
            onClick={() => setSttMode("local")}
          />
          <ModeCard
            active={sttMode === "browser"}
            title="Browser (WebView)"
            description="The WebView's built-in speech recognition. No key, no download — simplest."
            onClick={() => setSttMode("browser")}
          />
        </div>
      </div>

      {sttMode === "api" ? (
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted-foreground">STT model</span>
          <Select
            ariaLabel="API STT model"
            value={prefs.voiceSttApiModel}
            onChange={(v) => void setVoiceSttApiModel(v)}
            options={STT_API_MODELS}
          />
        </div>
      ) : null}

      {sttMode === "local" ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-muted-foreground">Model</span>
            <Select
              ariaLabel="Local STT model"
              value={prefs.voiceSttModel}
              onChange={(v) => void setVoiceSttModel(v)}
              options={STT_MODELS.map((m) => ({ id: m.id, label: `${m.label} — ${m.size} (${m.note})` }))}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy !== ""}
              onClick={() => void onSetupStt(prefs.voiceSttModel)}
            >
              {busy === "stt"
                ? "Downloading…"
                : status?.sttInstalled && status.sttModel === prefs.voiceSttModel
                  ? "Reinstall"
                  : "Install local STT"}
            </Button>
          </div>
          {status?.sttInstalled ? (
            <span className="text-[11.5px] text-emerald-500">
              Engine installed{status.sttModel ? ` — model: ${status.sttModel}` : " — no model yet"}
            </span>
          ) : (
            <span className="text-[11.5px] text-muted-foreground/70">
              Engine not installed — mic input falls back to Browser mode until installed.
            </span>
          )}
          {busy === "stt" && progress ? <Progress ev={progress} /> : null}
        </div>
      ) : null}

      {/* ── Text-to-speech ── */}
      <div className="flex flex-col gap-2">
        <span className="text-[12.5px] font-semibold">Text to speech (agent replies)</span>
        <div className="flex flex-col gap-1.5">
          <ModeCard
            active={ttsMode === "off"}
            title="Off"
            description="No spoken output."
            onClick={() => setTtsMode("off")}
          />
          <ModeCard
            active={ttsMode === "api"}
            title="API (OpenAI TTS)"
            description="Natural voices via your OpenAI key. Sends text to OpenAI."
            onClick={() => setTtsMode("api")}
          />
          <ModeCard
            active={ttsMode === "local"}
            title="Local (Piper)"
            description="Piper neural TTS on your CPU. Fully offline. Engine (~22 MB) + voice (~60 MB)."
            onClick={() => setTtsMode("local")}
          />
        </div>
      </div>

      {ttsMode === "api" ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
          <span className="text-muted-foreground">TTS model / voice</span>
          <div className="flex items-center gap-2">
            <Select
              ariaLabel="API TTS model"
              value={prefs.voiceTtsApiModel}
              onChange={(v) => void setVoiceTtsApiModel(v)}
              options={TTS_API_MODELS}
            />
            <Select
              ariaLabel="API TTS voice"
              value={prefs.voiceTtsApiVoice}
              onChange={(v) => void setVoiceTtsApiVoice(v)}
              options={TTS_API_VOICES.map((v) => ({ id: v, label: v }))}
            />
          </div>
        </div>
      ) : null}

      {ttsMode === "local" ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-muted-foreground">Voice</span>
            <Select
              ariaLabel="Local TTS voice"
              value={prefs.voiceTtsLocalVoice}
              onChange={(v) => void setVoiceTtsLocalVoice(v)}
              options={TTS_VOICES.map((v) => ({ id: v.id, label: `${v.label} — ${v.size}` }))}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy !== ""}
              onClick={() => void onSetupTts(prefs.voiceTtsLocalVoice)}
            >
              {busy === "tts"
                ? "Downloading…"
                : status?.ttsInstalled && status.ttsVoice === prefs.voiceTtsLocalVoice
                  ? "Reinstall"
                  : "Install local TTS"}
            </Button>
          </div>
          {status?.ttsInstalled ? (
            <span className="text-[11.5px] text-emerald-500">
              Piper installed{status.ttsVoice ? ` — voice: ${status.ttsVoice}` : " — no voice yet"}
            </span>
          ) : (
            <span className="text-[11.5px] text-muted-foreground/70">
              Piper not installed — TTS stays off until installed.
            </span>
          )}
          {busy === "tts" && progress ? <Progress ev={progress} /> : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy !== "" || !status?.ttsInstalled}
            onClick={() => {
              void import("@/modules/ai/lib/voiceTts").then((m) =>
                m.speakText("Voice engines ready. This is how agent replies will sound."),
              );
            }}
          >
            Test voice
          </Button>
        </div>
      ) : null}

      {ttsMode !== "off" ? (
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted-foreground">
            Auto-speak full agent replies when a response finishes
          </span>
          <input
            type="checkbox"
            checked={prefs.voiceSpeakReplies}
            onChange={(e) => void setVoiceSpeakReplies(e.target.checked)}
            className="size-3.5 accent-foreground"
          />
        </div>
      ) : null}

      {(status?.sttInstalled || status?.ttsInstalled) ? (
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted-foreground">
            Remove local engines and models (~80–260 MB)
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy !== ""}
            onClick={() => void onRemove()}
          >
            {busy === "remove" ? "Removing…" : "Remove local voice data"}
          </Button>
        </div>
      ) : null}

      {error ? <span className="text-[11.5px] text-red-500">{error}</span> : null}
    </div>
  );
}
