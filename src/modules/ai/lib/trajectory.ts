/**
 * Trajectory model — provider-neutral canonical conversation representation.
 * Inspired by Turnstone's trajectory.py.
 *
 * ## Why
 * KAI's conversations currently use AI SDK UIMessage types directly for
 * persistence. When the SDK changes its internal format, or when a model
 * switch requires re-normalization, the persisted data becomes fragile.
 *
 * A canonical Turn type:
 * 1. Is the source of truth for persistence (not UIMessage)
 * 2. Survives provider/model changes
 * 3. Separates content from metadata (attachments as content-addressed refs)
 * 4. Carries typed EffectStatus on tool calls
 *
 * ## Design
 * The Turn type is a thin canonical layer. Conversion to/from UIMessage
 * happens at the transport boundary. Persistence stores Turns, not raw
 * SDK messages. The AI SDK format can change without invalidating the
 * conversation store.
 */

import type { UIMessage, UIMessagePart } from "ai";
import type { EffectStatus } from "./effectStatus";
import { getEffectStatus } from "./effectStatus";

// ── Canonical types ───────────────────────────────────────────────────────

/** A role in the conversation. */
export type TurnRole = "user" | "assistant" | "tool" | "system";

/** A block of text content. */
export interface TextBlock {
  kind: "text";
  text: string;
}

/** A tool call (from assistant to tool). */
export interface ToolCallBlock {
  kind: "tool_call";
  /** Tool name. */
  toolName: string;
  /** JSON-stringified arguments. */
  arguments: Record<string, unknown>;
  /** AI SDK tool call ID (for correlating with tool results). */
  toolCallId: string;
}

/** A tool result (from tool back to assistant). */
export interface ToolResultBlock {
  kind: "tool_result";
  /** Tool name. */
  toolName: string;
  /** AI SDK tool call ID. */
  toolCallId: string;
  /** The raw result (fenced + annotated). */
  output: unknown;
  /** Typed effect status. */
  effect: EffectStatus;
}

/** A reasoning/thinking block. */
export interface ReasoningBlock {
  kind: "reasoning";
  text: string;
}

/** A content-addressed attachment reference. */
export interface AttachmentRef {
  kind: "attachment";
  /** Content hash (SHA-256 hex). */
  hash: string;
  /** MIME type. */
  mimeType: string;
  /** Original filename (if known). */
  name?: string;
  /** Size in bytes. */
  size: number;
}

/** All block types in a Turn. */
export type TurnBlock =
  | TextBlock
  | ToolCallBlock
  | ToolResultBlock
  | ReasoningBlock
  | AttachmentRef;

/** A single turn in the conversation. */
export interface Turn {
  /** Unique turn ID (preserved across provider switches). */
  id: string;
  /** Role of the speaker. */
  role: TurnRole;
  /** Ordered content blocks. */
  blocks: TurnBlock[];
  /** When this turn was created (epoch ms). */
  createdAt: number;
  /** Optional metadata — model used, provider, tokens, etc. */
  meta?: TurnMeta;
}

/** Per-turn metadata. */
export interface TurnMeta {
  /** Model ID that generated this turn. */
  modelId?: string;
  /** Provider that generated this turn. */
  provider?: string;
  /** Token usage for this turn. */
  tokens?: {
    input: number;
    output: number;
    cached?: number;
  };
}

// ── Conversion: UIMessage → Turn ──────────────────────────────────────────

/**
 * Convert AI SDK UIMessage to canonical Turn.
 *
 * Tool result parts are inspected for `_effect` annotations (set by
 * the tool fencing wrapper in toolFencing.ts).
 */
