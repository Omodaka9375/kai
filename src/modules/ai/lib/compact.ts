import type { ModelMessage } from "ai";

const ELISION_TEXT = "[elided to save context — see prior tool call in history]";

type ToolPart = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  [k: string]: unknown;
};

function approxBytes(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === "string") n += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content as ToolPart[]) {
        if (part.type === "text" && typeof part.text === "string")
          n += (part.text as string).length;
        else if (part.type === "tool-result")
          n += JSON.stringify(part.output ?? "").length;
        else if (part.type === "tool-call")
          n += JSON.stringify(part.input ?? "").length;
        else if (part.type === "file" && typeof part.data === "string")
          n += (part.data as string).length;
        else n += 64;
      }
    }
  }
  return n;
}

function elideToolResult(part: ToolPart): { changed: boolean; part: ToolPart } {
  if (part.type !== "tool-result") return { changed: false, part };
  if (
    part.output &&
    typeof part.output === "object" &&
    (part.output as { __elided?: boolean }).__elided
  ) {
    return { changed: false, part };
  }
  return {
    changed: true,
    part: {
      ...part,
      output: { type: "text", value: ELISION_TEXT, __elided: true },
    },
  };
}

function pathOfInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const p = (input as { path?: unknown }).path;
  return typeof p === "string" && p.length > 0 ? p : null;
}

function pathsOfInput(input: unknown): string[] {
  // batch_edit's shape is {edits: [{path}, ...]} — no top-level path. Every
  // listed file must count as "last mutated here" for compaction or a
  // pre-batch read_file survives as stale "current" content.
  if (!input || typeof input !== "object") return [];
  const edits = (input as { edits?: unknown }).edits;
  if (!Array.isArray(edits)) return [];
  const out: string[] = [];
  for (const e of edits) {
    if (!e || typeof e !== "object") continue;
    const p = (e as { path?: unknown }).path;
    if (typeof p === "string" && p.length > 0 && !out.includes(p)) out.push(p);
  }
  return out;
}

function collectLastMutationIdxPerPath(
  messages: ModelMessage[],
): Map<string, number> {
  const lastIdx = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as ToolPart[]) {
      if (part.type !== "tool-call") continue;
      const name = part.toolName;
      if (name === "batch_edit") {
        for (const p of pathsOfInput(part.input)) lastIdx.set(p, i);
      } else if (
        name === "edit" ||
        name === "replace_exact" ||
        name === "write_file" ||
        name === "create_directory"
      ) {
        const p = pathOfInput(part.input);
        if (p) lastIdx.set(p, i);
      }
    }
  }
  return lastIdx;
}

function collectLastReadIdxPerPath(
  messages: ModelMessage[],
): Map<string, number> {
  const lastIdx = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as ToolPart[]) {
      if (part.type !== "tool-call") continue;
      if (part.toolName !== "read_file") continue;
      const p = pathOfInput(part.input);
      if (p) lastIdx.set(p, i);
    }
  }
  return lastIdx;
}

function dropSupersededReads(messages: ModelMessage[]): {
  out: ModelMessage[];
  touched: boolean;
} {
  const lastMutationIdx = collectLastMutationIdxPerPath(messages);
  const lastReadIdx = collectLastReadIdxPerPath(messages);

  const callIdxToPath = new Map<string, string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as ToolPart[]) {
      if (part.type !== "tool-call" || part.toolName !== "read_file") continue;
      const p = pathOfInput(part.input);
      const id = part.toolCallId;
      if (p && typeof id === "string") callIdxToPath.set(id, p);
    }
  }

  let touched = false;
  const out = messages.map((m, i): ModelMessage => {
    if (!Array.isArray(m.content)) return m;
    let local = false;
    const nextContent = (m.content as ToolPart[]).map((part) => {
      if (part.type !== "tool-result") return part;
      const id = part.toolCallId;
      if (typeof id !== "string") return part;
      const path = callIdxToPath.get(id);
      if (!path) return part;
      // A read result is superseded only when something LATER changed or
      // re-read the same file. (A read that happens AFTER the last mutation
      // reflects current content and must be kept — the old global-set logic
      // wrongly elided verification reads.)
      const laterMutation = lastMutationIdx.get(path);
      const laterRead = lastReadIdx.get(path);
      const isStale =
        (laterMutation !== undefined && laterMutation > i) ||
        (laterRead !== undefined && laterRead > i);
      if (!isStale) return part;
      const r = elideToolResult(part);
      if (r.changed) local = true;
      return r.part;
    });
    if (!local) return m;
    touched = true;
    return { ...m, content: nextContent } as ModelMessage;
  });
  return { out, touched };
}

