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
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { UIMessage } from "@ai-sdk/react";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { getModel, type ModelId } from "@/modules/ai/config";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import {
  downscalePhotoJpeg,
  prunePhotoScratch,
  rehydratePhotoPayloads,
  stripPhotoPayloads,
} from "./photos";
import { getAllKeys, getKey } from "@/modules/ai/lib/keyring";
import {
  hasInlineImageParts,
  swapImagePartsToText,
} from "@/modules/ai/extraction";
import { withToolRedaction, withToolGuard } from "@/modules/ai/lib/toolFencing";
import { withCentralToolGuards } from "@/modules/ai/lib/toolGuards";
import { createFenceState, fenceSystemPrompt } from "@/modules/ai/lib/fence";
import { auditAppend, AUDIT_KINDS } from "@/modules/ai/lib/audit";
import { buildTools } from "@/modules/ai/tools/tools";
import type { ToolContext } from "@/modules/ai/tools/context";
import { isToolAllowed } from "./toolCatalog";
import { BUILTIN_AGENTS, loadAgents } from "@/modules/ai/lib/agents";
import { toSpeechText, splitForSpeech, transcribeLocal } from "@/modules/ai/lib/voiceTts";
import { proxyFetch } from "@/modules/ai/lib/proxyFetch";
import { mcpManager } from "@/modules/ai/lib/mcpManager";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  prefsStore,
  loadAssistantPrefs,
  saveAssistantPrefs,
  getTelegramToken,
  telegramNative,
  type TelegramEvent,
} from "./prefs";
import {
  formatProjectsStatus,
  soleBoundProject,
  tellProject,
} from "./projectBridge";

// ── Assistant root + preferences ────────────────────────────────────────────

// Preferences, token, and the typed native bridge live in ./prefs.ts (light
// module — see its header). Re-exported here so the barrel API is unchanged.
export * from "./prefs";

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
    // Confine every assistant file+shell tool call to the scratch dir,
    // regardless of the desktop's Settings → Sandbox. The global
    // `currentRoot` in lib/sandbox.ts belongs to App.tsx / the active
    // desktop project and isn't something a headless turn should ride
    // (nor mutate — a concurrent desktop agent would race us). Passing an
    // override per call is both a safety boundary and an isolation one:
    // it makes "scratch dir only" (what the tool blurb promises) actually
    // enforced on absolute paths, home paths, `..` traversals, AND output
    // redirections from the shell side. `security.ts`'s deny-list still
    // applies first (defense-in-depth), so even files inside scratch are
    // blocked if they match the secret patterns (.env, .pem, id_rsa, …).
    getSandboxOverride: () => ({ root, mode: "workspaceOnly" }),
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

/** Persona honoring the owner's Settings override: a builtin agent edited in
 *  Settings → Agents is saved into customAgents under the SAME id, so the
 *  renamed builtin:general must beat the stock one here too — the same
 *  precedence bug chatRuntime had. Falls back to the builtin when the store
 *  is unavailable (headless test / store error). */
export async function resolveAssistantPersona(): Promise<{
  name: string;
  instructions: string;
}> {
  const fallback = assistantPersona();
  try {
    const { custom } = await loadAgents();
    const override = custom.find((c) => c.id === "builtin:general");
    if (override && override.instructions.trim()) {
      return { name: override.name, instructions: override.instructions };
    }
  } catch {
    /* store unavailable - builtin persona */
  }
  return fallback;
}

// ── Headless agent run (auto-execute, fenced) ─────────────────────────────

const ASSISTANT_MAX_STEPS = 24;

// The assistant's usable-tool set is owned by toolCatalog.ts (HARD_EXCLUDED
// for desktop-coupled tools, tier-grouped SELECTABLE tools gated by the
// owner's prefs.allowedTools + prefs.mcpAllowedServers). runAssistantTurn
// filters buildTools() through isToolAllowed().

/** One-line capability summary for the system prompt, derived from the
 *  ALLOWLIST — never from the full catalog. Telling the model it has shell
 *  access it doesn't have just produces failed tool attempts; telling it what
 *  it CAN do focuses attempts that work. */
