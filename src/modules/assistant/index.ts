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

import { Channel, invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { UIMessage } from "@ai-sdk/react";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { getModel, DEFAULT_MODEL_ID, type ModelId } from "@/modules/ai/config";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import { getAllKeys, getKey } from "@/modules/ai/lib/keyring";
import { KEYRING_SERVICE } from "@/modules/ai/config";
import { withToolRedaction, withToolGuard } from "@/modules/ai/lib/toolFencing";
import { createFenceState, fenceSystemPrompt } from "@/modules/ai/lib/fence";
import { auditAppend, AUDIT_KINDS } from "@/modules/ai/lib/audit";
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

// ── Sessions (multi-conversation store) ────────────────────────────────────

/**
 * Sessions: named conversations the owner can list/switch/reset — mirroring
 * the project chat's session UX. Persistence: kai-assistant.json
 *   sessions: [{id, title, createdAt, updatedAt}]   (index)
 *   activeSessionId: string
 *   messages:<id>: UIMessage[]                        (per-session history)
 * MIGRATION: v1 stored a single `history` array — on first load it becomes
 * the "Main" session so no conversation is lost.
 */
export type AssistantSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

const KEY_SESSIONS = "sessions";
const KEY_ACTIVE = "activeSessionId";
const messagesKey = (id: string) => `messages:${id}`;
const MAX_HISTORY_MESSAGES = 60;
const MAX_SESSIONS = 30;

let sessionsCache: AssistantSession[] | null = null;
let activeIdCache: string | null = null;
/** Per-session in-memory history (loaded lazily, mirrors the store). */
const historyCache = new Map<string, UIMessage[]>();

function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function listSessions(): Promise<AssistantSession[]> {
  if (sessionsCache) return sessionsCache;
  sessionsCache = (await prefsStore.get<AssistantSession[]>(KEY_SESSIONS)) ?? [];
  return sessionsCache;
}

export async function getActiveSessionId(): Promise<string> {
  await listSessions();
  if (activeIdCache) return activeIdCache;
  activeIdCache = (await prefsStore.get<string>(KEY_ACTIVE)) ?? null;
  // Active id pointing at a deleted session (or none) → first session or
  // create the default.
  if (!activeIdCache || !sessionsCache!.some((s) => s.id === activeIdCache)) {
    if (sessionsCache!.length > 0) {
      activeIdCache = sessionsCache![0].id;
    } else {
      activeIdCache = await createSession("Main");
    }
  }
  return activeIdCache;
}

async function createSession(title: string): Promise<string> {
  const id = newSessionId();
  const session: AssistantSession = {
    id,
    title: title.slice(0, 40) || "Untitled",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const list = await listSessions();
  const next = [session, ...list].slice(0, MAX_SESSIONS);
  sessionsCache = next;
  await prefsStore.set(KEY_SESSIONS, next);
  await prefsStore.set(messagesKey(id), []);
  return id;
}

export async function newSession(title?: string): Promise<AssistantSession> {
  const id = await createSession(title ?? nextSessionTitle());
  activeIdCache = id;
  await prefsStore.set(KEY_ACTIVE, id);
  const list = await listSessions();
  return list.find((s) => s.id === id)!;
}

function nextSessionTitle(): string {
  return "Chat " + (sessionsCache?.length ? sessionsCache.length + 1 : 1);
}

export async function switchSession(id: string): Promise<AssistantSession | null> {
  const list = await listSessions();
  const target = list.find((s) => s.id === id) ?? null;
  if (!target) return null;
  activeIdCache = id;
  await prefsStore.set(KEY_ACTIVE, id);
  return target;
}

export async function deleteSession(id: string): Promise<void> {
  const list = await listSessions();
  sessionsCache = list.filter((s) => s.id !== id);
  await prefsStore.set(KEY_SESSIONS, sessionsCache);
  await prefsStore.delete(messagesKey(id));
  historyCache.delete(id);
  if (activeIdCache === id) {
    activeIdCache = null;
    await getActiveSessionId();
  }
}

/** Per-session history. Trimmed to the newest MAX_HISTORY_MESSAGES. */
export async function loadHistory(sessionId?: string): Promise<UIMessage[]> {
  const id = sessionId ?? (await getActiveSessionId());
  const cached = historyCache.get(id);
  if (cached) return cached;
  const h = (await prefsStore.get<UIMessage[]>(messagesKey(id))) ?? [];
  historyCache.set(id, h);
  return h;
}

async function persistHistory(messages: UIMessage[], sessionId?: string): Promise<void> {
  const id = sessionId ?? (await getActiveSessionId());
  historyCache.set(id, messages);
  const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);
  await prefsStore.set(messagesKey(id), trimmed);
  // Bump the session's updatedAt so /sessions can show recency.
  const list = await listSessions();
  const s = list.find((x) => x.id === id);
  if (s) {
    s.updatedAt = Date.now();
    await prefsStore.set(KEY_SESSIONS, list);
  }
}

/** Reset the ACTIVE session's history (title kept). /new with no args. */
export async function resetAssistantHistory(): Promise<void> {
  const id = await getActiveSessionId();
  historyCache.set(id, []);
  await prefsStore.set(messagesKey(id), []);
}

/** One-time migration from the v1 single-history layout. */
export async function migrateV1HistoryIfNeeded(): Promise<void> {
  const legacy = (await prefsStore.get<UIMessage[]>("history")) ?? null;
  if (legacy && legacy.length > 0) {
    // Seed "Main" with the old conversation, then clear the legacy key.
    const list = await listSessions();
    if (list.length === 0) {
      const id = await createSession("Main");
      historyCache.set(id, legacy);
      await prefsStore.set(messagesKey(id), legacy.slice(-MAX_HISTORY_MESSAGES));
      activeIdCache = id;
      await prefsStore.set(KEY_ACTIVE, id);
    }
  }
  if (legacy) await prefsStore.delete("history");
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
  opts?: {
    onNotice?: (msg: string) => void;
    /** Vision input: base64 image attached to this turn. */
    imageBase64?: string;
    imageMime?: string;
  },
): Promise<string> {
  const onNotice = opts?.onNotice;
  const prefs = await loadAssistantPrefs();
  const sessionId = await getActiveSessionId();
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
  // Assistant-NATIVE media tools replace the desktop ones here: the desktop
  // tools are async fire-and-forget (spawnMediaTask patches a chat-UI part
  // that doesn't exist headless — payloads were silently dropped). These run
  // synchronously in-step and deliver straight to Telegram. Avoid the
  // module-level circular import: media.ts statically imports index.ts
  // (getTelegramToken/loadAssistantPrefs), so index must load it lazily.
  delete tools["generate_image"];
  delete tools["generate_video"];
  const mediaTools = await import("./media");
  tools["generate_image"] = mediaTools.buildAssistantMediaTools()["generate_image"];
  tools["generate_video"] = mediaTools.buildAssistantMediaTools()["generate_video"];
  // Redact tool RESULTS (paths, env vars, secrets) before they reach the
  // provider — same guarantee as the project agent path. Then fence them:
  // the assistant reads web pages and arbitrary user files, so its tool
  // output gets the same nonce trust-boundary the desktop agent has.
  const fenceState = createFenceState();
  const redactedTools = withToolRedaction(tools);
  const guardedTools = withToolGuard(redactedTools, fenceState, null);

  const history = await loadHistory(sessionId);
  const userParts: Array<{ type: string; text?: string }> = [
    { type: "text", text: userText },
  ];
  if (opts?.imageBase64) {
    userParts.push({
      type: "file",
      mediaType: opts.imageMime ?? "image/jpeg",
      data: opts.imageBase64,
    } as { type: string });
  }
  const userMsg: UIMessage = {
    id: `tg-${Date.now()}`,
    role: "user",
    parts: userParts as UIMessage["parts"],
  } as UIMessage;

  const system = [
    persona.instructions,
    fenceSystemPrompt(fenceState),
    "\n\n## CONVERSATION SURFACE — TELEGRAM",
    "You are chatting with the owner over Telegram. Replies are plain text (Telegram Markdown).",
    "Keep replies conversational and SHORT — a chat message, not a document. Bullet points over essays.",
    "You have tools (web, files in your scratch dir, shell in your scratch dir, MCP, image/video generation). Use them when asked.",
    "Do NOT use code fences with language tags unless the user asks for code — Telegram renders them as monospace blocks.",
    "This is a general personal-assistant conversation, not a coding session.",
    "## EXECUTION CLARITY PROTOCOL (critical):",
    "Your ENTIRE tool run happens BEFORE your reply is delivered — the user sees NOTHING until you finish. Therefore:",
    "- NEVER announce future actions (\u201cI'm going to check X\u201d). You already ran by the time they read it. Report what you DID, in past tense: \u201cI checked X: <result>.\u201d",
    "- NEVER mix a completed action and a question in one message. If you did something, the message is a report (statement only). If you need input, the message is a question (about that input only).",
    "- When a message ends with a question, that means you are WAITING for their answer — do not claim or imply anything is running in the background.",
    "- Optional follow-ups: separate paragraph, prefixed \u201cI can also ...\u201d — clearly NOT running, just an offer. Never put this in the same sentence/paragraph as a completed action.",
    "- Bad: \u201cI'll set up a watch for that! Want me to also check the docs?\u201d Good: \u201cDone \u2014 I set up a watch for that. It'll ping you when it fires.\u201d then optionally: \u201cI can also check the docs \u2014 say the word.\u201d",
    "When you generate an image or video, it is delivered to the user's Telegram chat automatically — describe it in your reply, do not paste URLs.",
    "Image/video generation: DO NOT ask the user which provider to use — the tools pick automatically from the configured keys. Generation takes 10-60s; that's normal, just call it.",
    "If generation fails with a missing-key error, tell the user SHORTLY: add a Google key in the desktop app's Settings → Models (or install the engine's official MCP server). One sentence, no essay.",
    "You have no camera or screen access on the user's device — if asked to 'look at my screen', say they can send a photo here and you'll analyze it.",
    custom ? `\n\n## USER CUSTOM INSTRUCTIONS\n${custom}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const modelMessages = [...history, userMsg].map(toModelMessage);

  // Audit the turn BEFORE the model runs: a headless run the user can't see
  // must still land in the trail even if the provider call throws.
  auditAppend(
    AUDIT_KINDS.assistantExec,
    "telegram",
    userText.slice(0, 160),
    "",
  );
  const result = await generateText({
    model,
    system,
    messages: modelMessages,
    tools: guardedTools as Parameters<typeof generateText>[0]["tools"],
    stopWhen: stepCountIs(ASSISTANT_MAX_STEPS),
    onStepFinish: (step) => {
      const last = step.toolCalls?.[step.toolCalls.length - 1];
      if (last && onNotice) onNotice(`⚙ ${last.toolName}`);
    },
  });

  const reply = result.text?.trim() || "…";
  await persistHistory(
    [...history, userMsg].concat(result.text
      ? [{
          id: `tg-a-${Date.now()}`,
          role: "assistant",
          parts: [{ type: "text", text: reply }],
        } as UIMessage]
      : []),
    sessionId,
  );
  return reply;
}

/** UIMessage → generateText model message. Text parts become text; image
 *  file parts become AI-SDK image parts (vision input survives history). */
function toModelMessage(m: UIMessage): ModelMessage {
  const parts = m.parts as Array<{ type: string; text?: string; mediaType?: string; data?: string }>;
  const text = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
  const image = parts.find((p) => p.type === "file" && p.data);
  if (image && m.role === "user") {
    return {
      role: "user",
      content: [
        { type: "text", text },
        {
          type: "image",
          mediaType: image.mediaType ?? "image/jpeg",
          data: image.data,
        },
      ],
    } as ModelMessage;
  }
  return { role: m.role === "assistant" ? "assistant" : "user", content: text };
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
type QueueItem = {
  chatId: number;
  text: string;
  isVoice: boolean;
  /** Vision input for this turn (photo message). */
  imageBase64?: string;
  imageMime?: string;
};
const pendingQueue: QueueItem[] = [];

export async function startAssistantBridge(): Promise<{ ok: boolean; error?: string }> {
  if (bridgeStarted) return { ok: true };
  const prefs = await loadAssistantPrefs();
  const token = await getTelegramToken();
  if (!prefs.enabled) return { ok: false, error: "assistant disabled" };
  if (!token) return { ok: false, error: "no bot token — set it in Settings → External" };
  await migrateV1HistoryIfNeeded();
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

// ── Event-channel ownership (cross-window handoff) ────────────────────────

const ASSISTANT_CLAIM_EVENT = "Kai://assistant-claim";
let reclaimInFlight = false;

/**
 * Re-register THIS window as the Telegram event-channel owner.
 *
 * The poll loop is global (Rust), but its delivery `Channel` belongs to ONE
 * webview. First enable has to happen in the settings window (that's where the
 * toggle lives), yet that window is transient — once it closes its Channel is
 * dead and the loop would push every event into the void, so the bot would
 * silently ignore messages until the app restarted. The always-alive main
 * window therefore takes delivery over right after the panel starts the bridge
 * (see `requestAssistantClaim`), and on every launch.
 *
 * Cheap and idempotent: Rust swaps the channel and leaves a running loop
 * alone, so this is safe to call repeatedly.
 */
export async function reclaimAssistantEvents(): Promise<void> {
  if (reclaimInFlight) return;
  reclaimInFlight = true;
  try {
    const prefs = await loadAssistantPrefs();
    if (!prefs.enabled) return;
    const token = await getTelegramToken();
    if (!token) return;
    // Rust state is authoritative for the owner: the loop sets it the moment
    // /start binds, which may be before any window persisted it.
    let owner = prefs.ownerChatId;
    try {
      const st = await telegramNative.status();
      if (st.ownerChatId != null) {
        owner = st.ownerChatId;
        if (prefs.ownerChatId !== owner) {
          await saveAssistantPrefs({ ...prefs, ownerChatId: owner });
        }
      }
    } catch {
      // status is best-effort — fall back to the persisted owner
    }
    if (owner == null) {
      // Unbound: keep the single-use bind handshake armed so a /start can
      // still claim ownership after the handoff (e.g. the settings window
      // armed it, then closed before the user sent /start).
      await telegramNative.bindOwner();
    }
    const onEvent = (e: TelegramEvent) => void handleTelegramEvent(e);
    const status = await telegramNative.start(token, owner, onEvent);
    bridgeStarted = status.running;
  } catch (e) {
    console.warn("[kai:assistant] event-channel reclaim failed:", e);
  } finally {
    reclaimInFlight = false;
  }
}

/** Ask the main window to take over Telegram event delivery. Called by the
 *  settings panel after it starts the bridge, so closing that window can't
 *  strand the loop. */
export async function requestAssistantClaim(): Promise<void> {
  await emit(ASSISTANT_CLAIM_EVENT).catch(() => {});
}

/** Subscribe to claim requests (main window). Returns an unlisten fn. */
export function onAssistantClaimRequested(cb: () => void): Promise<UnlistenFn> {
  return listen(ASSISTANT_CLAIM_EVENT, () => cb());
}

// ── Watch pings (proactive notifications) ─────────────────────────────────

/**
 * Send a watch-firing notification to the owner's Telegram. Called by the
 * watch tool's notifier hook when a watch with notifyTelegram fires — the
 * desktop still gets its in-conversation injection; this ADDS a phone
 * ping so long-running jobs reach the user even when the app is hidden.
 * Fail-soft: no bridge / no owner → silent no-op (the desktop injection
 * still happens).
 */
export async function telegramPing(text: string): Promise<void> {
  const prefs = await loadAssistantPrefs();
  if (!prefs.enabled || prefs.ownerChatId == null) return;
  const token = await getTelegramToken();
  if (!token) return;
  // Telegram Markdown: escape nothing (our text uses ` for labels —
  // plain text is safest for machine-generated output).
  await telegramNative.sendMessage(token, prefs.ownerChatId, text).catch(() => {});
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
    if (text.trim().startsWith("/")) {
      await handleCommand(e.chatId, text.trim());
      return;
    }
    if (!text.trim()) return;
    pendingQueue.push({ chatId: e.chatId, text, isVoice: false });
    void drainQueue();
    return;
  }
  if (e.kind === "photo") {
    // Photo → vision input: download, attach to the next turn as an image
    // part. The caption (or a default) is the user text.
    await enqueuePhotoMessage(e.chatId, e.photoFileId, e.caption);
    return;
  }
  if (e.kind === "document") {
    await enqueueDocumentMessage(e.chatId, e.documentFileId, e.fileName, e.mimeType);
    return;
  }
  if (e.kind === "video") {
    await enqueueVideoMessage(e.chatId, e.videoFileId);
    return;
  }
  if (e.kind === "startCandidate") {
    const token = await getTelegramToken();
    if (token) {
      await telegramNative.sendMessage(
        token,
        e.chatId,
        "👋 You're bound as my owner. Text, voice, photos, or files — /help for commands.",
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

// ── Slash commands (session + misc control from Telegram) ──────────────────

async function handleCommand(chatId: number, raw: string): Promise<void> {
  const token = await getTelegramToken();
  if (!token) return;
  const [cmd, ...rest] = raw.split(/\s+/);
  const arg = rest.join(" ").trim();
  const reply = async (text: string) => {
    await telegramNative.sendMessage(token, chatId, text).catch(() => {});
  };

  switch (cmd) {
    case "/new": {
      const session = await newSession(arg || undefined);
      await reply(`New chat: *${session.title}*`);
      return;
    }
    case "/sessions": {
      const list = await listSessions();
      const activeId = await getActiveSessionId();
      const lines = list
        .map((s) => {
          const marker = s.id === activeId ? "▶" : "•";
          const age = new Date(s.updatedAt).toISOString().slice(0, 10);
          return `${marker} ${s.title} — ${age} (id: ${s.id})`;
        })
        .slice(0, 15);
      await reply(["Your chats:", ...lines, "", "/use <id> to switch, /del <id> to delete."].join("\n"));
      return;
    }
    case "/use": {
      if (!arg) {
        await reply("Usage: /use <session-id from /sessions>");
        return;
      }
      const target = await switchSession(arg);
      await reply(target ? `Switched to *${target.title}*.` : "No chat with that id.");
      return;
    }
    case "/del": {
      if (!arg) {
        await reply("Usage: /del <session-id from /sessions>");
        return;
      }
      const list = await listSessions();
      const target = list.find((s) => s.id === arg);
      if (!target) {
        await reply("No chat with that id.");
        return;
      }
      await deleteSession(arg);
      await reply(`Deleted *${target.title}*.`);
      return;
    }
    case "/help": {
      await reply(
        [
          "Text, voice notes, photos, or files.",
          "/new [name] — start a new chat",
          "/sessions — list chats",
          "/use <id> — switch chat",
          "/del <id> — delete a chat",
        ].join("\n"),
      );
      return;
    }
    default:
      await reply(`Unknown command ${cmd}. /help for the list.`);
  }
}

// ── Media intake (photo / document / video) ─────────────────────────────────

async function enqueuePhotoMessage(
  chatId: number,
  fileId: string,
  caption: string | null,
): Promise<void> {
  const token = await getTelegramToken();
  if (!token) return;
  try {
    const b64 = await telegramNative.downloadFile(token, fileId);
    pendingQueue.push({
      chatId,
      text: caption?.trim() || "What's in this image?",
      isVoice: false,
      imageBase64: b64,
      imageMime: "image/jpeg",
    });
    void drainQueue();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await telegramNative.sendMessage(token, chatId, `⚠️ photo: ${msg.slice(0, 200)}`).catch(() => {});
  }
}

async function enqueueDocumentMessage(
  chatId: number,
  fileId: string,
  fileName: string,
  mimeType: string | null,
): Promise<void> {
  const token = await getTelegramToken();
  if (!token) return;
  try {
    const b64 = await telegramNative.downloadFile(token, fileId);
    // Save into the scratch dir so file tools can read it.
    const root = await assistantRoot();
    const sep = root.includes("\\") ? "\\" : "/";
    const safe = fileName.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "file";
    const path = `${root}${sep}${safe}`;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await invoke("fs_write_file_bytes", { path, bytes: Array.from(bytes), workspace: null });
    pendingQueue.push({
      chatId,
      text: `I've sent you a file (saved at ${path}, type: ${mimeType ?? "unknown"}). ${""}`.trim() +
        " What should I do with it?",
      isVoice: false,
    });
    void drainQueue();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await telegramNative.sendMessage(token, chatId, `⚠️ file: ${msg.slice(0, 200)}`).catch(() => {});
  }
}

async function enqueueVideoMessage(chatId: number, fileId: string): Promise<void> {
  const token = await getTelegramToken();
  if (!token) return;
  try {
    const b64 = await telegramNative.downloadFile(token, fileId);
    const root = await assistantRoot();
    const sep = root.includes("\\") ? "\\" : "/";
    const path = `${root}${sep}video-${Date.now()}.mp4`;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await invoke("fs_write_file_bytes", { path, bytes: Array.from(bytes), workspace: null });
    pendingQueue.push({
      chatId,
      text: `I sent a video (saved at ${path}). You can read its metadata with your file tools. What should I do with it?`,
      isVoice: false,
    });
    void drainQueue();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await telegramNative.sendMessage(token, chatId, `⚠️ video: ${msg.slice(0, 200)}`).catch(() => {});
  }
}

async function drainQueue(): Promise<void> {
  if (turnInFlight) return;
  const next = pendingQueue.shift();
  if (!next) return;
  turnInFlight = true;
  const token = await getTelegramToken();
  if (!token) {
    // Never fail silently: a missing key must tell the owner what to fix.
    console.warn("[kai:assistant] no bot token — dropping queued message");
    turnInFlight = false;
    if (pendingQueue.length > 0) void drainQueue();
    return;
  }
  try {
    const reply = await runAssistantTurn(next.text, {
      // Tool notices are progress, not conversation: sending one Telegram
      // message per tool step floods the chat. Log only — the final reply
      // (or the ⚠️ error below) is what the user sees.
      onNotice: (notice) => {
        console.debug("[kai:assistant]", notice);
      },
      imageBase64: next.imageBase64,
      imageMime: next.imageMime,
    });
    const prefs = await loadAssistantPrefs();
    if (next.isVoice && prefs.voiceReplies) {
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