export type CompactResult = {
  messages: ModelMessage[];
  compacted: boolean;
  droppedCount: number;
  /** True when post-elision tokens still exceed the summarization threshold. */
  needsSummarization: boolean;
};

// ── Watch-fire elision ──────────────────────────────────────────────────
//
// Watch firings inject their result as a PERSISTENT user message (up to
// 2000 chars of stdout). Unlike tool results, nothing elided them: a long
// monitoring session (CI deploy polled every 10s for half an hour) stacked
// fire on fire, and EVERY later agent turn re-sent the whole stack — the
// model re-read (and often re-narrated) every firing since the watch began,
// and each response got slower ("watch firing replays the conversation").
//
// Same rationale as tool-result elision: an old firing has already served
// its purpose (the model reacted at fire time). Keep the last
// WATCH_KEEP_VERBATIM firings verbatim — the model may still be acting on
// them — and truncate older ones to a compact head (label + exit + poll
// count survive; the bulky stdout body goes).
const WATCH_MARKER_RE = /^\*\*Watch (?:fired|stopped)\*\*:/;
const WATCH_KEEP_VERBATIM = 2;
const WATCH_ELIDED_HEAD_CHARS = 240;

function firstTextOf(m: ModelMessage): string | null {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return null;
  for (const part of m.content as ToolPart[]) {
    if (part.type === "text" && typeof part.text === "string") return part.text;
  }
  return null;
}

/** Truncate a stale watch-fire message to its head, with a marker note. */
function elideWatchFire(m: ModelMessage): ModelMessage {
  const note =
    "\n[...older watch firing elided to save context — label/exit/poll above; full output was already reacted to]";
  if (typeof m.content === "string") {
    const head = { ...m, content: m.content.slice(0, WATCH_ELIDED_HEAD_CHARS) + note };
    return head as unknown as ModelMessage;
  }
  const parts = (m.content as ToolPart[]).map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return part;
    return { ...part, text: part.text.slice(0, WATCH_ELIDED_HEAD_CHARS) + note };
  });
  // Watch-fire injections are always user TEXT messages; the array form is
  // TextPart[] after the map above, but the local ToolPart[] view needs the
  // cast to satisfy ModelMessage's user-content union.
  return { ...m, content: parts } as unknown as ModelMessage;
}

export function elideStaleWatchFires(messages: ModelMessage[]): {
  out: ModelMessage[];
  touched: boolean;
} {
  const fireIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const t = firstTextOf(m);
    if (t && WATCH_MARKER_RE.test(t)) fireIdx.push(i);
  }
  if (fireIdx.length <= WATCH_KEEP_VERBATIM) return { out: messages, touched: false };
  const keepVerbatim = new Set(fireIdx.slice(-WATCH_KEEP_VERBATIM));
  let touched = false;
  const out = messages.map((m, i) => {
    if (keepVerbatim.has(i)) return m; // newest fires stay verbatim
    if (!fireIdx.includes(i)) return m; // not a watch fire
    touched = true;
    return elideWatchFire(m);
  });
  return { out, touched };
}

export function compactModelMessages(
  messages: ModelMessage[],
  contextLimit: number,
): ModelMessage[] {
  return compactModelMessagesDetailed(messages, contextLimit).messages;
}

/**
 * Estimated tokens consumed by the system prompt + tool definitions that
 * are NOT included in the conversation messages but DO count against the
 * model's context window. This overhead is subtracted from the context
 * limit before computing thresholds.
 *
 * - System prompt: ~3–6k tokens (SYSTEM_PROMPT + persona + custom instructions)
 * - Tool schemas (15+ tools): ~8–12k tokens
 * - Cache/structural overhead: ~2k tokens
 * Total: ~15–20k. We use 18k as a safe middle estimate.
 */
export const SYSTEM_OVERHEAD_TOKENS = 18_000;

/**
 * Conversation budget after subtracting the system prompt + tool schemas.
 * This is the denominator every compaction threshold is measured against —
 * the UI context ring uses it too so both show the same pressure.
 */
export function effectiveContextLimit(contextLimit: number): number {
  return Math.max(contextLimit - SYSTEM_OVERHEAD_TOKENS, 8_000);
}

/** Max characters to keep from a truncated tool result body. */
const TOOL_RESULT_TRUNCATE_CHARS = 3_000;

/** Base64 payloads above this are UI-only media (image generation output) —
 *  stripped from model-bound history. Below it, leave alone. */
const BASE64_STRIP_MIN_CHARS = 1_024;

/** Max characters for a single string field inside a tool-call INPUT.
 *  Large inputs (e.g. display_image's base64_data) are truncated after the
 *  call completes — the model never needs the payload back, but the history
 *  re-sends it on every step otherwise. */
const TOOL_INPUT_FIELD_TRUNCATE_CHARS = 300;

