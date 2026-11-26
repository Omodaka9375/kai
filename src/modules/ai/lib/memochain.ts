/**
 * MemoChain embedded memory handler (per-model toggle, 2026-11-26).
 *
 * Replaces the external `proxy-custom` HTTP slot: instead of routing requests
 * through the standalone MemoChain proxy process (Settings → Models → Proxy
 * endpoint), KAI now performs the exact same memory fold IN-PROCESS through
 * the bundled Rust module (`src-tauri/src/modules/memochain/`), driven by the
 * distilled student weights shipped as a Tauri resource
 * (`src-tauri/resources/memochain/weights.bin`, SHA-256-verified on load).
 *
 * What this file owns (the TS half of the split):
 *   1. Per-message hashing + token estimation (must match Python
 *      `memochain.server.session` `message_hash`/`estimate_tokens` byte for
 *      byte: the same sanitized session dir + folded-hash prefix bookkeeping
 *      is shared with the standalone tooling).
 *   2. Hot-window overflow detection: when the non-system history exceeds the
 *      hot limit, the oldest atomic groups (assistant tool_calls fused with
 *      their tool results — never split) are handed to `memochain_fold`, which
 *      writes capsule.bin/meta.json/receipts.jsonl under
 *      `app_local_data_dir()/memochain/<session_id>/`.
 *   3. Recalled-memory injection: the folded summary + top-K verbatim chunks
 *      ride the outgoing prompt as a `[Durable memory]` system block — the same
 *      shape the standalone proxy injected, so the model-side behavior is
 *      unchanged from the proxy era.
 *
 * Because the capsule state is a Q14 fast-weight tensor and the receipt chain
 * is a plain SHA-256 accumulator over (step|prev|doc|state) bindings, every
 * fold is independently verifiable offline by the standalone MemoChain
 * Python tooling — KAI's own `memochain_verify` command re-derives the chain
 * from receipts.jsonl without any trust in the writer.
 */

import type { ModelMessage } from "ai";
import type { UIMessage } from "ai";
import { native, type MemoChainFoldEntry, type MemoChainRecalledChunk } from "./native";
import type { FenceState } from "./fence";
import { fence } from "./fence";

/** SHA-256 hex digest via Web Crypto. Deliberately NOT node:crypto — this
 *  module ships in the browser bundle, where `node:crypto` externalizes to
 *  an empty stub and the named import fails the vite build (same reason
 *  mcpOAuth.ts uses subtle.digest). `subtle` is available both in the
 *  renderer and in Node ≥19 (webcrypto global), so tests run the same code
 *  path as production. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Hot-window budget in ~4-char tokens (matches the standalone proxy default). */
export const MEMOCHAIN_HOT_LIMIT = 80_000;
/** Never fold below this many tokens even when the window overflows. */
export const MEMOCHAIN_KEEP_MIN = 40_000;
/** Per-document clip before embedding (matches Python `max_doc_chars`). */
export const MEMOCHAIN_MAX_DOC_CHARS = 2000;
/** Verbatim chunk recall depth (top-K hybrid search results injected). */
export const MEMOCHAIN_RECALL_TOP_K = 4;

/** Cheap token estimate (~4 chars per token); matches Python estimate_tokens. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 4));
}

/** Stable content hash of one message (role, text, tool ids) — SHA-256 of the
 *  same JSON payload Python `message_hash` builds, so a message hashed in KAI
 *  lands in the same bucket as one hashed by the standalone proxy. */
export async function messageHash(msg: ModelMessage): Promise<string> {
  const payload = JSON.stringify(
    {
      role: msg.role,
      content: msg.content,
      // ModelMessage tool fields (assistant tool_calls / tool toolCallId+name).
      tool_calls: (msg as { tool_calls?: unknown }).tool_calls,
      tool_call_id: (msg as { tool_call_id?: unknown }).tool_call_id,
      name: (msg as { name?: unknown }).name,
    },
    // default=str mirrors the Python json.dumps(default=str) fallback.
    (_k, v) => (v === undefined ? undefined : v),
  );
  // Same digest the standalone Python tooling computes with
  // hashlib.sha256(...).hexdigest() — parity is what makes capsules folded
  // here verifiable by the original toolchain.
  return sha256Hex(payload);
}

