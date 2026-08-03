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

function collectMutationPaths(messages: ModelMessage[]): Set<string> {
  const paths = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as ToolPart[]) {
      if (part.type !== "tool-call") continue;
      const name = part.toolName;
      if (
        name === "edit" ||
        name === "multi_edit" ||
        name === "write_file" ||
        name === "create_directory"
      ) {
        const p = pathOfInput(part.input);
        if (p) paths.add(p);
      }
    }
  }
  return paths;
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
  const mutated = collectMutationPaths(messages);
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
      const isStale =
        mutated.has(path) ||
        (lastReadIdx.has(path) && (lastReadIdx.get(path) as number) > i);
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
const SYSTEM_OVERHEAD_TOKENS = 18_000;

/** Max characters to keep from a truncated tool result body. */
const TOOL_RESULT_TRUNCATE_CHARS = 3_000;

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
  const effectiveLimit = Math.max(contextLimit - SYSTEM_OVERHEAD_TOKENS, 8_000);

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

  // ── Phase 2: truncate large tool results ──
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
  // Summarize at 75% of effective limit (unified with phases 1 & 2).
  // Leaves 25% headroom for the summarization call itself.
  return {
    messages: working,
    compacted: dropped > 0,
    droppedCount: dropped,
    needsSummarization: approxTokens >= 0.75 * effectiveLimit,
  };
}