const BULKY_INPUT_TOOLS = new Set(["display_image"]);

/** Truncate bulky string fields in tool-call inputs (base64 payloads).
 *  Only applies to tools whose inputs are known to be huge and opaque. */
function truncateBulkyToolInputs(part: ToolPart): { changed: boolean; part: ToolPart } {
  if (part.type !== "tool-call") return { changed: false, part };
  if (!BULKY_INPUT_TOOLS.has(String(part.toolName ?? ""))) return { changed: false, part };
  const input = part.input;
  if (!input || typeof input !== "object") return { changed: false, part };
  const rec = input as Record<string, unknown>;
  let touched = false;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (
      typeof v === "string" &&
      v.length > TOOL_INPUT_FIELD_TRUNCATE_CHARS &&
      /^[A-Za-z0-9+/=\r\n]+$/.test(v.slice(0, 256))
    ) {
      next[k] =
        v.slice(0, TOOL_INPUT_FIELD_TRUNCATE_CHARS) +
        `[...${v.length - TOOL_INPUT_FIELD_TRUNCATE_CHARS} chars elided]`;
      touched = true;
    } else {
      next[k] = v;
    }
  }
  if (!touched) return { changed: false, part };
  return { changed: true, part: { ...part, input: next } };
}

/**
 * Strip large base64 payloads from tool results — ALWAYS ON.
 *
 * Media-task tools (generate_image / generate_video) return a small
 * {status:"generating"} placeholder to the model at call time, then
 * spawnMediaTask patches the REAL payload (megabytes of image base64)
 * into the UI tool part via resolveMedia (chatStore). The payload is
 * UI-only — MediaMessage renders the image from it — but on every later
 * turn the history rebuild stringifies it into the tool message: the model
 * can't read base64-as-text, it just burns context. Same bug class as the
 * look_at_screen dataUrl below. Threshold-gated so small payloads (icons,
 * short fields) stay untouched.
 *
 * Tolerates BOTH shapes: the converted {type:"json", value:{...}} and a
 * raw output object (defensive for direct callers).
 */
function stripLargeToolResultBase64(part: ToolPart): {
  changed: boolean;
  part: ToolPart;
} {
  if (part.type !== "tool-result") return { changed: false, part };
  const output = part.output;
  if (!output || typeof output !== "object") return { changed: false, part };
  const rec = output as {
    type?: string;
    value?: { base64?: unknown } & Record<string, unknown>;
    base64?: unknown;
  };
  const valueIsObj =
    rec.type === "json" && rec.value !== null && typeof rec.value === "object";
  const src: Record<string, unknown> = valueIsObj
    ? (rec.value as Record<string, unknown>)
    : (rec as Record<string, unknown>);
  const converted = valueIsObj;
  if (
    typeof src.base64 !== "string" ||
    src.base64.length <= BASE64_STRIP_MIN_CHARS
  ) {
    return { changed: false, part };
  }
  const { base64, ...rest } = src as { base64: string } & Record<string, unknown>;
  return {
    changed: true,
    part: {
      ...part,
      output: converted
        ? {
            ...rec,
            value: {
              ...rest,
              base64Removed: true,
              base64Chars: base64.length,
            },
          }
        : { ...rest, base64Removed: true, base64Chars: base64.length },
    },
  };
}

/**
 * Strip screenshot dataUrls from look_at_screen tool results — ALWAYS ON.
 *
 * The image reaches the model ONCE via toModelOutput (an image-data part in
 * the tool-result content). Later turns rebuild history through
 * convertToModelMessages WITHOUT a tools map, so toModelOutput does NOT run
 * again: the output lands as {type:"json", value:{image:{dataUrl}}} and gets
 * stringified — megabytes of base64 as raw text on every subsequent request,
 * which models report as "raw data I can't interpret". Strip the payload,
 * keep the metadata (monitor/resolution).
 *
 * Tolerates BOTH shapes: the converted {type:"json", value:{...}} (what this
 * pipeline actually sees) and a raw {image:{dataUrl}} output (defensive for
 * any future direct caller).
 */
function stripScreenshotDataUrl(part: ToolPart): { changed: boolean; part: ToolPart } {
  if (part.type !== "tool-result" || part.toolName !== "look_at_screen") {
    return { changed: false, part };
  }
  const output = part.output;
  if (!output || typeof output !== "object") return { changed: false, part };
  const rec = output as {
    type?: string;
    value?: { image?: { dataUrl?: unknown } };
    image?: { dataUrl?: unknown };
  };
  const converted = rec.type === "json" && rec.value && typeof rec.value === "object";
  const src = converted ? rec.value! : rec;
  if (!src.image || typeof src.image.dataUrl !== "string") {
    return { changed: false, part };
  }
  return {
    changed: true,
    part: {
      ...part,
      output: converted
        ? { ...rec, value: { ...rec.value!, image: { dataUrlRemoved: true } } }
        : { ...rec, image: { dataUrlRemoved: true } },
    },
  };
}

