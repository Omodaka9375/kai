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
 * Local Reflex — the on-device classifier (Needle 3 fine-tune) that answers
 * short desktop-control prompts without a cloud round-trip. Option A: the
 * engine + weights are DOWNLOADED on demand (nothing ships in the installer)
 * and spawned as a localhost serve process managed by Rust.
 */

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function Progress({ ev }: { ev: ReflexSetupEvent }) {
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
    <span className="text-[11.5px] text-muted-foreground">{ev.message ?? ev.phase}</span>
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

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Local Reflex"
        description="A tiny on-device model (23 MB) answers short desktop commands — theme switches, radio, reminders, voice, personas — with zero cloud tokens. Anything it does not confidently understand goes to your configured AI provider as usual."
      />

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {error}
        </div>
      ) : null}

      <SettingRow
        title="Enable local reflex"
        description="Off sends every prompt to the cloud model. On lets the local model handle the commands it is sure about."
      >
        <Switch checked={!disabled} onCheckedChange={onToggle} />
      </SettingRow>

      {/* ENGINE STATUS CARD (2026-11-23 polish): a compact status surface
          instead of a SettingRow — the live state (installed/running/absent)
          is the panel's primary fact, so it gets a tinted card with a
          status dot + version line, not a generic settings row. */}
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
              ? "Engine not installed"
              : running
                ? "Engine running"
                : "Engine installed — idle"}
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
              {busy === "setup" ? "Downloading…" : "Download"}
            </Button>
          )}
        </div>
        <div className="mt-2 flex flex-col gap-0.5 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-mono">
            {installed
              ? `kai-desktop-v1-${status?.modelDepth ?? 12}L · v${status?.version ?? "?"}`
              : "kai-desktop-v1 · about 25 MB download"}
          </span>
          <span>
            {!installed
              ? "Download the engine to classify short desktop commands on-device."
              : running
                ? "The serve process is up; classifications resolve locally."
                : "The engine is on disk but the serve process is not running — it starts on demand."}
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
