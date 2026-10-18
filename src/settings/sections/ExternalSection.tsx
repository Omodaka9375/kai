import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  loadAssistantPrefs,
  saveAssistantPrefs,
  startAssistantBridge,
  stopAssistantBridge,
  telegramNative,
  getTelegramToken,
  setTelegramToken,
  clearTelegramToken,
  type AssistantPrefs,
} from "@/modules/assistant";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";
import { cn } from "@/lib/utils";

/**
 * External — the personal-assistant channels panel. v1: Telegram.
 *
 * Setup flow:
 *   1. Create a bot with @BotFather → paste the token here (stored in the
 *      OS keyring, never the settings store).
 *   2. Test connection (getMe) — shows the bot's @username.
 *   3. Enable. The FIRST /start sent to the bot binds YOUR Telegram account
 *      as its owner; everyone else is silently ignored forever after.
 */
export function ExternalSection() {
  const [prefs, setPrefs] = useState<AssistantPrefs | null>(null);
  const [token, setToken] = useState("");
  const [tokenSet, setTokenSet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [isError, setIsError] = useState(false);
  const [botUsername, setBotUsername] = useState<string | null>(null);

  useEffect(() => {
    void loadAssistantPrefs().then(setPrefs);
    void getTelegramToken().then((t) => {
      setTokenSet(!!t);
      if (t) setToken(t.slice(0, 4) + "…" + t.slice(-4));
    });
    void telegramNative.status().then((s) => setBotUsername(s.botUsername));
  }, []);

  const patch = useCallback(
    async (next: Partial<AssistantPrefs>) => {
      if (!prefs) return;
      const merged = { ...prefs, ...next };
      setPrefs(merged);
      await saveAssistantPrefs(merged);
    },
    [prefs],
  );

  const onEnable = async (enabled: boolean) => {
    setBusy(true);
    setIsError(false);
    setStatus("");
    try {
      if (enabled) {
        const haveToken = tokenSet || token.trim().length > 20;
        if (!haveToken) {
          setIsError(true);
          setStatus("Set the bot token first.");
          return;
        }
        if (token.trim().length > 20 && token !== (await getTelegramToken())) {
          await setTelegramToken(token.trim());
          setTokenSet(true);
        }
        const result = await startAssistantBridge();
        if (!result.ok) {
          setIsError(true);
          setStatus(result.error ?? "failed to start");
          return;
        }
        await patch({ enabled: true });
        setStatus(
          prefs?.ownerChatId == null
            ? "Started — send /start to your bot on Telegram to bind your account as its owner."
            : "Assistant is listening.",
        );
      } else {
        await stopAssistantBridge();
        await patch({ enabled: false });
        setStatus("Stopped.");
      }
    } catch (e) {
      setIsError(true);
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onTest = async () => {
    setBusy(true);
    setIsError(false);
    setStatus("");
    try {
      const t = token.trim().length > 20 ? token.trim() : await getTelegramToken();
      if (!t) {
        setIsError(true);
        setStatus("No token to test.");
        return;
      }
      const result = await telegramNative.test(t);
      setBotUsername(result.botUsername);
      setStatus(result.botUsername ? `Connected as @${result.botUsername}.` : "Token works.");
      if (token.trim().length > 20) {
        await setTelegramToken(token.trim());
        setTokenSet(true);
      }
    } catch (e) {
      setIsError(true);
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onClearToken = async () => {
    await clearTelegramToken();
    setToken("");
    setTokenSet(false);
    setBotUsername(null);
    setStatus("Token removed.");
  };

  const onClearOwner = async () => {
    await invoke("telegram_clear_owner");
    await patch({ ownerChatId: null });
    setStatus("Owner unbound — the next /start re-binds.");
  };

  if (!prefs) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading…</div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="External"
        description="Chat with your assistant outside the app."
      />

      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card/50 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">Telegram</div>
            <div className="text-xs text-muted-foreground">
              Direct chat with your assistant via a Telegram bot — text and voice notes.
            </div>
          </div>
          <Switch
            checked={prefs.enabled}
            disabled={busy}
            onCheckedChange={(v) => void onEnable(v)}
          />
        </div>

        <SettingRow
          title="Bot token"
          description="Create a bot with @BotFather on Telegram and paste the token here. Stored in your OS keychain — never on disk in settings."
        >
          <div className="flex w-full items-center gap-2">
            <Input
              type="password"
              value={token}
              placeholder={tokenSet ? "•••••••••••• (saved)" : "123456789:ABC…"}
              onChange={(e) => setToken(e.target.value)}
              className="flex-1"
            />
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void onTest()}>
              Test
            </Button>
            {tokenSet ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onClearToken()}>
                Remove
              </Button>
            ) : null}
          </div>
        </SettingRow>

        {botUsername ? (
          <div className="text-xs text-muted-foreground">Connected as @{botUsername}</div>
        ) : null}

        <SettingRow
          title="Owner"
          description={
            prefs.ownerChatId != null
              ? `Bound to chat ${prefs.ownerChatId}. Only this account can talk to the assistant.`
              : "Not bound yet. After enabling, send /start to your bot on Telegram — the FIRST account to do so becomes its owner; everyone else is ignored."
          }
        >
          {prefs.ownerChatId != null ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void onClearOwner()}>
              Unbind
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">awaiting /start…</span>
          )}
        </SettingRow>

        <SettingRow
          title="Voice replies"
          description="When you send a voice note, the assistant replies with a voice note too (needs the TTS engine from Settings → Voice; ffmpeg for Telegram's audio format)."
        >
          <Switch
            checked={prefs.voiceReplies}
            disabled={busy}
            onCheckedChange={(v) => void patch({ voiceReplies: v })}
          />
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

      <div className="rounded-2xl border border-border bg-card/50 p-4 text-xs leading-relaxed text-muted-foreground">
        <div className="mb-1 text-sm font-medium text-foreground">How it works</div>
        <ol className="list-decimal space-y-1 pl-4">
          <li>Message @BotFather → /newbot → get a token.</li>
          <li>Paste the token above and press Test.</li>
          <li>Toggle Telegram on, then send /start to your bot from Telegram.</li>
          <li>The first account to /start is bound as owner — the bot ignores everyone else.</li>
          <li>Chat by text or voice notes. /new resets the conversation.</li>
        </ol>
        <div className="mt-2">
          The assistant uses the general Assistant persona, your default model, your MCP
          servers, and web tools. File and shell tools are fenced to a scratch folder
          (~/.kai/assistant) — not your projects. The app must be running (tray is fine)
          for the bot to answer.
        </div>
      </div>
    </div>
  );
}