export function describeAssistantCapabilities(
  allowed: ReadonlySet<string>,
  mcpCount: number,
): string {
  const groups: string[] = [];
  if (allowed.has("web_search") || allowed.has("web_browse"))
    groups.push("web search/fetch");
  if (allowed.has("read_file") || allowed.has("list_directory") || allowed.has("grep") || allowed.has("glob"))
    groups.push("reading files in your scratch dir");
  if (allowed.has("write_file") || allowed.has("edit") || allowed.has("batch_edit") || allowed.has("create_directory"))
    groups.push("writing files in your scratch dir");
  if (allowed.has("bash_run") || allowed.has("bash_background"))
    groups.push("shell commands in your scratch dir");
  if (allowed.has("watch_create")) groups.push("periodic watches");
  if (allowed.has("generate_image")) groups.push("image generation");
  if (allowed.has("generate_video")) groups.push("video generation");
  if (mcpCount > 0) groups.push(`${mcpCount} MCP server toolset(s)`);
  if (groups.length === 0)
    return "You currently have NO tools enabled — answer from the conversation and say so when a task would need one.";
  return `Your enabled capabilities this conversation: ${groups.join(", ")}. Do not attempt tools outside this list.`;
}

/**
 * Resolve the assistant's model endpoint, honoring its OWN custom-endpoint
 * overrides so it stays isolated from the desktop's Settings → Models config.
 *
 * For a custom provider (lmstudio-local / openai-compatible-custom) the model
 * NAME and BASE URL come from prefs.customModelId / prefs.customBaseUrl when
 * set, else fall back to the global Settings → Models value. That means: leave
 * them blank → "inherit the global endpoint"; set them → the assistant is
 * pinned no matter how the user flips the desktop chat between models.
 * Non-custom models ignore both. Pure + exported for unit tests.
 */
export function resolveAssistantEndpoint(
  modelId: string,
  prefs: { customModelId?: string | null; customBaseUrl?: string | null },
  global: {
    lmstudioModelId?: string;
    lmstudioBaseURL: string;
    openaiCompatibleModelId?: string;
    openaiCompatibleBaseURL: string;
  },
): { resolvedModelId: string; lmstudioBaseURL: string; openaiCompatibleBaseURL: string } {
  const ownModel = prefs.customModelId?.trim() || null;
  const ownUrl = prefs.customBaseUrl?.trim() || null;
  const out = {
    resolvedModelId: modelId,
    lmstudioBaseURL: global.lmstudioBaseURL,
    openaiCompatibleBaseURL: global.openaiCompatibleBaseURL,
  };
  if (modelId === "lmstudio-local") {
    out.resolvedModelId = ownModel || global.lmstudioModelId?.trim() || modelId;
    if (ownUrl) out.lmstudioBaseURL = ownUrl;
  } else if (modelId === "openai-compatible-custom") {
    out.resolvedModelId = ownModel || global.openaiCompatibleModelId?.trim() || modelId;
    if (ownUrl) out.openaiCompatibleBaseURL = ownUrl;
  }
  return out;
}