/** Comparable text of one ModelMessage (mirrors Python `message_text`). */
export function messageText(msg: ModelMessage): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const block of c) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && typeof block === "object" && "text" in block) {
        const t = (block as { text?: unknown }).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/** Atomic eviction units: an assistant message carrying tool_calls groups with
 *  the tool result messages that answer it (matches Python `eviction_groups`).
 *  Group boundaries are what keep tool calls and their results from being
 *  split across the fold boundary. */
export function evictionGroups(messages: ModelMessage[]): Array<[number, number]> {
  const groups: Array<[number, number]> = [];
  let i = 0;
  const n = messages.length;
  while (i < n) {
    const m = messages[i];
    if (m.role === "assistant" && Array.isArray((m as { tool_calls?: unknown }).tool_calls)) {
      const calls = (m as unknown as { tool_calls: Array<{ id?: string }> }).tool_calls;
      const ids = new Set(calls.map((tc) => tc?.id).filter(Boolean));
      let j = i + 1;
      while (j < n && messages[j].role === "tool" && ids.has((messages[j] as { tool_call_id?: string }).tool_call_id ?? "")) {
        j += 1;
      }
      groups.push([i, j]);
      i = j;
    } else {
      groups.push([i, i + 1]);
      i += 1;
    }
  }
  return groups;
}

export type FoldStats = {
  foldedMessages: number;
  foldedTokens: number;
  step: number;
  stateDigest: string;
  receiptRows: number;
  chunkCount: number;
  capsuleBytes: number;
};

/** Fold the given overflow groups into the session capsule. All-or-nothing:
 *  a failed fold throws and the caller keeps the full hot window (never a
 *  partial fold — the capsule chain is append-only and must stay consistent
 *  with meta.json). */
export async function foldMessages(
  sessionId: string,
  msgs: ModelMessage[],
): Promise<FoldStats> {
  const entries: MemoChainFoldEntry[] = [];
  for (const m of msgs) {
    const t = messageText(m).trim();
    if (!t) continue;
    entries.push({
      msgHash: await messageHash(m),
      role: m.role,
      text: t.slice(0, MEMOCHAIN_MAX_DOC_CHARS),
    });
  }
  if (entries.length === 0) {
    entries.push({
      msgHash: await sha256Hex("(empty tool exchange)"),
      role: "user",
      text: "(empty tool exchange)",
    });
  }
  const res = await native.memochainFold(sessionId, entries);
  return {
    foldedMessages: msgs.length,
    foldedTokens: msgs.reduce((acc, m) => acc + estimateTokens(messageText(m)), 0),
    step: res.step,
    stateDigest: res.stateDigest,
    receiptRows: res.receiptRows,
    chunkCount: res.chunkCount,
    capsuleBytes: 22_606, // v1 capsule envelope is constant-size
  };
}

export type MemoryBlockResult = {
  memoryBlock: string;
  recalledChunks: MemoChainRecalledChunk[];
  summary: string;
  step: number;
};

/** Build the `[Durable memory]` system block for the current turn: the folded
 *  summary plus top-K verbatim chunks recalled against the last user text.
 *  Returns an empty block when the session has no memory yet. */
export async function buildMemoryBlock(
  sessionId: string,
  lastUserText: string,
): Promise<MemoryBlockResult | null> {
  const recall = await native.memochainRecall(sessionId, lastUserText, MEMOCHAIN_RECALL_TOP_K);
  if (!recall.summary && recall.chunks.length === 0) return null;
  const sections: string[] = [
    "[Durable memory]",
    "Compressed notes from earlier parts of this session (older than what you can see here):",
  ];
  if (recall.summary) sections.push(recall.summary);
  if (recall.chunks.length > 0) {
    sections.push("");
    sections.push("Relevant verbatim turns recalled for the current question:");
    for (const item of recall.chunks) {
      let snippet = item.text.replace(/\n/g, " ").trim();
      if (snippet.length > 600) snippet = snippet.slice(0, 600) + "...";
      sections.push(`- [${item.role}] ${snippet}`);
    }
  }
  return {
    memoryBlock: sections.join("\n"),
    recalledChunks: recall.chunks,
    summary: recall.summary,
    step: recall.step,
  };
}

export type FoldDecision = {
  /** Indices [start, end) into the NON-system message list to fold. */
  foldStart: number;
  foldEnd: number;
  /** Post-fold hot token estimate. */
  hotTokens: number;
  overflow: boolean;
};

/** Decide what (if anything) to fold: walk atomic eviction groups from the
 *  oldest end while the hot window exceeds HOT_LIMIT and the remainder stays
 *  above KEEP_MIN. Never folds the final group (the active turn). */
export function decideFold(
  messages: ModelMessage[],
  hotLimit = MEMOCHAIN_HOT_LIMIT,
  keepMin = MEMOCHAIN_KEEP_MIN,
): FoldDecision {
  const groups = evictionGroups(messages);
  const total = messages.reduce((acc, m) => acc + estimateTokens(messageText(m)), 0);
  const keepFloor = Math.min(keepMin, hotLimit);
  if (total <= hotLimit || groups.length <= 1) {
    return { foldStart: 0, foldEnd: 0, hotTokens: total, overflow: false };
  }
  let remaining = total;
  let evictEnd = 0;
  const lastUserIdx = findLastIdx(messages, (m) => m.role === "user");
  for (const [start, end] of groups.slice(0, -1)) {
    // Never evict the last remaining user message.
    if (lastUserIdx >= 0 && end > lastUserIdx) break;
    const groupTokens = messages
      .slice(start, end)
      .reduce((acc, m) => acc + estimateTokens(messageText(m)), 0);
    if (remaining - groupTokens < keepFloor) break;
    remaining -= groupTokens;
    evictEnd = end;
  }
  return {
    foldStart: 0,
    foldEnd: evictEnd,
    hotTokens: remaining,
    overflow: evictEnd > 0,
  };
}

function findLastIdx<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

export type FoldPrefixResult = {
  foldedMessages: number;
  step: number;
  stateDigest: string;
};

/** Build the full system-prompt memory section for a MemoChain-toggled
 *  session: rolling summary (unfenced, it is KAI-authored state) + the
 *  top-K recalled verbatim turns (FENCED — stored text is untrusted-at-rest,
 *  same trust boundary as tool output). Returns null when the session has no
 *  memory yet or recall fails (fresh session / fail-open). */
export async function memoChainMemoryBlock(
  sessionId: string,
  history: ModelMessage[],
  fenceState?: import("./fence").FenceState,
): Promise<string | null> {
  try {
    const lastUserText = lastUserQuery(history);
    const result = await buildMemoryBlock(sessionId, lastUserText);
    if (!result) return null;
    const sections: string[] = [result.memoryBlock];
    // Recalled chunks are raw stored text — fence them when a fence state is
    // available (agent passes opts.fenceState). Without one (headless calls)
    // the recall section is omitted rather than injected unfenced.
    if (result.recalledChunks.length > 0 && fenceState) {
      const fenced = renderRecalledFence(result.recalledChunks, fenceState);
      // Swap the plain recall list for the fenced render.
      sections[0] = result.memoryBlock.replace(
        /Relevant verbatim turns recalled[\s\S]*$/,
        "Relevant verbatim turns recalled for the current question (fenced data):",
      );
      sections.push(fenced);
    } else if (result.recalledChunks.length > 0) {
      // No fence state: drop the raw recall list entirely.
      sections[0] = result.memoryBlock.replace(
        /Relevant verbatim turns recalled[\s\S]*$/,
        "",
      ).trimEnd();
    }
    return sections.join("\n\n").trim() || null;
  } catch {
    return null;
  }
}

/** Last user message text (the recall query — matches Python's
 *  last-user-text probe in SessionMemory.process). */
export function lastUserQuery(history: ModelMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") {
      const t = messageText(history[i]).trim();
      if (t) return t;
    }
  }
  return "";
}

