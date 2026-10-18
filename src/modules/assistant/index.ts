/**
 * Personal assistant channel — Telegram bridge.
 *
 * DESIGN (user decisions, locked):
 *   - FENCED: file/shell tools resolve against ~/.kai/assistant/ as the
 *     workspace root — a scratch area, NOT the user's projects or home dir.
 *   - AUTO-RUN: this is a conversation path, not a coding path — tools run
 *     without approval cards (the desktop is possibly minimized; nobody
 *     would click the card). DANGER: this also means shell tools are live
 *     on an internet-reachable surface, which is exactly why the fence is
 *     non-negotiable and the owner gate lives in Rust.
 *   - VOICE NOTES + TEXT (no calls — the Bot API cannot place them).
 *
 * Reuse over new science:
 *   - Sessions: the normal tauri-plugin-store pipeline, scoped to the
 *     assistant root — same persistence, LRU, and file format as projects.
 *   - Persona: `builtin:general` (the "Assistant" agent).
 *   - STT/TTS: the same engines as the desktop voice pipeline.
 *
 * THE RUST SIDE owns the network loop (modules/telegram.rs) — long-polling
 * cannot live in a throttled hidden webview (see heartbeat.rs for why).
 * This module subscribes to its Channel, runs the agent headlessly via
 * generateText (the runSubagent pattern — tools auto-execute, no approval
 * pause), and sends replies back through telegram_send_*.
 */

import { invoke } from "@tauri-apps/api/core";
import type { UIMessage } from "@ai-sdk/react";
import { generateText, stepCountIs } from "ai";
import { getModel, DEFAULT_MODEL_ID, type ModelId } from "@/modules/ai/config";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import { getAllKeys, getKey } from "@/modules/ai/lib/keyring";
import { KEYRING_SERVICE } from "@/modules/ai/config";
import { withToolRedaction } from "@/modules/ai/lib/toolFencing";
import { buildTools } from "@/modules/ai/tools/tools";
import type { ToolContext } from "@/modules/ai/tools/context";
import { BUILTIN_AGENTS } from "@/modules/ai/lib/agents";
import { toSpeechText, splitForSpeech, transcribeLocal } from "@/modules/ai/lib/voiceTts";
import { proxyFetch } from "@/modules/ai/lib/proxyFetch";
import { mcpManager } from "@/modules/ai/lib/mcpManager";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { LazyStore } from "@tauri-apps/plugin-store";

// ── Assistant root + preferences ────────────────────────────────────────────

export const ASSISTANT_PREFS_STORE = "kai-assistant.json";

export type AssistantPrefs = {
  enabled: boolean;
  /** Telegram user id of the owner (bound via /start handshake). */
  ownerChatId: number | null;
  /** Model override for the assistant (null = default model). */
  modelId: string | null;
  /** Reply with voice notes when the user sent voice. */
  voiceReplies: boolean;
};

const DEFAULT_PREFS: AssistantPrefs = {
  enabled: false,
  ownerChatId: null,
  modelId: null,
  voiceReplies: true,
};

const prefsStore = new LazyStore(ASSISTANT_PREFS_STORE, { defaults: {}, autoSave: 200 });

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

// ── Conversation memory (normal sessions, assistant-scoped) ────────────────

/**
 * One continuous conversation per owner — that's what a personal assistant
 * is. History persists as UIMessage[] in the assistant store; trimmed to
 * the last N turns to bound context (the headless path has no chatStore
 * compaction machinery, so we cap conservatively).
 */
const HISTORY_KEY = "history";
const MAX_HISTORY_MESSAGES = 60;

let historyCache: UIMessage[] | null = null;

export async function loadHistory(): Promise<UIMessage[]> {
  if (historyCache) return historyCache;
  try {
    historyCache = (await prefsStore.get<UIMessage[]>(HISTORY_KEY)) ?? [];
  } catch {
    historyCache = [];
  }
  return historyCache;
}