export async function runAssistantTurn(
  userText: string,
  opts?: {
    onNotice?: (msg: string) => void;
    /** Vision input: base64 image attached to this turn. */
    imageBase64?: string;
    imageMime?: string;
    /** Scratch-dir path of the original photo; recorded on the persisted
     *  file part so the image survives history reloads (photos.ts). */
    imagePath?: string;
  },
): Promise<string> {
  const onNotice = opts?.onNotice;
  const prefs = await loadAssistantPrefs();
  const sessionId = await getActiveSessionId();
  // null = follow the app's DEFAULT MODEL (Settings → Models), NOT the
  // hardcoded registry constant — the picker's "Follow default" entry
  // promises exactly this. getState() is kept current cross-window by
  // preferences.ts (Kai://prefs-changed), so settings-window changes apply
  // to the next assistant turn.
  const modelId = (prefs.modelId as ModelId | null) ??
    usePreferencesStore.getState().defaultModelId;
  const keys = await getAllKeys();
  const toolContext = await makeAssistantToolContext();
  const persona = await resolveAssistantPersona();
  const custom = usePreferencesStore.getState().customInstructions;

  const m = getModel(modelId);
  const ep = resolveAssistantEndpoint(m.id, prefs, usePreferencesStore.getState());
  const model = await buildLanguageModel(m.provider, keys, ep.resolvedModelId, {
    lmstudioBaseURL: ep.lmstudioBaseURL,
    openaiCompatibleBaseURL: ep.openaiCompatibleBaseURL,
  });

  // Build the full toolset, filter to the assistant surface, add MCP.
  const all = buildTools(toolContext) as Record<string, unknown>;
  // The owner's allowlist (READ tier by default) — a tool reaches the model
  // only if selected here. isToolAllowed also enforces the hard-excluded set,
  // so a stale/edited allowedTools can't re-enable a desktop-only tool.
  const allowed = new Set(prefs.allowedTools);
  const tools: Record<string, unknown> = {};
  const blockedApprovalTools: string[] = [];
  for (const [id, tool] of Object.entries(all)) {
    if (!isToolAllowed(id, allowed)) continue;
    // Approval-required tools can NEVER run headless: there is no bridge,
    // no responder, and no card - the SDK would simply never execute the
    // call and the turn would stall silently. Strip them and tell the
    // model honestly (below) instead of leaving a dead callable.
    if ((tool as { needsApproval?: boolean }).needsApproval === true) {
      blockedApprovalTools.push(id);
      continue;
    }
    tools[id] = tool;
  }
  // MCP: per-server grant. getToolsForServers returns tools ONLY for the
  // allowed ids (and only connected servers), so an ungranted server's tools
  // never surface even if the model was told about them. MCP wrappers are
  // approval-required (mcpManager) - same headless rule applies.
  const mcpTools = mcpManager.getToolsForServers(prefs.mcpAllowedServers);
  for (const [id, tool] of Object.entries(mcpTools)) {
    if ((tool as { needsApproval?: boolean }).needsApproval === true) {
      blockedApprovalTools.push(id);
      continue;
    }
    tools[id] = tool;
  }
  // Assistant-NATIVE media tools replace the desktop ones here: the desktop
  // tools are async fire-and-forget (spawnMediaTask patches a chat-UI part
  // that doesn't exist headless — payloads were silently dropped). These run
  // synchronously in-step and deliver straight to Telegram. Avoid the
  // module-level circular import: media.ts statically imports index.ts
  // (getTelegramToken/loadAssistantPrefs), so index must load it lazily.
  // Drop the desktop media tools unconditionally (they patch a chat-UI part
  // that doesn't exist headless); re-attach the assistant-native versions
  // ONLY if the owner's allowlist grants them (both are WRITE tier, off by
  // default — so a default assistant can't spend image/video API credits).
  delete tools["generate_image"];
  delete tools["generate_video"];
  if (allowed.has("generate_image") || allowed.has("generate_video")) {
    const mediaTools = await import("./media");
    // The photo attached to THIS turn is the editing/animation source headless:
    // no meaningful paths exist in the assistant scratch dir, so the just-sent
    // photo rides as the reference image when the model asks to edit/animate it.
    const turnImage = opts?.imageBase64
      ? { base64: opts.imageBase64, mimeType: opts.imageMime }
      : undefined;
    const assistantMedia = mediaTools.buildAssistantMediaTools(turnImage);
    if (allowed.has("generate_image"))
      tools["generate_image"] = assistantMedia["generate_image"];
    if (allowed.has("generate_video"))
      tools["generate_video"] = assistantMedia["generate_video"];
  }
  // Redact tool RESULTS (paths, env vars, secrets) before they reach the
  // provider — same guarantee as the project agent path. Then fence them:
  // the assistant reads web pages and arbitrary user files, so its tool
  // output gets the same nonce trust-boundary the desktop agent has.
  const fenceState = createFenceState();
  const redactedTools = withToolRedaction(tools);
  // The assistant auto-executes without approval cards, so the same central
  // deny-only floor as the desktop path is mandatory here — especially for
  // granted MCP tools, which have no inline KAI security checks.
  const centrallyGuardedTools = withCentralToolGuards(
    redactedTools,
    undefined,
    (name, reason) => {
      auditAppend(
        AUDIT_KINDS.securityDeny,
        "tool-guard",
        `${name}: ${reason}`.slice(0, 200),
        "",
      );
    },
  );
  const guardedTools = withToolGuard(centrallyGuardedTools, fenceState, null);

  const history = await loadHistory(sessionId);
  const userParts: Array<{ type: string; text?: string }> = [
    { type: "text", text: userText },
  ];
  if (opts?.imageBase64) {
    userParts.push({
      type: "file",
      mediaType: opts.imageMime ?? "image/jpeg",
      data: opts.imageBase64,
      ...(opts.imagePath ? { sourcePath: opts.imagePath } : {}),
    } as { type: string });
  }
  const userMsg: UIMessage = {
    id: `tg-${Date.now()}`,
    role: "user",
    parts: userParts as UIMessage["parts"],
  } as UIMessage;

  const system = [
    `Your name is "${persona.name}". When the user asks your name or addresses you, answer with it.`,
    persona.instructions,
    fenceSystemPrompt(fenceState),
    blockedApprovalTools.length > 0
      ? `Tools requiring interactive approval are UNAVAILABLE in this headless assistant: ${blockedApprovalTools.join(", ")}. Never attempt them; if a task needs them, tell the user to run it in the desktop app.`
      : "",
    "\n\n## CONVERSATION SURFACE — TELEGRAM",
    "You are chatting with the owner over Telegram. Replies are plain text (Telegram Markdown).",
    "Keep replies conversational and SHORT — a chat message, not a document. Bullet points over essays.",
    describeAssistantCapabilities(allowed, prefs.mcpAllowedServers.length),
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

  // Rehydrate the most recent persisted photos from their scratch files
  // before replaying history (store keeps paths, not bytes — photos.ts).
  const replay = await rehydratePhotoPayloads([...history, userMsg]);
  const modelMessages = replay.map(toModelMessage);

  // Audit the turn BEFORE the model runs: a headless run the user can't see
  // must still land in the trail even if the provider call throws.
  auditAppend(
    AUDIT_KINDS.assistantExec,
    "telegram",
    userText.slice(0, 160),
    "",
  );
  // IMAGE-FIRST, then reactive OCR. Local models are overwhelmingly
  // multimodal and detection-by-name misfires ("Qwen3.8-Flash-Next" looks
  // text-only to the heuristic but isn't), so we send real pixels whenever
  // a photo is present. If the provider rejects the image (a genuinely
  // text-only model errors on the content part), swap image parts for
  // extracted text and retry ONCE — the turn degrades to an OCR'd image
  // description instead of the warning hard failure the owner saw before.
  // Extraction is best-effort even without an OCR engine (it still yields
  // format/dimensions), so the retry cannot itself throw on the image.
  let result: Awaited<ReturnType<typeof generateText>>;
  // A text-only provider rejects the image on the FIRST model call — before
  // ANY tool executes — so a pre-step failure is safe to retry with OCR. If a
  // step already finished, side-effecting tools may have run; replaying the
  // turn would double-execute them (a second `git commit`, a re-charged image
  // generation, …) AND the image clearly was not the blocker (the turn got
  // several steps in WITH it). So retry ONLY when nothing has run yet.
  let stepsFinished = 0;
  try {
    result = await runAssistantGenerate(model, system, modelMessages, guardedTools, onNotice, () => {
      stepsFinished++;
    });
  } catch (e) {
    if (stepsFinished > 0 || !hasInlineImageParts(modelMessages)) throw e;
    console.warn(
      "[kai:assistant] image request rejected — retrying with image text-extracted:",
      e,
    );
    const textOnly = await swapImagePartsToText(modelMessages);
    result = await runAssistantGenerate(model, system, textOnly, guardedTools, onNotice);
  }

  const reply = result.text?.trim() || "…";
  // Persist WITHOUT inline photo bytes: each file part keeps its mediaType +
  // sourcePath and sheds `data` (megabyte payloads must not live in the
  // prefs-store JSON, and history replay reads them back on demand).
  await persistHistory(
    stripPhotoPayloads(
      [...history, userMsg].concat(result.text
        ? [{
            id: `tg-a-${Date.now()}`,
            role: "assistant",
            parts: [{ type: "text", text: reply }],
          } as UIMessage]
        : []),
    ),
    sessionId,
  );
  return reply;
}

async function runAssistantGenerate(
  model: Parameters<typeof generateText>[0]["model"],
  system: string,
  messages: ModelMessage[],
  guardedTools: Record<string, unknown>,
  onNotice?: (msg: string) => void,
  onStepFinished?: () => void,
) {
  return generateText({
    model,
    system,
    messages,
    tools: guardedTools as Parameters<typeof generateText>[0]["tools"],
    stopWhen: stepCountIs(ASSISTANT_MAX_STEPS),
    onStepFinish: (step) => {
      // Counted BEFORE the notice so the retry guard sees "a step ran" even
      // if the model errored on the next call.
      onStepFinished?.();
      const last = step.toolCalls?.[step.toolCalls.length - 1];
      if (last && onNotice) onNotice(`⚙ ${last.toolName}`);
    },
  });
}

/** UIMessage → generateText model message. Text parts become text; image
 *  file parts become AI-SDK image parts (vision input survives history).
 *  Exported for tests: its output must satisfy the SDK's modelMessageSchema,
 *  and the exact payload key (`image`, not `data`) is a regression we pin. */
export function toModelMessage(m: UIMessage): ModelMessage {
  const parts = m.parts as Array<{ type: string; text?: string; mediaType?: string; data?: string }>;
  const text = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
  const image = parts.find((p) => p.type === "file" && p.data);
  if (image && m.role === "user") {
    // The model-message image part's payload key is `image` (z.union of
    // dataContentSchema | URL), NOT `data` — `data` is the *file* part's key.
    // Emitting { type:"image", data } failed modelMessageSchema's required
    // `image` field and threw "The messages do not match the ModelMessage[]
    // schema" on every Telegram photo. A raw base64 string is a valid
    // dataContentSchema member, so image.data passes straight through.
    return {
      role: "user",
      content: [
        { type: "text", text },
        {
          type: "image",
          image: image.data,
          mediaType: image.mediaType ?? "image/jpeg",
        },
      ],
    } as ModelMessage;
  }
  return { role: m.role === "assistant" ? "assistant" : "user", content: text };
}

// ── Photo intake helpers live in ./photos.ts (downscale / persist-strip /
// context rehydrate / scratch prune) so they are unit-testable in isolation.

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
  /** Scratch-dir path of the original bytes (the persisted reference). */
  imagePath?: string;
};
const pendingQueue: QueueItem[] = [];

