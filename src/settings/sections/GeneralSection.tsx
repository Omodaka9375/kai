import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  setRestoreWindowState,
  setShowHidden,
  setRadioEnabled,
  setTerminalFontSize,
  setTerminalScrollback,
  setTerminalWebglEnabled,
  setVimMode,
  setEditorWordWrap,
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
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";
import {
  clearGmailSecret,
  gmailAccountEmail,
  setGmailSecret,
} from "@/modules/ai/tools/gmail";
import { clearXBearer, setXBearer, xBearerSet } from "@/modules/ai/tools/social";

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
  const editorWordWrap = usePreferencesStore((s) => s.editorWordWrap);
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const radioEnabled = usePreferencesStore((s) => s.radioEnabled);
  const terminalWebglEnabled = usePreferencesStore(
    (s) => s.terminalWebglEnabled,
  );
  const terminalFontSize = usePreferencesStore((s) => s.terminalFontSize);
  const terminalScrollback = usePreferencesStore((s) => s.terminalScrollback);

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
        <SettingRow
          title="Word wrap"
          description="Wrap long lines instead of expanding the editor horizontally. Applies to text, markdown, and code files."
        >
          <Switch
            checked={editorWordWrap}
            onCheckedChange={(v) => void setEditorWordWrap(v)}
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
        <Label>Mood</Label>
        <SettingRow
          title="SomaFM radio"
          description={
            <>
              Chill background music in the status bar — a station picker and a
              now-playing marquee. Streams from SomaFM (listener-supported,
              somafm.com).{" "}
              <button
                type="button"
                className="inline text-foreground/80 underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
                onClick={() =>
                  void openUrl("https://somafm.com/support/")
                }
              >
                Donate here
              </button>
              .
            </>
          }
        >
          <Switch
            checked={radioEnabled}
            onCheckedChange={(v) => void setRadioEnabled(v)}
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

      <GmailCard />
      <SocialCard />
    </div>
  );
}

/**
 * Gmail read-only access card. The agent's gmail_read tool searches the
 * user's own inbox over IMAP with an app password — no OAuth, no GCP
 * project, no MCP server. The stored secret is "<email> <app-password>" in
 * the OS keychain (service "kai", account "gmail-app-password").
 *
 * Read-only is enforced in the Rust module: connect/login, UID SEARCH,
 * UID FETCH, LOGOUT — there is no code path that can write or send.
 */
function GmailCard() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [configuredEmail, setConfiguredEmail] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [isError, setIsError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void gmailAccountEmail().then(setConfiguredEmail);
  }, []);

  const onSave = async () => {
    setBusy(true);
    setIsError(false);
    setStatus("");
    try {
      await setGmailSecret(email, password);
      setConfiguredEmail(await gmailAccountEmail());
      setEmail("");
      setPassword("");
      setStatus("Saved. The agent can now search your Gmail (read-only).");
    } catch (e) {
      setIsError(true);
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    setBusy(true);
    try {
      await clearGmailSecret();
      setConfiguredEmail(null);
      setStatus("Gmail access removed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card/50 p-4">
      <div>
        <div className="text-sm font-medium">Gmail (read-only)</div>
        <div className="text-xs text-muted-foreground">
          Lets the agent search and read your inbox with Gmail's own query
          syntax. Sending, replying, and modifying mail are not implemented —
          the tool cannot do them.
        </div>
      </div>

      <SettingRow
        title="Gmail account"
        description={
          configuredEmail
            ? `Configured as ${configuredEmail}. Replace by pasting a new password.`
            : "Needs 2FA on your Google account. Create an app password at myaccount.google.com/apppasswords, then paste your address and the password here. Stored in your OS keychain — never on disk in settings."
        }
      >
        <div className="flex w-full items-center gap-2">
          <Input
            type="email"
            value={email}
            placeholder={configuredEmail ?? "you@gmail.com"}
            onChange={(e) => setEmail(e.target.value)}
            className="flex-1"
          />
          <Input
            type="password"
            value={password}
            placeholder={configuredEmail ? "new app password" : "app password"}
            onChange={(e) => setPassword(e.target.value)}
            className="flex-1"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !email.trim() || !password.trim()}
            onClick={() => void onSave()}
          >
            Save
          </Button>
          {configuredEmail ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onRemove()}>
              Remove
            </Button>
          ) : null}
        </div>
      </SettingRow>

      {status ? (
        <div
          className={cn(
            "rounded-lg px-3 py-2 text-xs",
            isError ? "bg-red-500/10 text-red-500" : "bg-primary/5 text-muted-foreground",
          )}
        >
          {status}
        </div>
      ) : null}
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

/**
 * X (Twitter) card — developer Bearer token for the agent's read-only
 * social_read tool. Same storage contract as the Gmail card: OS keychain
 * under service "kai", never the settings store.
 *
 * Read-only is enforced in social.ts: only search + timeline GETs are
 * implemented — no code path can post, like, or follow.
 */
function SocialCard() {
  const [xToken, setXToken] = useState("");
  const [xConfigured, setXConfigured] = useState(false);
  const [status, setStatus] = useState("");
  const [isError, setIsError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void xBearerSet().then(setXConfigured);
  }, []);

  const onSaveX = async () => {
    setBusy(true);
    setIsError(false);
    setStatus("");
    try {
      await setXBearer(xToken);
      setXConfigured(true);
      setXToken("");
      setStatus("Saved. The agent can now search X and read account timelines (read-only).");
    } catch (e) {
      setIsError(true);
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRemoveX = async () => {
    setBusy(true);
    try {
      await clearXBearer();
      setXConfigured(false);
      setStatus("X token removed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card/50 p-4">
      <div>
        <div className="text-sm font-medium">X / Twitter (read-only)</div>
        <div className="text-xs text-muted-foreground">
          Lets the agent search X and read the timelines of accounts you name
          — reactions, sentiment, "what's happening" questions. Posting,
          liking, and following are not implemented; the tool cannot do them.
        </div>
      </div>

      <SettingRow
        title="Developer Bearer token"
        description={
          xConfigured
            ? "A Bearer token is configured. Replace by pasting a new one."
            : "From developer.x.com — your app's Bearer Token (search and user-timeline reads need a paid developer tier). Stored in your OS keychain, never on disk in settings."
        }
      >
        <div className="flex w-full items-center gap-2">
          <Input
            type="password"
            value={xToken}
            placeholder="Bearer token"
            onChange={(e) => setXToken(e.target.value)}
            className="flex-1"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !xToken.trim()}
            onClick={() => void onSaveX()}
          >
            Save
          </Button>
          {xConfigured ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onRemoveX()}>
              Remove
            </Button>
          ) : null}
        </div>
      </SettingRow>

      {status ? (
        <div
          className={cn(
            "rounded-lg px-3 py-2 text-xs",
            isError ? "bg-red-500/10 text-red-500" : "bg-primary/5 text-muted-foreground",
          )}
        >
          {status}
        </div>
      ) : null}
    </div>
  );
}