/** Pre-run / mid-run fold entry point (agent.ts): decide what overflow to
 *  fold into the session capsule and fold it. Returns null when nothing
 *  overflowed (the common short-session case). Errors are swallowed into
 *  the returned null — a fold failure must NEVER abort the run; the hot
 *  window just stays full and the model trims on its own. */
export async function memoChainFoldPrefix(
  sessionId: string,
  messages: ModelMessage[],
): Promise<FoldPrefixResult | null> {
  try {
    const decision = decideFold(messages);
    if (!decision.overflow || decision.foldEnd === 0) return null;
    const stats = await foldMessages(sessionId, messages.slice(0, decision.foldEnd));
    return {
      foldedMessages: stats.foldedMessages,
      step: stats.step,
      stateDigest: stats.stateDigest,
    };
  } catch {
    // Fail-open: the run proceeds with the full (untrimmed) history.
    return null;
  }
}

/** Persist an LLM-updated rolling fact sheet (Settings flow or future
 *  auto-update path). */
export async function setRollingSummary(sessionId: string, summary: string): Promise<void> {
  await native.memochainSetSummary(sessionId, summary);
}

/** Render the recalled chunk list as fenced, sanitized text for prompt
 *  injection. Fence markers make the recalled content explicitly DATA to the
 *  model — the same trust boundary tool output uses. */
export function renderRecalledFence(
  chunks: MemoChainRecalledChunk[],
  fenceState: FenceState,
): string {
  if (chunks.length === 0) return "";
  const lines = chunks.map(
    (c) => `[${c.role}] (score ${c.score}) ${c.text}`,
  );
  const body = lines.join("\n");
  return fence("tool", fenceState.nonces.tool, body, {
    source: "memochain recall",
  });
}

/** Convert UIMessages to ModelMessages minimally (role + text parts only) —
 *  the fold path only needs text + roles; tool plumbing stays in the
 *  ModelMessage form the agent already produces. */
export function uiTextToModelMessages(messages: UIMessage[]): ModelMessage[] {
  return messages.map((m) => {
    const parts: string[] = [];
    for (const p of m.parts ?? []) {
      const t = (p as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
    return {
      role: m.role,
      content: parts.join("\n"),
    } as ModelMessage;
  });
}