export async function startAssistantBridge(): Promise<{ ok: boolean; error?: string }> {
  if (bridgeStarted) {
    // Settings can stop natively without importing this runtime. Revalidate
    // rather than trusting a stale module cache across an off→on toggle.
    try {
      const current = await telegramNative.status();
      bridgeStarted = current.running;
      if (bridgeStarted) return { ok: true };
    } catch {
      // Continue with a fresh native start below.
      bridgeStarted = false;
    }
  }
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
      // Voice note: transcribe, then queue. When exactly ONE project is
      // bound, the transcript routes to that project's agent instead of an
      // assistant turn (the phone is that project's remote input).
      await enqueueVoiceMessage(e.chatId, e.voiceFileId);
      return;
    }
    const text = e.text ?? "";
    if (text.trim().startsWith("/")) {
      await handleCommand(e.chatId, text.trim());
      return;
    }
    if (!text.trim()) return;
    // Plain text to a SOLE bound project routes to that project's agent
    // (no assistant turn); with zero or several bound projects it is an
    // assistant message as before. /tell names the target explicitly.
    const sole = await soleBoundTarget();
    if (sole) {
      const outcome = await tellProject(sole, text.trim(), e.chatId, true);
      await telegramNative.sendMessage(
        (await getTelegramToken()) ?? "",
        e.chatId,
        outcome,
      ).catch(() => {});
      return;
    }
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

