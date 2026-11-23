import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  reflexEngineStatus,
  removeReflexEngine,
  setupReflexEngine,
  type ReflexSetupEvent,
  type ReflexStatus,
} from "@/modules/ai/lib/reflexBridge";
import { resetReflexAvailability } from "@/modules/ai/lib/localReflex";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

/**
 * Local Reflex — the on-device `kai-reflex-v1` classifier that answers short
 * desktop-control prompts without a cloud round-trip. Downloaded on demand
 * into app local data and managed as a localhost serve process by Rust.
 */

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function Progress({ ev }: { ev: ReflexSetupEvent }) {
  const phaseLabel =
    ev.phase === "weights"
      ? "Downloading kai-reflex-v1"
      : ev.phase === "engine"
        ? "Downloading runtime engine"
        : ev.phase === "tools"
          ? "Writing tool schema"
          : ev.message ?? ev.phase;
  if (ev.total > 0) {
    const pct = Math.min(100, Math.round((ev.downloaded / ev.total) * 100));
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{phaseLabel}</span>
          <span className="font-mono">
            {formatBytes(ev.downloaded)} / {formatBytes(ev.total)} ({pct}%)
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  }
  return (
    <span className="text-[11.5px] text-muted-foreground">{phaseLabel}</span>
  );
}

const DISABLE_KEY = "kai.localReflex";

function isReflexDisabled(): boolean {
  try {
    return localStorage.getItem(DISABLE_KEY) === "off";
  } catch {
    return false;
  }
}

export function ReflexSection() {
  const [status, setStatus] = useState<ReflexStatus | null>(null);
  const [busy, setBusy] = useState<"" | "setup" | "remove">("");
  const [progress, setProgress] = useState<ReflexSetupEvent | null>(null);
  const [error, setError] = useState("");
  const [disabled, setDisabled] = useState(isReflexDisabled());

  const refreshStatus = () => {
    void reflexEngineStatus().then(setStatus);
  };
  useEffect(() => {
    refreshStatus();
  }, []);

  const onSetup = async () => {
    if (busy) return;
    setBusy("setup");
    setError("");
    setProgress(null);
    try {
      await setupReflexEngine((e) => setProgress(e));
      resetReflexAvailability();
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
      await removeReflexEngine();
      resetReflexAvailability();
      refreshStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  const onToggle = (enabled: boolean) => {
    // The transport reads localStorage on every send; flipping it needs no
    // reload.
    try {
      localStorage.setItem(DISABLE_KEY, enabled ? "on" : "off");
    } catch {
      /* localStorage unavailable */
    }
    setDisabled(!enabled);
  };

  const running = status?.running ?? false;
  const installed = status?.installed ?? false;
  const modelName = status?.modelName ?? "kai-reflex-v1";

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Local Reflex"
        description="A compact on-device model (24 MB) handles short desktop commands — theme switches, radio, reminders, voice, and personas — with zero cloud tokens. Everything else goes to your configured AI provider as usual."
      />

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {error}
        </div>
      ) : null}

      <SettingRow
        title="Enable local reflex"
        description="Off sends every prompt to your configured model. On lets kai-reflex-v1 handle confident desktop commands locally."
      >
        <Switch checked={!disabled} onCheckedChange={onToggle} />
      </SettingRow>

      <div className="rounded-2xl border border-border bg-card/50 p-4">
        <div className="flex items-center gap-2">
          <span
            className={
              installed && running
                ? "size-2 shrink-0 animate-pulse rounded-full bg-emerald-500"
                : installed
                  ? "size-2 shrink-0 rounded-full bg-amber-500/80"
                  : "size-2 shrink-0 rounded-full bg-muted-foreground/30"
            }
          />
          <span className="text-sm font-medium">
            {!installed
              ? `${modelName} not installed`
              : running
                ? `${modelName} running`
                : `${modelName} installed — idle`}
          </span>
          <span className="flex-1" />
          {installed ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== ""}
              onClick={onRemove}
            >
              {busy === "remove" ? "Removing…" : "Remove"}
            </Button>
          ) : (
            <Button size="sm" disabled={busy !== ""} onClick={onSetup}>
              {busy === "setup" ? "Installing…" : "Install v1"}
            </Button>
          )}
        </div>
        <div className="mt-2 flex flex-col gap-0.5 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-mono">
            {installed
              ? `${modelName} (${status?.modelDepth ?? 12}L) · v${status?.version ?? "1.0.0"}`
              : `${modelName} (12L) · ~24 MB one-time download`}
          </span>
          <span>
            {!installed
              ? "Install kai-reflex-v1 to run short desktop commands locally with zero cloud latency."
              : running
                ? "The local engine is running; eligible commands resolve on-device."
                : "Installed on disk — starts automatically on demand when you send a command."}
          </span>
        </div>
      </div>

      {progress && busy === "setup" ? (
        <div className="rounded-lg border border-border/60 bg-card/60 px-3 py-2">
          <Progress ev={progress} />
        </div>
      ) : null}

      {installed && status?.updateAvailable && status.latestVersion ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-[12px]">
          <span>
            A newer model version ({status.latestVersion}) is available.
          </span>
          <Button size="sm" disabled={busy !== ""} onClick={onSetup}>
            {busy === "setup" ? "Updating…" : "Update"}
          </Button>
        </div>
      ) : null}

      <SettingRow
        title="Privacy"
        description="The classifier runs entirely on this machine. Only your command text is processed locally; nothing is sent anywhere."
      >
        <span className="text-[11px] text-muted-foreground">on-device only</span>
      </SettingRow>
    </div>
  );
}