export function fromUIMessage(msg: UIMessage): Turn {
  const blocks: TurnBlock[] = [];

  for (const part of msg.parts as UIMessagePart<Record<string, never>, Record<string, never>>[]) {
    const type = (part as { type?: string }).type ?? "";

    if (type === "text") {
      blocks.push({ kind: "text", text: (part as { text: string }).text });
    } else if (type === "reasoning") {
      blocks.push({ kind: "reasoning", text: (part as { text: string }).text });
    } else if (type === "tool-call" || type === "dynamic-tool") {
      const tc = part as {
        toolName?: string;
        toolCallId?: string;
        input?: unknown;
      };
      blocks.push({
        kind: "tool_call",
        toolName: tc.toolName ?? "unknown",
        arguments: (tc.input as Record<string, unknown>) ?? {},
        toolCallId: tc.toolCallId ?? "",
      });
    } else if (type === "tool-result" || type === "tool-output") {
      const tr = part as {
        toolName?: string;
        toolCallId?: string;
        output?: unknown;
      };
      const output = tr.output;
      const effect = getEffectStatus(output) ?? "COMMITTED";
      blocks.push({
        kind: "tool_result",
        toolName: tr.toolName ?? "unknown",
        toolCallId: tr.toolCallId ?? "",
        output: tr.output,
        effect,
      });
    } else if (type === "file") {
      const f = part as { url?: string; mediaType?: string; filename?: string; size?: number };
      blocks.push({
        kind: "attachment",
        hash: extractHashFromUrl(f.url ?? ""),
        mimeType: f.mediaType ?? "application/octet-stream",
        name: f.filename,
        size: f.size ?? 0,
      });
    }
  }

  return {
    id: msg.id,
    role: msg.role as TurnRole,
    blocks,
    createdAt: (msg as { createdAt?: Date }).createdAt?.getTime() ?? Date.now(),
  };
}

// ── Conversion: Turn → UIMessage (for feeding back to AI SDK) ─────────────

/**
 * Convert canonical Turn back to AI SDK UIMessage.
 * Used when restoring a persisted conversation.
 */
export function toUIMessage(turn: Turn): UIMessage {
  const parts: UIMessagePart<Record<string, never>, Record<string, never>>[] =
    turn.blocks.map((block): UIMessagePart<Record<string, never>, Record<string, never>> => {
      switch (block.kind) {
        case "text":
          return { type: "text", text: block.text } as unknown as UIMessagePart<
            Record<string, never>,
            Record<string, never>
          >;
        case "reasoning":
          return {
            type: "reasoning",
            text: block.text,
          } as unknown as UIMessagePart<Record<string, never>, Record<string, never>>;
        case "tool_call":
          return {
            type: "tool-call",
            toolName: block.toolName,
            toolCallId: block.toolCallId,
            input: block.arguments,
          } as unknown as UIMessagePart<
            Record<string, never>,
            Record<string, never>
          >;
        case "tool_result":
          return {
            type: "tool-result",
            toolName: block.toolName,
            toolCallId: block.toolCallId,
            output: block.output,
          } as unknown as UIMessagePart<
            Record<string, never>,
            Record<string, never>
          >;
        case "attachment":
          return {
            type: "file",
            url: `attachment://${block.hash}`,
            mediaType: block.mimeType,
            filename: block.name,
            size: block.size,
          } as unknown as UIMessagePart<
            Record<string, never>,
            Record<string, never>
          >;
      }
    });

  return {
    id: turn.id,
    role: turn.role,
    parts,
    createdAt: new Date(turn.createdAt),
  } as UIMessage;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractHashFromUrl(url: string): string {
  // Data URLs: hash the content. Attachment URLs: extract from path.
  if (url.startsWith("attachment://")) {
    return url.slice("attachment://".length);
  }
  // Fallback: simple hash of the URL string.
  return hashString(url);
}

/**
 * Simple non-cryptographic hash for content addressing.
 * For production use, replace with SHA-256 via native bridge.
 */
function hashString(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const chr = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

// ── Trajectory-level transforms ───────────────────────────────────────────

/**
 * Convert an array of Turns to a compact summary string for the
 * model's context (used during compaction/summarization).
 */
export function turnsToSummary(turns: Turn[], maxChars: number = 4000): string {
  const lines: string[] = [];
  let chars = 0;

  for (const turn of turns) {
    const roleLabel = turn.role === "user" ? "User" : turn.role === "assistant" ? "Assistant" : turn.role;
    lines.push(`[${roleLabel}]`);
    for (const block of turn.blocks) {
      if (block.kind === "text") {
        const snippet = block.text.slice(0, 200);
        lines.push(snippet);
        chars += snippet.length;
      } else if (block.kind === "tool_call") {
        lines.push(`  → called ${block.toolName}(${JSON.stringify(block.arguments).slice(0, 100)})`);
        chars += 50;
      }
    }
    lines.push("");
    if (chars > maxChars) break;
  }

  return lines.join("\n");
}