// ── Sole-bound-project routing ─────────────────────────────────────

/** When EXACTLY ONE project is bound, plain text and voice route to it
 *  ("send project to assistant" - the phone becomes that project's remote
 *  input). With zero or several bindings, text stays an assistant message
 *  and /tell picks the target. Lazy import keeps prefs.ts light for the
 *  settings window (projectBridge pulls chatStore).
 */
async function soleBoundTarget(): Promise<string | null> {
  try {
    const { listBoundProjects } = await import("./projectBridge");
    const bound = await listBoundProjects();
    const entries = Object.entries(bound);
    return entries.length === 1 ? entries[0]![0] : null;
  } catch {
    return null;
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
    case "/projects": {
      await reply(await formatProjectsStatus());
      return;
    }
    case "/tell": {
      // /tell <message> when EXACTLY ONE project is monitored - the whole
      // argument routes to it, no name needed. /tell <name> <message>
      // names the target when several are bound; a first token that NAMES
      // the sole project still takes the explicit form. No assistant turn
      // is consumed either way.
      const sole = await soleBoundProject();
      const firstSpace = arg.indexOf(" ");
      const firstToken = firstSpace === -1 ? arg : arg.slice(0, firstSpace);
      const namesSole =
        sole !== null &&
        (firstToken.toLowerCase() === sole.id.toLowerCase() ||
          firstToken.toLowerCase() === sole.binding.name.toLowerCase());
      if (!arg) {
        await reply(
          sole
            ? `Usage: /tell <message> - it goes to ${sole.binding.name}.`
            : "Usage: /tell <project-name> <message> - prompt a monitored project's agent.",
        );
        await reply(await formatProjectsStatus());
        return;
      }
      if (sole && !namesSole) {
        // Sole monitored project + the first token is not its name/id: the
        // ENTIRE argument is the message.
        const outcome = await tellProject(sole.id, arg, chatId);
        await reply(outcome);
        return;
      }
      if (firstSpace === -1 || !arg.slice(firstSpace + 1).trim()) {
        await reply("Usage: /tell <project-name> <message>");
        return;
      }
      const target = arg.slice(0, firstSpace);
      const message = arg.slice(firstSpace + 1).trim();
      const outcome = await tellProject(target, message, chatId);
      await reply(outcome);
      return;
    }
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
          "/projects - list monitored projects",
          "/tell <msg> - message the monitored project (add its name first when several are bound)",
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
    // Save the ORIGINAL bytes to the scratch dir — the same reference model
    // the assistant already uses for documents/videos. History persists only
    // this path (photos.ts explains why), and recent photos rehydrate from
    // it. The model call itself gets a downscaled copy (≤1568px — Claude
    // downscales beyond that server-side anyway), best-effort.
    const root = await assistantRoot();
    const sep = root.includes("\\") ? "\\" : "/";
    const path = `${root}${sep}photo-${Date.now()}.jpg`;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await invoke("fs_write_file_bytes", { path, bytes: Array.from(bytes), workspace: null });
    void prunePhotoScratch(root, sep);
    const small = await downscalePhotoJpeg(b64);
    pendingQueue.push({
      chatId,
      text: caption?.trim() || "What's in this image?",
      isVoice: false,
      imageBase64: small ?? b64,
      imageMime: "image/jpeg",
      imagePath: path,
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

/**
 * Repeating "typing…" indicator for the duration of an assistant turn.
 *
 * Telegram's sendChatAction shows the status for ~5s per call; a long agent
 * run (tools, media generation) would go dark after that and the owner has
 * no way to tell a slow turn from a dead bot. This repeats the action every
 * 4s until cleared. Best-effort everywhere: fire-and-forget sends, timer
 * errors swallowed, and an idempotent clear so the settle path can't double-
 * clear or leak an interval.
 */
const TYPING_INTERVAL_MS = 4_000;
let typingStop: (() => void) | null = null;
function startTypingIndicator(token: string, chatId: number): void {
  stopTypingIndicator();
  void telegramNative.sendChatAction(token, chatId, "typing").catch(() => {});
  const timer = setInterval(
    () => void telegramNative.sendChatAction(token, chatId, "typing").catch(() => {}),
    TYPING_INTERVAL_MS,
  );
  typingStop = () => {
    clearInterval(timer);
    typingStop = null;
  };
}
function stopTypingIndicator(): void {
  typingStop?.();
  typingStop = null;
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
    // Tell the owner the message landed and work is happening — without
    // this a long tool run is indistinguishable from a dead bot.
    startTypingIndicator(token, next.chatId);
    const reply = await runAssistantTurn(next.text, {
      // Tool notices are progress, not conversation: sending one Telegram
      // message per tool step floods the chat. Log only — the final reply
      // (or the ⚠️ error below) is what the user sees.
      onNotice: (notice) => {
        console.debug("[kai:assistant]", notice);
      },
      imageBase64: next.imageBase64,
      imageMime: next.imageMime,
      imagePath: next.imagePath,
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
    stopTypingIndicator();
    turnInFlight = false;
    if (pendingQueue.length > 0) void drainQueue();
  }
}

// ── Voice message intake (called from the bridge for voiceFileId events) ────

export async function enqueueVoiceMessage(chatId: number, fileId: string): Promise<void> {
  // Voice transcription is shared by both routes; the routing decision is
  // made after the transcript exists (sole bound project -> project agent,
  // else an assistant turn).
  const soleTarget = await soleBoundTarget();
  const token = await getTelegramToken();
  if (!token) return;
  try {
    const wavB64 = await telegramNative.downloadVoice(token, fileId);
    const text = await transcribeVoice(wavB64);
    if (!text.trim()) {
      await telegramNative.sendMessage(token, chatId, "…(couldn't make out the audio)");
      return;
    }
    // Sole bound project: the voice transcript routes to the project agent
    // (no assistant turn). Otherwise it is an assistant message.
    if (soleTarget) {
      const { tellProject } = await import("./projectBridge");
      const outcome = await tellProject(soleTarget, text.trim(), chatId, true);
      await telegramNative.sendMessage(token, chatId, outcome).catch(() => {});
      return;
    }
    pendingQueue.push({ chatId, text, isVoice: true });
    void drainQueue();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await telegramNative.sendMessage(token, chatId, `⚠️ voice: ${msg.slice(0, 200)}`).catch(() => {});
  }
}