function truncateLargeToolResult(part: ToolPart): { changed: boolean; part: ToolPart } {
  if (part.type !== "tool-result") return { changed: false, part };
  const output = part.output;
  if (output == null) return { changed: false, part };
  const str = typeof output === "string" ? output : JSON.stringify(output);
  if (str.length <= TOOL_RESULT_TRUNCATE_CHARS) return { changed: false, part };
  return {
    changed: true,
    part: {
      ...part,
      output: {
        type: "text",
        value: str.slice(0, TOOL_RESULT_TRUNCATE_CHARS) +
          `\n[...truncated ${str.length - TOOL_RESULT_TRUNCATE_CHARS} chars to save context]`,
        __truncated: true,
      },
    },
  };
}

export function compactModelMessagesDetailed(
  messages: ModelMessage[],
  contextLimit: number,
): CompactResult {
  let dropped = 0;
  let working = messages;
  let approxTokens = approxBytes(working) / 4;

  // The effective budget for conversation is the context limit minus the
  // system prompt + tool definitions that are added later by runAgentStream.
  const effectiveLimit = effectiveContextLimit(contextLimit);

  // ── Phase 1: drop superseded reads (stale file content) ──
  // Trigger earlier — at 40% of effective limit, not 50%.
  if (approxTokens >= 0.4 * effectiveLimit) {
    const r = dropSupersededReads(working);
    if (r.touched) {
      working = r.out;
      dropped++;
      approxTokens = approxBytes(working) / 4;
    }
  }

  // ── Phase 1.5: elide bulky tool-call inputs (base64 payloads) and strip
  // screenshot dataUrls / media-task base64 from tool results — all ALWAYS
  // ON. A single display_image call is hundreds of KB and every later step
  // re-sends it; there is no scenario where the model needs the raw payload
  // back after the call completed. The screenshot dataUrl and the patched
  // generate_image base64 are UI-only (the model received the image via a
  // tool-result part at call time, or never — the media path is UI-only).
  {
    let localDropped = 0;
    working = working.map((m): ModelMessage => {
      if (!Array.isArray(m.content)) return m;
      let touched = false;
      const nextContent = (m.content as ToolPart[]).map((part) => {
        const a = truncateBulkyToolInputs(part);
        if (a.changed) touched = true;
        const b = stripScreenshotDataUrl(a.part);
        if (b.changed) touched = true;
        const c = stripLargeToolResultBase64(b.part);
        if (c.changed) touched = true;
        return c.part;
      });
      if (!touched) return m;
      localDropped++;
      return { ...m, content: nextContent } as ModelMessage;
    });
    if (localDropped > 0) {
      dropped += localDropped;
      approxTokens = approxBytes(working) / 4;
    }
  }

  // ── Phase 2: truncate large tool results ──
  // Also elide stale watch firings here (before truncation thresholds):
  // watch fires are persistent USER messages nothing else elides, so a long
  // monitoring session re-sends every firing on every turn.
  {
    const r = elideStaleWatchFires(working);
    if (r.touched) {
      working = r.out;
      dropped++;
      approxTokens = approxBytes(working) / 4;
    }
  }
  if (approxTokens >= 0.6 * effectiveLimit) {
    let localDropped = 0;
    working = working.map((m): ModelMessage => {
      if (!Array.isArray(m.content)) return m;
      let touched = false;
      const nextContent = (m.content as ToolPart[]).map((part) => {
        const r = truncateLargeToolResult(part);
        if (r.changed) touched = true;
        return r.part;
      });
      if (!touched) return m;
      localDropped++;
      return { ...m, content: nextContent } as ModelMessage;
    });
    if (localDropped > 0) {
      dropped += localDropped;
      approxTokens = approxBytes(working) / 4;
    }
  }

  // ── Phase 3: signal summarization ──
  // Summarize at 60% of effective limit (2026-10-31: lowered from 75% to
  // align with phase-2 truncation). The old 75% trigger left only 25%
  // headroom at SEND time - a single heavy step (30KB shell output +
  // follow-up reads) could push the request past the window before the
  // next send's maybeSummarize ran, surfacing a hard provider 400 while
  // the same session restarted fresh sailed through at low pressure.
  // 60% leaves a full 40% of headroom for the run that follows.
  return {
    messages: working,
    compacted: dropped > 0,
    droppedCount: dropped,
    needsSummarization: approxTokens >= 0.6 * effectiveLimit,
  };
}
