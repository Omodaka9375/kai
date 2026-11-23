import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { native, type ReflexSetupEvent, type ReflexStatus } from "@/modules/ai/lib/native";
import { Channel } from "@tauri-apps/api/core";
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
    void native.reflexStatus().then(setStatus).catch(() => setStatus(null));
  };
  useEffect(() => {
    refreshStatus();
  }, []);

  const onSetup = async () => {
    if (busy) return;
    setBusy("setup");
    setError("");
    setProgress(null);
    const onEvent = new Channel<ReflexSetupEvent>();
    onEvent.onmessage = (e) => setProgress(e);
    try {
      await native.reflexSetup(onEvent);
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
      await native.reflexRemove();
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

      <SettingRow
        title="Engine"
        description={
          installed
            ? `Model kai-desktop-v1 (${status?.modelDepth ?? 12}L) v${status?.version ?? "?"} — ${running ? "running" : "installed, not running"}`
            : "Not installed (about 25 MB download)"
        }
      >
        <div className="flex items-center gap-2">
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
      </SettingRow>

      {progress && busy === "setup" ? (
        <div className="rounded-lg border border-border/60 bg-card/60 px-3 py-2">
          <Progress ev={progress} />
        </div>
      ) : null}

      {installed && status?.updateAvailable && status.latestVersion ? (
        <div className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-[12px]">
          A newer model version ({status.latestVersion}) is available. Re-download
          to update the classifier.
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
