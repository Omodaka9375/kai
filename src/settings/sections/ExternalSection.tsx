import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  loadAssistantPrefs,
  saveAssistantPrefs,
  telegramNative,
  getTelegramToken,
  setTelegramToken,
  clearTelegramToken,
  type AssistantPrefs,
} from "@/modules/assistant/prefs";
// Heavy bridge functions (startAssistantBridge et al.) are imported
// DYNAMICALLY at call time — a static import would drag the whole AI runtime
// (agent stack, @ai-sdk providers, buildTools, mcpManager) into the settings
// window and the panel took ~a minute to open in dev.
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";
import { SearchableModelPicker } from "../components/SearchableModelPicker";
import { ToolAllowlistPicker } from "../components/ToolAllowlistPicker";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { cn } from "@/lib/utils";

/**
 * Assistant — the personal-assistant channels panel. v1: Telegram.
 *
 * (File kept as ExternalSection.tsx; the panel was renamed External → Assistant.)
 *
 * Setup flow:
 *   1. Create a bot with @BotFather → paste the token here (stored in the
 *      OS keyring, never the settings store).
 *   2. Test connection (getMe) — shows the bot's @username.
 *   3. Enable. The FIRST /start sent to the bot binds YOUR Telegram account
 *      as its owner; everyone else is silently ignored forever after.
 */
export function ExternalSection() {
  const ttsMode = usePreferencesStore((s) => s.voiceTtsMode);
  const [prefs, setPrefs] = useState<AssistantPrefs | null>(null);
  const [token, setToken] = useState("");
  const [tokenSet, setTokenSet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [isError, setIsError] = useState(false);
  const [botUsername, setBotUsername] = useState<string | null>(null);

  // Poll the Rust-side status while the panel is open: the owner can bind via
  // /start from Telegram at any moment (the poll loop updates Rust state and
  // the bridge handler persists prefs) — this row must catch up on its own.
  const refreshOwner = useCallback(async () => {
    try {
      const s = await telegramNative.status();
      setPrefs((p) => {
        if (!p || s.ownerChatId == null) return p;
        if (p.ownerChatId === s.ownerChatId) return p;
        const merged = { ...p, ownerChatId: s.ownerChatId };
        void saveAssistantPrefs(merged);
        return merged;
      });
    } catch {
      // status polling is best-effort
    }
  }, []);

  useEffect(() => {
    void loadAssistantPrefs().then(setPrefs);
    void getTelegramToken().then((t) => {
      setTokenSet(!!t);
      if (t) setToken(t.slice(0, 4) + "…" + t.slice(-4));
    });
    void telegramNative.status().then((s) => setBotUsername(s.botUsername));
    const iv = setInterval(() => void refreshOwner(), 3000);
    return () => clearInterval(iv);
  }, [refreshOwner]);

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
        // Persist enabled BEFORE starting: startAssistantBridge re-loads
        // prefs from disk and refuses when enabled is not yet saved.
        await patch({ enabled: true });
        const { startAssistantBridge, requestAssistantClaim } = await import("@/modules/assistant");
        const result = await startAssistantBridge();
        if (!result.ok) {
          setIsError(true);
          setStatus(result.error ?? "failed to start");
          return;
        }
        // This window is transient: hand event delivery to the main window
        // so closing Settings can't strand the poll loop on a dead Channel.
        await requestAssistantClaim();
        setStatus(
          prefs?.ownerChatId == null
            ? "Started — send /start to your bot on Telegram to bind your account as its owner."
            : "Assistant is listening.",
        );
      } else {
        // Stopping needs only the native command. Importing the assistant
        // barrel here initialized its entire AI runtime in the Settings
        // window during a simple disable action.
        await telegramNative.stop();
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

  // GROUP BIND (2026-11-02): arm the handshake in Rust; the OWNER's next
  // /bindgroup sent INSIDE a Telegram group claims that group for the
  // assistant (Rust verifies the sender is the owner; the bridge handler
  // persists it). One-shot: arming again re-arms after a bind or a timeout.
  const onBindGroup = async () => {
    await invoke("telegram_bind_group");
    setStatus(
      "Armed — send /bindgroup INSIDE the Telegram group from the owner account to add it. Everyone in an added group can chat with the assistant (read-only tools, shared conversation).",
    );
  };

  if (!prefs) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading…</div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Assistant"
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
          title="Model"
          description="Model the assistant replies with. Search by name or provider — “Follow default” rides the app's default model (Settings → Models)."
        >
          <SearchableModelPicker
            value={prefs.modelId}
            onChange={(id) => void patch({ modelId: id })}
          />
        </SettingRow>

        <SettingRow
          title="Allowed tools"
          description="What the assistant may call on your behalf. Read-only is on by default; shell, file-writing and API-cost tools stay off until you grant them."
        >
          <ToolAllowlistPicker
            allowedTools={prefs.allowedTools}
            mcpAllowedServers={prefs.mcpAllowedServers}
            disabled={busy}
            onChange={(next) => void patch(next)}
          />
        </SettingRow>

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
          title="Group chats"
          description={
            (prefs.boundGroups ?? []).length > 0
              ? `${prefs.boundGroups!.length} group${prefs.boundGroups!.length === 1 ? "" : "s"} added. Everyone in an added group can chat with the assistant — one shared conversation, sender-attributed, and members get read-only tools (never shell, file writes, or your API-spend tools). You must disable the bot's privacy mode in @BotFather for it to see normal group messages.`
              : "Add a Telegram group so its members can chat with your assistant too. Bind with Add group, then send /bindgroup inside the group from the owner account. Members get read-only tools; the shared conversation keeps one context for everyone."
          }
        >
          <div className="flex w-full flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={busy || prefs.ownerChatId == null} onClick={() => void onBindGroup()}>
              Add group
            </Button>
          </div>
        </SettingRow>

        <SettingRow
          title="Voice replies"
          description="When you send a voice note, the assistant replies with a voice note too (needs the TTS engine from Settings → Voice; ffmpeg for Telegram's audio format)."
        >
          <Switch
            checked={prefs.voiceReplies}
            disabled={busy}
            onCheckedChange={(v) => {
              if (v && ttsMode === "off") {
                // Gate: enabling requires a TTS engine — otherwise replies would
                // silently fall back to text and read as broken.
                setIsError(false);
                setStatus(
                  "Turn on a TTS engine first — Settings → Voice → “Text to speech (agent replies)”: Local or API.",
                );
                return;
              }
              void patch({ voiceReplies: v });
            }}
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
          Uses the Assistant persona and the model above. What the bot may do is set
          under <span className="text-foreground">Allowed tools</span> — read-only by default; write and shell tools,
          once granted, stay fenced to a scratch folder (~/.kai/assistant), never your
          projects. Tools need a <span className="text-foreground">function-calling</span> model; the app must be running
          (tray is fine).
        </div>
      </div>
    </div>
  );
}
