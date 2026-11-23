/**
 * Local Reflex - Needle 3 pre-LLM fast path (2026-11-23).
 *
 * Short desktop-control prompts ("switch to dark mode", "play groove salad",
 * "remind me in 15 minutes to stretch") are classified by the local Needle 3
 * engine (fine-tuned `kai-desktop-v1`, ~100 ms CPU) BEFORE any cloud request.
 * A confident, auto-approve-safe call executes locally: zero cloud prefill,
 * zero tokens, works offline. Anything else (`[]`, low confidence, engine
 * unreachable, non-allowlisted tool) falls through to the normal LLM path
 * untouched.
 *
 * Safety rails (all enforced here, never trusted to the model):
 *  - Only AUTO-APPROVE-SAFE tools are executable (settings cosmetics, radio,
 *    voice, reminders, persona switch, localhost preview). Anything else in
 *    the engine output is a fall-through, never an execution.
 *  - RANGE VALIDATION on every numeric argument: the Cactus decode grammar
 *    CLIPS out-of-range numbers ("font size 96" -> 9), so a clipped value
 *    must be rejected, not executed.
 *  - open_preview accepts only http/https localhost URLs (mirrors the real
 *    tool's own guard).
 *  - The engine client is fail-open: any error/timeout/unreachable state
 *    returns null and the prompt goes to the cloud LLM as before. A failed
 *    probe is cached for 60 s so an absent engine costs nothing per message.
 *
 * Engine: `cactus --model kai-desktop-v1-12L.cact --tools narrow_tools.json
 * --serve` (POST /complete {input}). Endpoint overridable via
 * localStorage["kai.localReflexEndpoint"]; disable entirely with
 * localStorage["kai.localReflex"] = "off".
 */

/** Confidence gate: below this the prompt falls through to the cloud LLM.
 *  Calibrated by bench.py on the frozen suite: 12L at 0.75 = 0 coding
 *  hijacks, 9.1% wrong-local. */
export const REFLEX_CONFIDENCE_GATE = 0.75;

/** Max prompt length the reflex will consider (chars). Longer prompts are
 *  coding/workspace-shaped by definition and go straight to the LLM. */
export const REFLEX_MAX_PROMPT_CHARS = 160;

/** Needle narrow-schema tool names the reflex may execute. Every mapped
 *  canonical target is needsApproval: false in the tool registry (settings
 *  cosmetics, radio, voice, reminders, persona switch, localhost preview) -
 *  verified by localReflex tests against the drift-gated inventory. */
export const REFLEX_ALLOWED_NARROW_TOOLS = new Set([
  "get_settings",
  "set_ui_theme",
  "set_color_mode",
  "set_editor_theme",
  "set_vim_mode",
  "set_word_wrap",
  "set_show_hidden_files",
  "set_terminal_webgl",
  "set_terminal_font_size",
  "set_terminal_scrollback",
  "set_zoom_level",
  "play_radio",
  "stop_radio",
  "radio_list_stations",
  "radio_now_playing",
  "set_voice_settings",
  "set_timer_reminder",
  "schedule_reminder",
  "reminder_list",
  "reminder_cancel",
  "set_persona",
  "open_preview",
]);

/** Canonical KAI tools the executor will run (post-mapping). */
export const REFLEX_ALLOWED_CANONICAL_TOOLS = new Set([
  "settings",
  "settings_update",
  "play_radio",
  "stop_radio",
  "radio_list_stations",
  "radio_now_playing",
  "voice_settings",
  "reminder_create",
  "reminder_list",
  "reminder_cancel",
  "set_persona",
  "open_preview",
]);

/** Numeric bounds mirrored from the runtime narrow_tools schema. A Needle
 *  call outside these bounds was GRAMMAR-CLIPPED, not grounded. */
const RANGE_CHECKS: Record<string, { min: number; max: number }> = {
  font_size: { min: 8, max: 32 },
  lines: { min: 200, max: 50000 },
  zoom: { min: 0.5, max: 2 },
  minutes: { min: 1, max: 10080 },
  hours: { min: 1, max: 168 },
};

export type NarrowCall = { name: string; arguments: Record<string, unknown> };
export type CanonicalCall = { name: string; arguments: Record<string, unknown> };

/** True if a numeric argument violates the schema bounds (i.e. it was
 *  clipped by the decode grammar and must not be executed). */
export function isClippedByGrammar(
  _name: string,
  args: Record<string, unknown>,
): boolean {
  for (const [key, bounds] of Object.entries(RANGE_CHECKS)) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return true;
    if (n < bounds.min || n > bounds.max) return true;
  }
  return false;
}