async function persistHistory(messages: UIMessage[]): Promise<void> {
  historyCache = messages;
  // Keep the newest messages; drop the oldest.
  const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);
  await prefsStore.set(HISTORY_KEY, trimmed);
}

/** /new — reset the conversation. */
export async function resetAssistantHistory(): Promise<void> {
  historyCache = [];
  await prefsStore.set(HISTORY_KEY, []);
}

// ── Native bridge (typed) ──────────────────────────────────────────────────

export type TelegramEvent =
  | { kind: "message"; chatId: number; messageId: number; text: string | null; voiceFileId: string | null; voiceDurationSecs: number | null; date: number }
  | { kind: "startCandidate"; chatId: number; messageId: number; date: number }
  | { kind: "rejected"; chatId: number; date: number }
  | { kind: "error"; message: string };

export const telegramNative = {
  start: (token: string, ownerChatId: number | null, onEvent: (e: TelegramEvent) => void) =>
    invoke<{ running: boolean; ownerChatId: number | null; botUsername: string | null }>(
      "telegram_start",
      { token, ownerChatId, onEvent },
    ),
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
  sendVoice: (token: string, chatId: number, audioBase64: string) =>
    invoke<void>("telegram_send_voice", { token, chatId, audioBase64 }),
  downloadVoice: (token: string, fileId: string) =>
    invoke<string>("telegram_download_voice", { token, fileId }),
};

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
    value: token,
  });
}

export async function clearTelegramToken(): Promise<void> {
  await invoke<void>("secrets_delete", {
    service: KEYRING_SERVICE,
    account: TELEGRAM_TOKEN_KEY,
  });
}

// ── Fenced tool context ────────────────────────────────────────────────────

/**
 * The assistant's ToolContext: workspace root is the assistant scratch dir.
 * File tools resolve relative paths against it; shell commands run with cwd
 * inside it. WithToolRedaction scrubs tool RESULTS before they reach the
 * provider (same guarantee as the project path).
 */
async function makeAssistantToolContext(): Promise<ToolContext> {
  const root = await assistantRoot();
  return {
    getCwd: () => root,
    getWorkspaceRoot: () => root,
    getRealWorkspaceRoot: () => root,
    getSessionId: () => "telegram-assistant",
    readCache: new Map(),
    fileTracker: {
      markRead: () => {},
      markModified: () => {},
    },
    // Live desktop context deliberately NOT wired — no terminal, no
    // cross-project file access from the phone. The assistant is fenced.
    writeToActiveTerminalDisplay: () => false,
    injectIntoActivePty: () => false,
    openPreview: () => false,
  } as unknown as ToolContext;
}

/** ~/.kai/assistant — resolved via the Rust side so the path form is right
 *  per-OS (backslash on Windows), matching what fs commands expect. */
let assistantRootCache: string | null = null;
export async function assistantRoot(): Promise<string> {
  if (assistantRootCache) return assistantRootCache;
  try {
    const home = await invoke<string>("kai_home_dir");
    const sep = home.includes("\\") ? "\\" : "/";
    assistantRootCache = `${home}${sep}.kai${sep}assistant`;
  } catch {
    assistantRootCache = "~/.kai/assistant";
  }
  try {
    await invoke("fs_create_dir", { path: assistantRootCache, workspace: null });
  } catch {
    /* may already exist */
  }
  return assistantRootCache;
}

// ── Persona ────────────────────────────────────────────────────────────────

export function assistantPersona(): { name: string; instructions: string } {
  const general = BUILTIN_AGENTS.find((a) => a.id === "builtin:general");
  if (general) {
    return {
      name: general.name,
      instructions: general.instructions,
    };
  }
  return {
    name: "Assistant",
    instructions:
      "You are a creative, insightful, and highly capable general-purpose assistant.",
  };
}

// ── Headless agent run (auto-execute, fenced) ─────────────────────────────

const ASSISTANT_MAX_STEPS = 24;

/** Tools excluded from the assistant surface: interactive-UI-only tools that
 *  make no sense headless (terminal tabs, screen, radio, subagents, media
 *  rendering into terminals, plan-mode edits). */
