import { Button } from "@/components/ui/button";
import { native, type SandboxMode, type SandboxSetupEvent, type SandboxStatus } from "@/modules/ai/lib/native";
import { invalidateSandboxCache } from "@/modules/ai/lib/sandbox";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { IS_WINDOWS } from "@/lib/platform";
import { Channel } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

const MODES: { id: SandboxMode; label: string; description: string }[] = [
  {
    id: "off",
    label: "Off",
    description: "No sandboxing — the agent works with normal tool approvals.",
  },
  {
    id: "readOnly",
    label: "Read-only",
    description:
      "Reads allowed anywhere the security layer permits; writes are confined to the project directory.",
  },
  {
    id: "workspaceOnly",
    label: "Workspace only",
    description:
      "All file reads and writes are confined to the project directory. Anything outside is rejected before approval.",
  },
];

function CapabilityRow({ label, ok, note }: { label: string; ok: boolean; note: string }) {
  return (
    <div className="flex items-center justify-between text-[12px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-[11.5px]">
        {ok ? <span className="text-emerald-500">available</span> : <span className="text-muted-foreground/70">{note}</span>}
      </span>
    </div>
  );
}

/** Vertical block row — for settings whose control is a stack of full-width
 *  cards or lists, not a compact control in SettingRow's right column. */
function SettingBlock({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-[12.5px] font-medium">{title}</span>
        {description ? (
          <span className="text-[10.5px] leading-relaxed text-muted-foreground">
            {description}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function SandboxSection() {
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [mode, setMode] = useState<SandboxMode>("off");
  const [saving, setSaving] = useState(false);
  // The main window persists its live workspace root; the settings webview
  // (separate JS context, no setLive) rehydrates that value via its own
  // preferences init(). This is the same source App.tsx uses.
  const root = usePreferencesStore((s) => s.lastWorkspaceCwd) || null;

  useEffect(() => {
    let alive = true;
    void native.sandboxStatus().then((s) => {
      if (alive) setStatus(s);
    }).catch(() => {
      if (alive) setStatus(null);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    if (!root) return;
    void native.sandboxLoadConfig(root).then((c) => {
      if (alive) setMode(c.mode);
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [root]);

  const onPick = async (next: SandboxMode) => {
    if (!root || saving) return;
    setSaving(true);
    setMode(next);
    try {
      await native.sandboxSaveConfig(root, next);
      invalidateSandboxCache();
    } catch (e) {
      console.error("sandbox: failed to save config", e);
    } finally {
      setSaving(false);
    }
  };

  // ── Windows sandbox distro lifecycle ────────────────────────────────
  const [wslBusy, setWslBusy] = useState(false);
  const [wslProgress, setWslProgress] = useState<SandboxSetupEvent | null>(null);
  const [wslError, setWslError] = useState("");

  const onSetupWsl = async () => {
    if (wslBusy) return;
    setWslBusy(true);
    setWslError("");
    setWslProgress(null);
    const onEvent = new Channel<SandboxSetupEvent>();
    onEvent.onmessage = (e) => setWslProgress(e);
    try {
      await native.sandboxWslSetup(onEvent);
      void native.sandboxStatus().then((s) => setStatus(s));
    } catch (e) {
      setWslError(String(e));
    } finally {
      setWslBusy(false);
    }
  };

  const onRemoveWsl = async () => {
    if (wslBusy) return;
    setWslBusy(true);
    setWslError("");
    try {
      await native.sandboxWslRemove();
      void native.sandboxStatus().then((s) => setStatus(s));
    } catch (e) {
      setWslError(String(e));
    } finally {
      setWslBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Sandbox"
        description="Per-project execution policy for AI tools. Written to .kai/sandbox.json in the project."
      />

      <SettingBlock
        title="Mode"
        description={root ? `Applies to ${root}` : "No project open — open a workspace first."}
      >
        <div className="flex flex-col gap-1.5">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              disabled={!root || saving}
              onClick={() => void onPick(m.id)}
              className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                mode === m.id
                  ? "border-primary bg-primary/10"
                  : "border-border hover:bg-accent"
              } ${!root ? "opacity-60" : ""}`}
            >
              <span className="text-[12.5px] font-medium">{m.label}</span>
              <span className="text-[11.5px] text-muted-foreground">{m.description}</span>
            </button>
          ))}
        </div>
      </SettingBlock>

      <SettingBlock
        title="OS enforcement (Layer 2)"
        description="Detected sandboxing mechanisms for this machine. Layer 1 policy applies everywhere; these enable OS-level confinement for agent shells."
      >
        <div className="flex flex-col gap-1.5">
          {status === null ? (
            <span className="text-[11.5px] text-muted-foreground">Detecting…</span>
          ) : (
            <>
              <CapabilityRow label="Landlock (Linux)" ok={status.landlock} note="kernel < 5.13" />
              <CapabilityRow label="bubblewrap (Linux)" ok={status.bwrap} note="not installed" />
              <CapabilityRow label="sandbox-exec (macOS)" ok={status.sandboxExec} note="not available" />
              <CapabilityRow
                label="WSL (Windows)"
                ok={status.wslDistro}
                note={status.wsl ? "platform installed — no distro" : "not installed"}
              />
              {status.kernel ? (
                <span className="text-[11px] text-muted-foreground/70">kernel {status.kernel}</span>
              ) : null}
            </>
          )}
        </div>
      </SettingBlock>

      {IS_WINDOWS && status?.wsl ? (
        <SettingBlock
          title="Windows sandbox distro"
          description="A dedicated minimal WSL distro (kai-sandbox) with host-drive automount disabled — agent shells see ONLY the project. Filesystem confinement; network isolation is not possible per-distro under WSL2."
        >
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={wslBusy}
                onClick={() => void onSetupWsl()}
              >
                {wslBusy ? "Working…" : "Install sandbox distro"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={wslBusy || !status?.kaiSandboxDistro}
                onClick={() => void onRemoveWsl()}
              >
                Remove
              </Button>
            </div>

            {wslProgress?.phase === "download" && wslProgress.total > 0 ? (
              <div className="flex flex-col gap-1">
                <div className="h-1 w-56 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{
                      width: `${Math.round((wslProgress.downloaded / wslProgress.total) * 100)}%`,
                    }}
                  />
                </div>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {formatBytes(wslProgress.downloaded)} / {formatBytes(wslProgress.total)}
                </span>
              </div>
            ) : null}
            {wslProgress?.phase === "import" ? (
              <span className="text-[11.5px] text-muted-foreground">Importing distro — this takes ~10 seconds…</span>
            ) : null}
            {wslProgress?.phase === "done" ? (
              <span className="text-[11.5px] text-emerald-500">Sandbox distro ready</span>
            ) : null}
            {wslError ? (
              <span className="text-[11.5px] text-red-500">{wslError}</span>
            ) : null}
          </div>
        </SettingBlock>
      ) : null}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