const STATION_ALIASES: Record<string, string> = {
  "groove salad": "groovesalad",
  groovesalad: "groovesalad",
  defcon: "defcon",
  "def con": "defcon",
  "def con radio": "defcon",
  "drone zone": "dronezone",
  dronezone: "dronezone",
  "space station": "spacestation",
  "space station soma": "spacestation",
  spacestation: "spacestation",
  lush: "lush",
  "indie pop": "indiepop",
  "indie pop rocks": "indiepop",
  indiepop: "indiepop",
  "secret agent": "secretagent",
  secretagent: "secretagent",
  fluid: "fluid",
  "sonic universe": "sonicuniverse",
  sonicuniverse: "sonicuniverse",
  bagel: "bagel",
  "bagel radio": "bagel",
  "boot liquor": "bootliquor",
  bootliquor: "bootliquor",
  "the trip": "thetrip",
  thetrip: "thetrip",
};

const PERSONA_ALIASES: Record<string, string> = {
  none: "none",
  off: "none",
  "no persona": "none",
  "__none__": "none",
  coder: "coder",
  "builtin:coder": "coder",
  architect: "architect",
  "builtin:architect": "architect",
  reviewer: "reviewer",
  "code reviewer": "reviewer",
  "builtin:reviewer": "reviewer",
  security: "security",
  "builtin:security": "security",
  designer: "designer",
  "builtin:designer": "designer",
  researcher: "researcher",
  "builtin:researcher": "researcher",
  assistant: "assistant",
  general: "assistant",
  "builtin:general": "assistant",
};

function normStation(raw: unknown): string {
  const s = String(raw ?? "").trim().toLowerCase();
  return STATION_ALIASES[s] ?? s;
}

function normPersona(raw: unknown): string {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+persona$/, "")
    .trim();
  return PERSONA_ALIASES[s] ?? s;
}

function normMsg(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/^to\s+/i, "")
    .replace(/[.!]+$/, "");
}

function normUrl(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
}