const EXCLUDED_TOOLS = new Set([
  "display_image",
  "display_video",
  "get_terminal_output",
  "look_at_screen",
  "open_preview",
  "play_radio",
  "stop_radio",
  "radio_list_stations",
  "radio_now_playing",
  "suggest_command",
  "run_subagent",
  "checkpoint_undo",
  "mcp_add_server",
  "mcp_list_servers",
]);

export async function runAssistantTurn(
  userText: string,
  onNotice?: (msg: string) => void,
): Promise<string> {
  const prefs = await loadAssistantPrefs();
  const modelId = (prefs.modelId as ModelId | null) ?? DEFAULT_MODEL_ID;
  const keys = await getAllKeys();
  const toolContext = await makeAssistantToolContext();
  const persona = assistantPersona();
  const custom = usePreferencesStore.getState().customInstructions;

  const m = getModel(modelId);
  let resolvedModelId = m.id;
  if (m.id === "lmstudio-local") {
    resolvedModelId = usePreferencesStore.getState().lmstudioModelId?.trim() || resolvedModelId;
  } else if (m.id === "openai-compatible-custom") {
    resolvedModelId =
      usePreferencesStore.getState().openaiCompatibleModelId?.trim() || resolvedModelId;
  }
  const model = await buildLanguageModel(m.provider, keys, resolvedModelId, {
    lmstudioBaseURL: usePreferencesStore.getState().lmstudioBaseURL,
    openaiCompatibleBaseURL: usePreferencesStore.getState().openaiCompatibleBaseURL,
  });

  // Build the full toolset, filter to the assistant surface, add MCP.
  const all = buildTools(toolContext) as Record<string, unknown>;
  const tools: Record<string, unknown> = {};
  for (const [id, tool] of Object.entries(all)) {
    if (EXCLUDED_TOOLS.has(id)) continue;
    tools[id] = tool;
  }
  const mcpTools = mcpManager.getActiveTools();
  for (const [id, tool] of Object.entries(mcpTools)) {
    tools[id] = tool;
  }
  // Redact tool RESULTS (paths, env vars, secrets) before they reach the
  // provider — same guarantee as the project agent path.
  const redactedTools = withToolRedaction(tools);

  const history = await loadHistory();
  const userMsg: UIMessage = {
    id: `tg-${Date.now()}`,
    role: "user",
    parts: [{ type: "text", text: userText }],
  } as UIMessage;

  const system = [
    persona.instructions,
    "\n\n## CONVERSATION SURFACE — TELEGRAM",
    "You are chatting with the owner over Telegram. Replies are plain text (Telegram Markdown).",
    "Keep replies conversational and SHORT — a chat message, not a document. Bullet points over essays.",
    "You have tools (web, files in your scratch dir, shell in your scratch dir, MCP). Use them when asked.",
    "Do NOT use code fences with language tags unless the user asks for code — Telegram renders them as monospace blocks.",
    "This is a general personal-assistant conversation, not a coding session.",
    custom ? `\n\n## USER CUSTOM INSTRUCTIONS\n${custom}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const modelMessages = [...history, userMsg].map(toModelMessage);

  const result = await generateText({
    model,
    system,
    messages: modelMessages,
    tools: redactedTools as Parameters<typeof generateText>[0]["tools"],
    stopWhen: stepCountIs(ASSISTANT_MAX_STEPS),
    onStepFinish: (step) => {
      const last = step.toolCalls?.[step.toolCalls.length - 1];
      if (last && onNotice) onNotice(`⚙ ${last.toolName}`);
    },
  });

  const reply = result.text?.trim() || "…";
  await persistHistory([...history, userMsg].concat(result.text
    ? [{
        id: `tg-a-${Date.now()}`,
        role: "assistant",
        parts: [{ type: "text", text: reply }],
      } as UIMessage]
    : []));
  return reply;
}

/** UIMessage → generateText model message (text-only view of the history). */
function toModelMessage(m: UIMessage): { role: "user" | "assistant"; content: string } {
  const text = (m.parts as Array<{ type: string; text?: string }>)
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
  return { role: m.role as "user" | "assistant", content: text };
}

// ── Voice pipeline ─────────────────────────────────────────────────────────

/** OGG→WAV handled Rust-side; here: base64 → STT text. Mirrors the desktop
 *  pipeline: local whisper via native.voiceTranscribe, or OpenAI API STT. */
export async function transcribeVoice(wavBase64: string): Promise<string> {
  const prefs = usePreferencesStore.getState();
  if (prefs.voiceSttMode === "api") {
    return transcribeViaOpenAi(wavBase64, prefs.voiceSttApiModel);
  }
  return transcribeLocal(base64ToBlob(wavBase64));
}

async function transcribeViaOpenAi(b64: string, model: string): Promise<string> {
  const apiKey = await getKey("openai");
  if (!apiKey) throw new Error("API STT needs an OpenAI key.");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/wav" }), "voice.wav");
  form.append("model", model || "whisper-1");
  const resp = await proxyFetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!resp.ok) throw new Error(`STT failed: HTTP ${resp.status}`);
  const j = (await resp.json()) as { text?: string };
  return j.text ?? "";
}

/** TTS the reply and send as a voice note. Uses the same engine selection as
 *  the desktop (local Piper or OpenAI TTS); the Rust side transcodes to OGG. */
export async function replyWithVoice(
  token: string,
  chatId: number,
  replyText: string,
): Promise<boolean> {
  const prefs = usePreferencesStore.getState();
  if (prefs.voiceTtsMode === "off") return false;
  const speechText = toSpeechText(replyText);
  if (!speechText.trim()) return false;
  const chunks = splitForSpeech(speechText);
  if (chunks.length === 0) return false;
  // Telegram voice notes are one message — concatenate chunk audio would
  // desync; instead speak the first chunk (the reply should be short on this
  // surface anyway) and send the rest as a follow-up text if truncated.
  const first = chunks[0];
  let audioB64: string;
  if (prefs.voiceTtsMode === "local") {
    audioB64 = await (await import("@/modules/ai/lib/native")).native.voiceTts(
      first,
      prefs.voiceTtsLocalVoice,
    );
  } else {
    const apiKey = await getKey("openai");
    if (!apiKey) return false;
    const resp = await proxyFetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: prefs.voiceTtsApiModel || "gpt-4o-mini-tts",
        voice: prefs.voiceTtsApiVoice || "alloy",
        input: first.slice(0, 4000),
        response_format: "wav",
      }),
    });
    if (!resp.ok) return false;
    const buf = new Uint8Array(await resp.arrayBuffer());
    audioB64 = bytesToBase64(buf);
  }
  await telegramNative.sendVoice(token, chatId, audioB64);
  if (chunks.length > 1) {
    await telegramNative.sendMessage(
      token,
      chatId,
      "… " + chunks.slice(1).join(" "),
    );
  }
  return true;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

function base64ToBlob(b64: string): Blob {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: "audio/wav" });
}

// ── The bridge (event loop → agent → reply) ────────────────────────────────

let bridgeStarted = false;
/** Set when the assistant is mid-turn; new messages queue (one at a time is
 *  the conversational contract — a personal chat doesn't parallel-reply). */
let turnInFlight = false;
const pendingQueue: Array<{ chatId: number; text: string; isVoice: boolean }> = [];

export async function startAssistantBridge(): Promise<{ ok: boolean; error?: string }> {
  if (bridgeStarted) return { ok: true };
  const prefs = await loadAssistantPrefs();
  const token = await getTelegramToken();
  if (!prefs.enabled) return { ok: false, error: "assistant disabled" };
  if (!token) return { ok: false, error: "no bot token — set it in Settings → External" };
  if (prefs.ownerChatId == null) {
    // Bind-mode: the poll loop is started with owner -1 and the settings UI
    // has armed telegram_bind_owner; the first /start claims binding.
    await telegramNative.bindOwner();
  }
  const onEvent = (e: TelegramEvent) => void handleTelegramEvent(e);
  const status = await telegramNative.start(token, prefs.ownerChatId, onEvent);
  bridgeStarted = status.running;
  return bridgeStarted
    ? { ok: true }
    : { ok: false, error: "poll loop failed to start" };
}

export async function stopAssistantBridge(): Promise<void> {
  await telegramNative.stop();
  bridgeStarted = false;
}

async function handleTelegramEvent(e: TelegramEvent): Promise<void> {
  if (e.kind === "message") {
    if (e.voiceFileId) {
      // Voice note: transcribe first, then queue the transcript.
      await enqueueVoiceMessage(e.chatId, e.voiceFileId);
      return;
    }
    const text = e.text ?? "";
    if (text.trim() === "/new") {
      await resetAssistantHistory();
      const token = await getTelegramToken();
      if (token) await telegramNative.sendMessage(token, e.chatId, "Fresh conversation. 🌱");
      return;
    }
    if (text.trim() === "/help") {
      const token = await getTelegramToken();
      if (token) {
        await telegramNative.sendMessage(
          token,
          e.chatId,
          "Text or send voice notes. /new starts a fresh conversation.",
        );
      }
      return;
    }
    if (!text.trim()) return;
    pendingQueue.push({ chatId: e.chatId, text, isVoice: false });
    void drainQueue();
    return;
  }
  if (e.kind === "startCandidate") {
    const token = await getTelegramToken();
    if (token) {
      await telegramNative.sendMessage(
        token,
        e.chatId,
        "👋 You're bound as my owner. Just talk to me — text or voice notes.",
      );
    }
    // Persist the new owner chat id in prefs.
    const prefs = await loadAssistantPrefs();
    prefs.ownerChatId = e.chatId;
    await saveAssistantPrefs(prefs);
    return;
  }
  if (e.kind === "rejected") {
    // Non-owner: silently ignore (no response = no oracle, no owner leak).
    return;
  }
  if (e.kind === "error") {
    console.warn("[kai:assistant] telegram loop error:", e.message);
  }
}

async function drainQueue(): Promise<void> {
  if (turnInFlight) return;
  const next = pendingQueue.shift();
  if (!next) return;
  turnInFlight = true;
  const token = await getTelegramToken();
  if (!token) {
    turnInFlight = false;
    return;
  }
  try {
    let userText = next.text;
    let isVoice = next.isVoice;
    // (Voice transcription is attached by the voice path before queueing.)
    const reply = await runAssistantTurn(userText, (notice) => {
      void telegramNative.sendMessage(token, next.chatId, notice).catch(() => {});
    });
    const prefs = await loadAssistantPrefs();
    if (isVoice && prefs.voiceReplies) {
      const sent = await replyWithVoice(token, next.chatId, reply);
      if (!sent) await telegramNative.sendMessage(token, next.chatId, reply);
    } else {
      await telegramNative.sendMessage(token, next.chatId, reply);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[kai:assistant] turn failed:", err);
    await telegramNative
      .sendMessage(token, next.chatId, `⚠️ ${msg.slice(0, 300)}`)
      .catch(() => {});
  } finally {
    turnInFlight = false;
    if (pendingQueue.length > 0) void drainQueue();
  }
}

// ── Voice message intake (called from the bridge for voiceFileId events) ────

export async function enqueueVoiceMessage(chatId: number, fileId: string): Promise<void> {
  const token = await getTelegramToken();
  if (!token) return;
  try {
    const wavB64 = await telegramNative.downloadVoice(token, fileId);
    const text = await transcribeVoice(wavB64);
    if (!text.trim()) {
      await telegramNative.sendMessage(token, chatId, "…(couldn't make out the audio)");
      return;
    }
    pendingQueue.push({ chatId, text, isVoice: true });
    void drainQueue();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await telegramNative.sendMessage(token, chatId, `⚠️ voice: ${msg.slice(0, 200)}`).catch(() => {});
  }
}
