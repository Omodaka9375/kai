/**
 * Assistant light surface — prefs, token, and the typed native bridge.
 *
 * SPLIT FROM index.ts (2026-10): the settings Assistant panel
 * (settings/sections/ExternalSection.tsx) only needs THESE functions, but
 * importing the `@/modules/assistant` barrel dragged in the ENTIRE AI runtime
 * (agent stack, @ai-sdk providers, buildTools, mcpManager, voiceTts) into the
 * settings window — hundreds of unbundled ESM round-trips in dev, and the
 * panel took ~a minute to open. This module imports ONLY tauri core,
 * plugin-store, and the static config registry — safe for any window.
 *
 * index.ts re-exports everything here, so the barrel API is unchanged.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import { KEYRING_SERVICE } from "@/modules/ai/config";
import { DEFAULT_ALLOWED_TOOLS } from "./toolCatalog";

// ── Preferences ────────────────────────────────────────────────────────────

export const ASSISTANT_PREFS_STORE = "kai-assistant.json";

export type AssistantPrefs = {
  enabled: boolean;
  /** Telegram user id of the owner (bound via /start handshake). */
  ownerChatId: number | null;
  /** Model override for the assistant (null = default model). */
  modelId: string | null;
  /**
   * Assistant's OWN custom-endpoint identity. When the resolved model is a
   * custom endpoint (lmstudio-local / openai-compatible-custom) these win over
   * the app-wide Settings → Models endpoint, so flipping the DESKTOP chat
   * between local/cloud models can never silently move the assistant. null /
   * empty = inherit the global endpoint (the pre-isolation behavior).
   */
  customModelId: string | null;
  customBaseUrl: string | null;
  /** Reply with voice notes when the user sent voice. */
  voiceReplies: boolean;
  /**
   * Selectable tools the assistant may call (see toolCatalog.ts). Names are
   * tool keys; hard-excluded + MCP tools are not in this set. Defaults to the
   * READ tier — the assistant can look things up but not run shell / write
   * files / spend API credits until the owner grants those tiers.
   */
  allowedTools: string[];
  /** MCP server ids whose tools the assistant may call (empty = no MCP). */
  mcpAllowedServers: string[];
};

const DEFAULT_PREFS: AssistantPrefs = {
  enabled: false,
  ownerChatId: null,
  modelId: null,
  customModelId: null,
  customBaseUrl: null,
  voiceReplies: true,
  // Fresh spread: the defaults array is never mutated (saveAssistantPrefs
  // writes a copy), but a new list per default keeps references independent.
  allowedTools: [...DEFAULT_ALLOWED_TOOLS],
  mcpAllowedServers: [],
};

/** Shared store instance — sessions/history (index.ts) use the same one. */
export const prefsStore = new LazyStore(ASSISTANT_PREFS_STORE, { defaults: {}, autoSave: 200 });

export async function loadAssistantPrefs(): Promise<AssistantPrefs> {
  try {
    const raw = (await prefsStore.get<AssistantPrefs>("prefs")) ?? DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...raw };
  } catch {
    return DEFAULT_PREFS;
  }
}

export async function saveAssistantPrefs(prefs: AssistantPrefs): Promise<void> {
  await prefsStore.set("prefs", prefs);
}

// ── Native bridge (typed) ──────────────────────────────────────────────────

export type TelegramEvent =
  | { kind: "message"; chatId: number; messageId: number; text: string | null; voiceFileId: string | null; voiceDurationSecs: number | null; date: number }
  | { kind: "photo"; chatId: number; messageId: number; photoFileId: string; caption: string | null; date: number }
  | { kind: "document"; chatId: number; messageId: number; documentFileId: string; fileName: string; mimeType: string | null; date: number }
  | { kind: "video"; chatId: number; messageId: number; videoFileId: string; durationSecs: number | null; date: number }
  | { kind: "startCandidate"; chatId: number; messageId: number; date: number }
  | { kind: "rejected"; chatId: number; date: number }
  | { kind: "error"; message: string };

export const telegramNative = {
  start: async (token: string, ownerChatId: number | null, onEvent: (e: TelegramEvent) => void) => {
    // A Tauri `Channel<T>` argument must be an actual Channel instance — a bare
    // JS function isn't serializable, so the arg arrives missing
    // ("command telegram_start missing required key onEvent").
    const channel = new Channel<TelegramEvent>();
    channel.onmessage = (e) => onEvent(e);
    return await invoke<{ running: boolean; ownerChatId: number | null; botUsername: string | null }>(
      "telegram_start",
      { token, ownerChatId, onEvent: channel },
    );
  },
  stop: () => invoke<{ running: boolean }>("telegram_stop"),
  bindOwner: () => invoke<void>("telegram_bind_owner"),
  clearOwner: () => invoke<void>("telegram_clear_owner"),
  status: () =>
    invoke<{ running: boolean; ownerChatId: number | null; botUsername: string | null }>(
      "telegram_status",
    ),
  test: (token: string) =>
    invoke<{ running: boolean; ownerChatId: number | null; botUsername: string | null }>(
      "telegram_test",
      { token },
    ),
  sendMessage: (token: string, chatId: number, text: string) =>
    invoke<void>("telegram_send_message", { token, chatId, text }),
  /** Typing/upload indicator — best-effort; the Rust side never rejects. */
  sendChatAction: (token: string, chatId: number, action?: "typing" | "upload_document" | "upload_video") =>
    invoke<void>("telegram_set_chat_action", { token, chatId, action: action ?? "typing" }),
  sendVoice: (token: string, chatId: number, audioBase64: string) =>
    invoke<void>("telegram_send_voice", { token, chatId, audioBase64 }),
  sendPhoto: (token: string, chatId: number, photoBase64: string, caption?: string | null) =>
    invoke<void>("telegram_send_photo", { token, chatId, photoBase64, caption: caption ?? null }),
  sendVideo: (token: string, chatId: number, videoBase64: string, caption?: string | null) =>
    invoke<void>("telegram_send_video", { token, chatId, videoBase64, caption: caption ?? null }),
  sendDocument: (
    token: string,
    chatId: number,
    dataBase64: string,
    fileName: string,
    mimeType?: string | null,
  ) =>
    invoke<void>("telegram_send_document", {
      token,
      chatId,
      dataBase64,
      fileName,
      mimeType: mimeType ?? null,
    }),
  downloadVoice: (token: string, fileId: string) =>
    invoke<string>("telegram_download_voice", { token, fileId }),
  downloadFile: (token: string, fileId: string) =>
    invoke<string>("telegram_download_file", { token, fileId }),
};

// ── Bot token (OS keyring) ──────────────────────────────────────────────────

/** Token lives in the OS keyring (service `kai`), like every other credential.
 *  Raw secrets_get — the provider-keyring helper is registry-typed and only
 *  knows model providers; the Telegram token is its own account. */
export const TELEGRAM_TOKEN_KEY = "telegram_bot_token";

export async function getTelegramToken(): Promise<string | null> {
  try {
    return await invoke<string | null>("secrets_get", {
      service: KEYRING_SERVICE,
      account: TELEGRAM_TOKEN_KEY,
    });
  } catch {
    return null;
  }
}

export async function setTelegramToken(token: string): Promise<void> {
  await invoke<void>("secrets_set", {
    service: KEYRING_SERVICE,
    account: TELEGRAM_TOKEN_KEY,
    password: token,
  });
}

export async function clearTelegramToken(): Promise<void> {
  await invoke<void>("secrets_delete", {
    service: KEYRING_SERVICE,
    account: TELEGRAM_TOKEN_KEY,
  });
}