/** open_preview is localhost-only (mirrors the real tool's own guard). */
function isLocalhostUrl(raw: unknown): boolean {
  const s = String(raw ?? "").trim();
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "0.0.0.0" ||
      u.hostname === "[::1]" ||
      u.hostname === "::1" ||
      u.hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

/**
 * Map Needle narrow-schema calls to canonical KAI tool calls.
 *
 * Consecutive settings calls in one turn merge into a single
 * `settings_update` (multi-intent prompts emit one call per intent). A call
 * that fails grounding/range validation returns null for the WHOLE turn:
 * a partially-executed multi-intent prompt is worse than an LLM round-trip.
 *
 * `now` is injectable for tests; production passes `new Date()`.
 */
export function mapNarrowCalls(
  calls: NarrowCall[],
  now: Date = new Date(),
): CanonicalCall[] | null {
  const out: CanonicalCall[] = [];
  let merged: Record<string, unknown> | null = null;

  const flushSettings = () => {
    if (merged && Object.keys(merged).length > 0) {
      out.push({ name: "settings_update", arguments: merged });
    }
    merged = null;
  };

  for (const call of calls) {
    const name = call.name;
    const args = call.arguments ?? {};
    // Any grammar-clipped numeric argument poisons the whole turn.
    if (isClippedByGrammar(name, args)) return null;

    switch (name) {
      case "get_settings":
        flushSettings();
        out.push({ name: "settings", arguments: {} });
        break;
      case "set_ui_theme":
        if (args.palette == null) return null;
        merged = { ...(merged ?? {}), uiThemeId: String(args.palette).toLowerCase() };
        break;
      case "set_color_mode":
        if (args.mode == null) return null;
        merged = { ...(merged ?? {}), theme: String(args.mode).toLowerCase() };
        break;
      case "set_editor_theme":
        if (args.editor_theme == null) return null;
        merged = { ...(merged ?? {}), editorTheme: String(args.editor_theme).toLowerCase() };
        break;
      case "set_vim_mode":
        if (args.enabled == null) return null;
        merged = { ...(merged ?? {}), vimMode: Boolean(args.enabled) };
        break;
      case "set_word_wrap":
        if (args.enabled == null) return null;
        merged = { ...(merged ?? {}), editorWordWrap: Boolean(args.enabled) };
        break;
      case "set_show_hidden_files":
        if (args.enabled == null) return null;
        merged = { ...(merged ?? {}), showHidden: Boolean(args.enabled) };
        break;
      case "set_terminal_webgl":
        if (args.enabled == null) return null;
        merged = { ...(merged ?? {}), terminalWebglEnabled: Boolean(args.enabled) };
        break;
      case "set_terminal_font_size":
        if (args.font_size == null) return null;
        merged = { ...(merged ?? {}), terminalFontSize: Math.round(Number(args.font_size)) };
        break;
      case "set_terminal_scrollback":
        if (args.lines == null) return null;
        merged = { ...(merged ?? {}), terminalScrollback: Math.round(Number(args.lines)) };
        break;
      case "set_zoom_level":
        if (args.zoom == null) return null;
        merged = { ...(merged ?? {}), zoomLevel: Math.round(Number(args.zoom) * 100) / 100 };
        break;
      case "play_radio": {
        flushSettings();
        const station = normStation(args.station);
        // Empty station = ungrounded free-text slot -> refuse the turn.
        if (!station) return null;
        out.push({ name: "play_radio", arguments: { station } });
        break;
      }
      case "stop_radio":
        flushSettings();
        out.push({ name: "stop_radio", arguments: {} });
        break;
      case "radio_list_stations":
        flushSettings();
        out.push({ name: "radio_list_stations", arguments: {} });
        break;
      case "radio_now_playing":
        flushSettings();
        out.push({ name: "radio_now_playing", arguments: {} });
        break;
      case "set_voice_settings": {
        flushSettings();
        const v: Record<string, unknown> = {};
        if (args.mode != null) v.mode = String(args.mode).toLowerCase();
        if (args.voice != null) v.voice = String(args.voice).toLowerCase();
        const asm = args.assembly_voice ?? args.assemblyVoice;
        if (asm != null) v.assemblyVoice = String(asm).toLowerCase();
        if (args.list === true) v.list = true;
        if (Object.keys(v).length === 0) return null;
        out.push({ name: "voice_settings", arguments: v });
        break;
      }
      case "set_timer_reminder": {
        flushSettings();
        const minutes = Number(args.minutes ?? 0);
        const hours = Number(args.hours ?? 0);
        const total = minutes + hours * 60;
        if (!Number.isFinite(total) || total <= 0) return null;
        const due = new Date(now.getTime() + total * 60_000);
        out.push({
          name: "reminder_create",
          arguments: { message: normMsg(args.message), dueAt: due.toISOString() },
        });
        break;
      }
      case "schedule_reminder": {
        flushSettings();
        const rawDue = String(args.due_at ?? "").trim();
        // The engine sees a system date fact; naive local times resolve here
        // against the wall clock. Unparseable dates refuse the turn.
        const due = new Date(rawDue);
        if (rawDue === "" || Number.isNaN(due.getTime())) return null;
        const r: Record<string, unknown> = {
          message: normMsg(args.message),
          dueAt: due.toISOString(),
        };
        if (args.repeat) r.repeat = String(args.repeat).toLowerCase();
        out.push({ name: "reminder_create", arguments: r });
        break;
      }
      case "reminder_list":
        flushSettings();
        out.push({ name: "reminder_list", arguments: {} });
        break;
      case "reminder_cancel": {
        flushSettings();
        const id = String(args.id ?? "").trim();
        if (!id) return null;
        out.push({ name: "reminder_cancel", arguments: { id } });
        break;
      }
      case "set_persona": {
        flushSettings();
        const persona = normPersona(args.persona);
        if (!persona) return null;
        out.push({ name: "set_persona", arguments: { persona } });
        break;
      }
      case "open_preview": {
        flushSettings();
        const url = normUrl(args.url);
        if (!isLocalhostUrl(url)) return null;
        out.push({ name: "open_preview", arguments: { url } });
        break;
      }
      default:
        // Unknown tool name from the engine: never execute, never guess.
        return null;
    }
  }
  flushSettings();
  return out;
}

// ── Engine client ─────────────────────────────────────────────────────────

type EngineReply = {
  function_calls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  confidence?: number | null;
  suppressed_calls?: unknown;
  resetOk?: boolean;
};

let engineDownUntil = 0;

export function reflexDisabled(): boolean {
  try {
    return localStorage.getItem("kai.localReflex") === "off";
  } catch {
    return false;
  }
}

export function markEngineUnavailable(): void {
  engineDownUntil = Date.now() + 60_000;
}

export function engineRecentlyDown(): boolean {
  return Date.now() < engineDownUntil;
}

/** Ask the local Needle engine to classify the prompt. Returns null when the
 *  engine is disabled/unreachable/slow (any of which means "use the LLM").
 *  Before the FIRST probe after an engine-down window, ask the Rust bridge
 *  to ensure the downloaded engine is running (no-op when it already is).
 *  Latency is reported so the caller can journal it. */
export async function classifyWithEngine(
  prompt: string,
): Promise<{
  calls: NarrowCall[];
  confidence: number;
  latencyMs: number;
} | null> {
  const t0 = Date.now();
  if (engineRecentlyDown()) {
    // One ensure attempt per down-window: cheap when ready, idempotent when
    // not installed, and it revives the path after an engine restart.
    const { ensureReflexEngine } = await import("./reflexBridge");
    if (!(await ensureReflexEngine())) return null;
    engineDownUntil = 0; // bridge says the engine answers; retry below
  }
  if (reflexDisabled() || engineRecentlyDown()) return null;
  // CORRECTNESS NOTE: the classification MUST go through the Rust command
  // (native.reflexClassify), NOT a webview fetch: the engine serves no
  // CORS headers, so the webview's fetch to 127.0.0.1:8941 is blocked by
  // WebView2 (every early real-usage prompt logged reason "no-reply" —
  // the engine was running fine the whole time). The reset-after-reply
  // also lives in the Rust command now.
  const { native } = await import("./native");
  let reply: EngineReply | null = null;
  try {
    reply = (await native.reflexClassify(prompt)) as EngineReply;
  } catch {
    markEngineUnavailable();
    return null;
  }
  const calls = reply?.function_calls ?? [];
  const confidence = typeof reply?.confidence === "number" ? reply.confidence : 0;
  return { calls, confidence, latencyMs: Date.now() - t0 };
}

// ── Reflex decision (pure, testable) ──────────────────────────────────────

export type ReflexDecision =
  | { action: "execute"; calls: CanonicalCall[]; confidence: number }
  | { action: "fallthrough"; reason?: string };

/**
 * Conversational acknowledgments ("yes", "continue", "ok") look like
 * commands to the model out of context — live-probed: "continue" ->
 * play_radio 0.88, "no" -> set_voice_settings 0.82, "stop" -> stop_radio
 * 0.89, all ABOVE the gate and would have executed. In a chat these are
 * answers to a previous question and only the LLM has the conversation
 * context to interpret them. Exact-match guard, cheap and deterministic.
 */
const CONVERSATIONAL_PROMPTS = new Set([
  "y", "n", "yes", "no", "yeah", "yep", "yup", "nope", "ok", "okay",
  "sure", "sure thing", "go ahead", "go on", "continue", "continue?",
  "proceed", "continue please", "keep going", "carry on", "stop", "wait",
  "hmm", "hm", "fine", "agreed", "good", "correct", "please do", "do it",
  "confirm", "confirmed", "abort", "skip", "next", "done", "thanks",
]);

/**
 * STALL/INTERJECTION prefix guard: "wait ...", "hold on ...", "give me a
 * second", "one moment" — user is pausing or addressing the assistant
 * mid-flow; these classified as confident tool calls live ("give me a
 * second" -> play_radio 0.93, "wait I have the bug list" ->
 * radio_list_stations 0.83). Like bare acks, only the LLM has the context
 * to interpret them.
 */
const STALL_PREFIXES = [
  "wait", "hold on", "hold up", "just a moment", "one moment",
  "give me a second", "give me a moment", "let me", "one sec", "hang on",
];

export function isConversationalAck(prompt: string): boolean {
  const p = prompt.trim().toLowerCase();
  if (CONVERSATIONAL_PROMPTS.has(p)) return true;
  // Prefix match: "wait i have the bug list" starts with "wait " — the
  // sentence continues but the intent is conversational, not a command.
  // EXCEPT: "wait 5 seconds" / "wait for 10 minutes" are real sleep
  // commands — the word right after the prefix is a NUMBER.
  const stall = STALL_PREFIXES.find(
    (pre) => p === pre || p.startsWith(pre + " ") || p.startsWith(pre + ","),
  );
  if (stall === undefined) return false;
  const rest = p.slice(stall.length).trim();
  if (/^for\s+\d/.test(rest) || /^\d/.test(rest)) return false;
  return true;
}

/**
 * Pure decision: given the engine reply for a prompt, decide execute vs
 * fall-through. Enforces the confidence gate, the tool allowlist, and the
 * mapper's grounding rules (which return null on any ungrounded call).
 */
export function decideReflex(
  prompt: string,
  reply: { calls: NarrowCall[]; confidence: number } | null,
): ReflexDecision {
  if (!reply) return { action: "fallthrough", reason: "no-reply" };
  if (prompt.length > REFLEX_MAX_PROMPT_CHARS) {
    return { action: "fallthrough", reason: "long-prompt" };
  }
  if (isConversationalAck(prompt)) {
    return { action: "fallthrough", reason: "conversational" };
  }
  if (reply.confidence < REFLEX_CONFIDENCE_GATE) {
    return { action: "fallthrough", reason: "low-confidence" };
  }
  if (reply.calls.length === 0) return { action: "fallthrough", reason: "empty-calls" };
  if (reply.calls.some((c) => !REFLEX_ALLOWED_NARROW_TOOLS.has(c.name))) {
    return { action: "fallthrough", reason: "disallowed-tool" };
  }
  const mapped = mapNarrowCalls(reply.calls);
  if (!mapped) return { action: "fallthrough", reason: "unmapped" };
  if (mapped.some((c) => !REFLEX_ALLOWED_CANONICAL_TOOLS.has(c.name))) {
    return { action: "fallthrough", reason: "disallowed-tool" };
  }
  return { action: "execute", calls: mapped, confidence: reply.confidence };
}
