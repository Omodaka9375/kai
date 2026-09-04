import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { IS_WINDOWS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { ThemePref } from "@/modules/settings/store";
import {
  EDITOR_THEME_LABELS,
  EDITOR_THEMES,
  TERMINAL_FONT_SIZES,
  TERMINAL_SCROLLBACK_PRESETS,
  setAutostart,
  setEditorTheme,
  setDefaultShell,
  setPreviewProxyUrl,
  setRestoreWindowState,
  setShowHidden,
  setTerminalFontSize,
  setTerminalScrollback,
  setTerminalWebglEnabled,
  setVimMode,
  setCommitSigningEnabled,
  setCommitSigningMode,
  setCommitSigningKey,
  type EditorThemeId,
} from "@/modules/settings/store";
import { useTheme } from "@/modules/theme";
import { UI_THEMES } from "@/modules/theme/palettes";
import {
  ArrowDown01Icon,
  ComputerIcon,
  Moon02Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Channel } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import {
  native,
  type GpgKey,
  type GpgStatus,
  type WhisperDownloadEvent,
  type WhisperModelStatus,
} from "@/modules/ai/lib/native";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

const APPEARANCE: {
  id: ThemePref;
  label: string;
  icon: typeof ComputerIcon;
}[] = [
  { id: "system", label: "System", icon: ComputerIcon },
  { id: "light", label: "Light", icon: Sun03Icon },
  { id: "dark", label: "Dark", icon: Moon02Icon },
];

export function GeneralSection() {
  const { theme, setTheme, uiThemeId, setUiThemeId } = useTheme();
  const editorTheme = usePreferencesStore((s) => s.editorTheme);
  const autostart = usePreferencesStore((s) => s.autostart);
  const restoreWindowState = usePreferencesStore((s) => s.restoreWindowState);
  const vimMode = usePreferencesStore((s) => s.vimMode);
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const terminalWebglEnabled = usePreferencesStore(
    (s) => s.terminalWebglEnabled,
  );
  const terminalFontSize = usePreferencesStore((s) => s.terminalFontSize);
  const terminalScrollback = usePreferencesStore((s) => s.terminalScrollback);
  const defaultShell = usePreferencesStore((s) => s.defaultShell);

  // Reconcile autostart pref with the actual OS state on mount — the user may
  // have toggled it from System Settings.
  useEffect(() => {
    let alive = true;
    void isEnabled()
      .then((on) => {
        if (!alive) return;
        if (on !== usePreferencesStore.getState().autostart) {
          void setAutostart(on);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const onToggleAutostart = async (next: boolean) => {
    try {
      if (next) await enable();
      else await disable();
      await setAutostart(next);
    } catch (e) {
      console.error("autostart toggle failed", e);
    }
  };

  const onPickEditor = (id: EditorThemeId) => void setEditorTheme(id);

  const onToggleTerminalWebgl = (next: boolean) => {
    void setTerminalWebglEnabled(next).catch((e) =>
      console.error("terminal WebGL preference update failed", e),
    );
  };

  const onPickTerminalFontSize = (size: number) => void setTerminalFontSize(size);

  const onPickScrollback = (lines: number) => void setTerminalScrollback(lines);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="General"
        description="Appearance, editor, and startup."
      />

      <div className="flex flex-col gap-2">
        <Label>Appearance</Label>
        <div className="grid grid-cols-3 gap-2">
          {APPEARANCE.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setTheme(o.id)}
              className={cn(
                "group flex h-20 flex-col items-center justify-center gap-1.5 rounded-lg border bg-card transition-all",
                theme === o.id
                  ? "border-foreground/60 ring-1 ring-foreground/20"
                  : "border-border/60 hover:border-border",
              )}
            >
              <HugeiconsIcon icon={o.icon} size={18} strokeWidth={1.5} />
              <span className="text-[11.5px]">{o.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>UI theme</Label>
        <div className="grid grid-cols-4 gap-2">
          {UI_THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setUiThemeId(t.id)}
              className={cn(
                "group flex h-14 flex-col items-center justify-center gap-1.5 rounded-lg border transition-all",
                uiThemeId === t.id
                  ? "border-foreground/60 ring-1 ring-foreground/20"
                  : "border-border/60 hover:border-border",
              )}
            >
              <span
                className="size-4 rounded-full border border-border/40"
                style={{ backgroundColor: t.swatch }}
              />
              <span className="text-[10px] leading-none">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Editor theme</Label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="h-9 justify-between gap-2 px-2.5 text-[12px]"
            >
              <span>{EDITOR_THEME_LABELS[editorTheme]}</span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={12}
                strokeWidth={2}
                className="opacity-70"
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[220px]">
            {EDITOR_THEMES.map((t) => (
              <DropdownMenuItem
                key={t}
                onSelect={() => onPickEditor(t)}
                className={cn(
                  "text-[12px]",
                  t === editorTheme && "bg-accent/50",
                )}
              >
                {EDITOR_THEME_LABELS[t]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <SettingRow
          title="Vim mode"
          description="Enable Vim keybindings in the code editor."
        >
          <Switch
            checked={vimMode}
            onCheckedChange={(v) => void setVimMode(v)}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Explorer</Label>
        <SettingRow
          title="Show hidden files"
          description="Include dot-prefixed files and folders (.env, .gitignore, .config) in the file explorer and search."
        >
          <Switch
            checked={showHidden}
            onCheckedChange={(v) => void setShowHidden(v)}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Terminal</Label>
        <SettingRow
          title={
            <span className="inline-flex items-center gap-1.5">
              Use WebGL renderer
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="cursor-help text-[11px] text-muted-foreground/70 leading-none"
                      aria-label="More info about WebGL renderer"
                    >
                      ⓘ
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-[260px] text-[11px]">
                    xterm's WebGL renderer caches glyphs in a GPU texture atlas. On some macOS setups (especially with Nerd Fonts), the atlas corrupts and terminal text becomes unreadable. Turn this off as a fallback — performance dips slightly, but text renders correctly via the DOM renderer.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </span>
          }
          description="Hardware-accelerated rendering. Turn off if text shows corruption or blank tiles."
        >
          <Switch
            checked={terminalWebglEnabled}
            onCheckedChange={onToggleTerminalWebgl}
          />
        </SettingRow>
        <SettingRow
          title="Font size"
          description="Terminal text size."
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className="h-8 justify-between gap-2 rounded-none px-2.5 text-[12px]"
              >
                <span>{terminalFontSize} px</span>
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={12}
                  strokeWidth={2}
                  className="opacity-70"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="min-w-[80px] rounded-none border border-border bg-popover p-0 shadow-none ring-0"
            >
              {TERMINAL_FONT_SIZES.map((size) => (
                <DropdownMenuItem
                  key={size}
                  onSelect={() => onPickTerminalFontSize(size)}
                  className={cn(
                    "rounded-none px-3 py-1.5 text-[12px]",
                    size === terminalFontSize && "bg-accent/50",
                  )}
                >
                  {size} px
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </SettingRow>
        <SettingRow
          title="Scrollback"
          description="Lines of history kept per terminal. Higher uses more RAM (~3 KB / line)."
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className="h-8 justify-between gap-2 rounded-none px-2.5 text-[12px]"
              >
                <span>{terminalScrollback.toLocaleString()} lines</span>
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={12}
                  strokeWidth={2}
                  className="opacity-70"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="min-w-[140px] rounded-none border border-border bg-popover p-0 shadow-none ring-0"
            >
              {TERMINAL_SCROLLBACK_PRESETS.map((lines) => (
                <DropdownMenuItem
                  key={lines}
                  onSelect={() => onPickScrollback(lines)}
                  className={cn(
                    "rounded-none px-3 py-1.5 text-[12px]",
                    lines === terminalScrollback && "bg-accent/50",
                  )}
                >
                  {lines.toLocaleString()} lines
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </SettingRow>
      </div>

      {IS_WINDOWS && (
        <div className="flex flex-col gap-2">
          <Label>Shell</Label>
          <SettingRow
            title="Default shell"
            description="Shell for new terminal tabs. Restart tabs to apply."
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="h-8 justify-between gap-2 rounded-none px-2.5 text-[12px]"
                >
                  <span>
                    {{
                      auto: "Auto-detect",
                      cmd: "Command Prompt",
                      powershell: "PowerShell 5",
                      pwsh: "PowerShell 7+",
                    }[defaultShell] ?? defaultShell}
                  </span>
                  <HugeiconsIcon
                    icon={ArrowDown01Icon}
                    size={12}
                    strokeWidth={2}
                    className="opacity-70"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[220px]">
                {(["auto", "cmd", "powershell", "pwsh"] as const).map((id) => (
                  <DropdownMenuItem
                    key={id}
                    onSelect={() => void setDefaultShell(id)}
                    className={cn(
                      "text-[12px]",
                      id === defaultShell && "bg-accent/50",
                    )}
                  >
                    {{
                      auto: "Auto-detect (pwsh → powershell → cmd)",
                      cmd: "Command Prompt (cmd.exe)",
                      powershell: "Windows PowerShell 5.1",
                      pwsh: "PowerShell 7+ (pwsh.exe)",
                    }[id]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingRow>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Label>Web Preview</Label>
        <ProxyUrlField />
      </div>

      <CommitSigningBlock />

      <LocalVoiceBlock />

      <div className="flex flex-col gap-2">
        <Label>Startup</Label>
        <div className="flex flex-col gap-2">
          <SettingRow
            title="Launch at login"
            description="Open Kai automatically when you sign in."
          >
            <Switch
              checked={autostart}
              onCheckedChange={(v) => void onToggleAutostart(v)}
            />
          </SettingRow>
          <SettingRow
            title="Restore window position & size"
            description="Reopen the main window where you left it. Applies on next launch."
          >
            <Switch
              checked={restoreWindowState}
              onCheckedChange={(v) => void setRestoreWindowState(v)}
            />
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

function CommitSigningBlock() {
  const enabled = usePreferencesStore((s) => s.commitSigningEnabled);
  const mode = usePreferencesStore((s) => s.commitSigningMode);
  const key = usePreferencesStore((s) => s.commitSigningKey);

  const [status, setStatus] = useState<GpgStatus | null>(null);
  const [keys, setKeys] = useState<GpgKey[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, k] = await Promise.all([native.gpgStatus(), native.gpgListKeys()]);
      setStatus(s);
      setKeys(k);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applyConfig = useCallback(
    async (nextEnabled: boolean, nextMode: "auto" | "approval", nextKey: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        if (nextEnabled && nextMode === "auto" && nextKey) {
          await native.gitConfigSet("commit.gpgsign", "true");
          await native.gitConfigSet("user.signingkey", nextKey);
          if (status?.program) {
            await native.gitConfigSet("gpg.program", status.program);
          }
        } else {
          await native.gitConfigUnset("commit.gpgsign");
          await native.gitConfigUnset("user.signingkey");
          await native.gitConfigUnset("gpg.program");
        }
        setNotice(nextEnabled && nextMode === "auto" ? "Auto-signing enabled." : null);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [status],
  );

  const onToggle = async (v: boolean) => {
    await setCommitSigningEnabled(v);
    await applyConfig(v, mode, key);
  };

  const onPickMode = async (m: "auto" | "approval") => {
    await setCommitSigningMode(m);
    await applyConfig(enabled, m, key);
  };

  const onPickKey = async (fingerprint: string) => {
    await setCommitSigningKey(fingerprint);
    await applyConfig(enabled, mode, fingerprint);
  };

  const copyPublicKey = async () => {
    if (!key) return;
    try {
      const armored = await native.gpgExportPublic(key);
      await navigator.clipboard.writeText(armored);
      setNotice("Public key copied to clipboard.");
    } catch (e) {
      setError(String(e));
    }
  };

  const gpgAvailable = status?.available ?? false;
  const selectedKey = keys.find((k) => k.fingerprint === key);

  return (
    <div className="flex flex-col gap-2">
      <Label>Commit signing</Label>
      <SettingRow
        title="Sign commits with GPG"
        description="Add a GPG signing key so commits show GitHub's Verified badge. This is optional and off by default."
      >
        <Switch
          checked={enabled}
          onCheckedChange={(v) => void onToggle(v)}
          disabled={busy}
        />
      </SettingRow>

      {enabled && (
        <>
          {!gpgAvailable && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
              {status?.error ?? "gpg not found. Install GnuPG (Gpg4win on Windows, `brew install gnupg` on macOS)."}
            </div>
          )}

          <SettingRow
            title="Mode"
            description="Auto-sign sets global git config so terminal, panel and agent commits are all signed. Approval asks before each panel commit."
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="h-8 justify-between gap-2 rounded-none px-2.5 text-[12px]"
                >
                  <span>{mode === "auto" ? "Auto-sign" : "Approval needed"}</span>
                  <HugeiconsIcon
                    icon={ArrowDown01Icon}
                    size={12}
                    strokeWidth={2}
                    className="opacity-70"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[160px]">
                {(["auto", "approval"] as const).map((m) => (
                  <DropdownMenuItem
                    key={m}
                    onSelect={() => void onPickMode(m)}
                    className={cn("text-[12px]", m === mode && "bg-accent/50")}
                  >
                    {m === "auto" ? "Auto-sign" : "Approval needed"}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingRow>

          <SettingRow
            title="Signing key"
            description="Select a key already present in your GPG keyring."
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="h-8 justify-between gap-2 rounded-none px-2.5 text-[12px] max-w-[240px]"
                >
                  <span className="truncate">
                    {selectedKey
                      ? `${selectedKey.name} · ${selectedKey.fingerprint.slice(-8)}`
                      : key
                        ? key.slice(-8)
                        : "No key selected"}
                  </span>
                  <HugeiconsIcon
                    icon={ArrowDown01Icon}
                    size={12}
                    strokeWidth={2}
                    className="opacity-70"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[220px] max-h-64 overflow-y-auto">
                {keys.length === 0 ? (
                  <DropdownMenuItem disabled className="text-[12px] text-muted-foreground">
                    No secret keys found — generate one with `gpg --full-generate-key`.
                  </DropdownMenuItem>
                ) : (
                  keys.map((k) => (
                    <DropdownMenuItem
                      key={k.fingerprint}
                      onSelect={() => void onPickKey(k.fingerprint)}
                      className={cn(
                        "flex-col items-start gap-0.5 text-[12px]",
                        k.fingerprint === key && "bg-accent/50",
                      )}
                    >
                      <span className="font-medium">{k.name}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {k.fingerprint}
                      </span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingRow>

          <SettingRow
            title="Add to GitHub"
            description="Copy the public key, then paste it into GitHub so commits verify."
          >
            <div className="flex items-center gap-1.5">
              <Button size="xs" variant="secondary" onClick={() => void copyPublicKey()} disabled={!key || busy}>
                Copy public key
              </Button>
              <Button size="xs" variant="outline" onClick={() => void openUrl("https://github.com/settings/gpg/new")}>
                Open GitHub
              </Button>
            </div>
          </SettingRow>

          {notice && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-700 dark:text-emerald-300">
              {notice}
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ProxyUrlField() {
  const saved = usePreferencesStore((s) => s.previewProxyUrl);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const dirty = draft !== saved;

  return (
    <div className="flex flex-col gap-1.5">
      <SettingRow
        title="Proxy URL"
        description="Route non-local URLs through a proxy that strips X-Frame-Options. Use {url} as a placeholder. Leave empty to disable."
      >
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="https://proxy.example.com/?url={url}"
            spellCheck={false}
            className="h-8 w-64 rounded-md border border-border bg-background px-2 font-mono text-[11px] outline-none placeholder:text-muted-foreground/50 focus:ring-1 focus:ring-ring"
          />
          {dirty && (
            <Button
              size="xs"
              onClick={() => void setPreviewProxyUrl(draft.trim())}
            >
              Save
            </Button>
          )}
        </div>
      </SettingRow>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function LocalVoiceBlock() {
  const [status, setStatus] = useState<WhisperModelStatus | null>(null);
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await native.whisperModelStatus());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const download = useCallback(async () => {
    setError(null);
    setDownloaded(0);
    setTotal(0);
    setDownloading(true);
    try {
      const channel = new Channel<WhisperDownloadEvent>();
      channel.onmessage = (ev) => {
        if (ev.phase === "progress") {
          setDownloaded(ev.downloaded);
          setTotal(ev.total);
        } else if (ev.phase === "done") {
          setDownloading(false);
          setStatus({ downloaded: true, downloading: false, path: ev.message, size: ev.total });
        } else if (ev.phase === "error") {
          setDownloading(false);
          setError(ev.message ?? "Download failed.");
        }
      };
      await native.whisperDownloadModel(channel);
      await refresh();
    } catch (e) {
      setDownloading(false);
      const msg = String(e);
      // A cancel is a user action, not an error worth surfacing.
      if (!/cancelled/i.test(msg)) setError(msg);
    }
  }, [refresh]);

  const remove = useCallback(async () => {
    setError(null);
    try {
      await native.whisperDeleteModel();
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }, [refresh]);

  const pct =
    total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
  const modelDownloaded = status?.downloaded ?? false;

  return (
    <div className="flex flex-col gap-2">
      <Label>Local voice transcription</Label>
      <SettingRow
        title="Whisper model (large-v3-turbo q5_0)"
        description={
          modelDownloaded
            ? `Downloaded (${formatBytes(status?.size ?? 0)}). Voice input runs fully offline and beats cloud APIs automatically.`
            : "Download a pre-quantized Whisper model (~547 MB) from HuggingFace so voice transcription runs locally. Nothing is bundled by default."
        }
      >
        <div className="flex items-center gap-1.5">
          {modelDownloaded ? (
            <Button size="xs" variant="outline" onClick={() => void remove()}>
              Remove
            </Button>
          ) : downloading ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void native.whisperCancelDownload()}
            >
              Cancel
            </Button>
          ) : (
            <Button size="xs" onClick={() => void download()}>
              Download
            </Button>
          )}
        </div>
      </SettingRow>

      {downloading && (
        <div className="flex flex-col gap-1 px-3 py-2">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-foreground/70 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[10.5px] text-muted-foreground">
            {pct}% · {formatBytes(downloaded)} / {formatBytes(total)}
          </span>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
