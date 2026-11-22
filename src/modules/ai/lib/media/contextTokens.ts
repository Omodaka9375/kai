import type { UIMessage } from "ai";
import { summarizeMediaToolResult } from "./modelSummary";

/**
 * Per-message char-count memo (freeze fix, 2026-11-22): ContextIndicator
 * calls estimateContextTokens on a 1s tick AND whenever messages changes
 * (every 50ms token flush during streaming). Without a memo, every call
 * walked the entire transcript and JSON.stringified every tool input and
 * output from scratch — tens of MB/sec on long chats. Historical UIMessage
 * objects are immutable (only the streaming tail message is replaced per
 * flush), so caching settled messages in a WeakMap makes each call O(1).
 */
const messageCharsCache = new WeakMap<object, number>();

function singleMessageChars(message: UIMessage, cacheable: boolean): number {
  if (cacheable) {
    const hit = messageCharsCache.get(message);
    if (hit !== undefined) return hit;
  }
  let chars = 0;
  for (const part of message.parts) {
    if (part.type === "text" || part.type === "reasoning") {
      chars += (part as { text?: string }).text?.length ?? 0;
    } else if (part.type.startsWith("tool-")) {
      const toolPart = part as { input?: unknown; output?: unknown };
      if (toolPart.input) chars += JSON.stringify(toolPart.input).length;
      if (toolPart.output) {
        chars += JSON.stringify(summarizeMediaToolResult(toolPart.output)).length;
      }
    } else if (part.type === "file") {
      const file = part as { url?: string; data?: string };
      chars += (file.url ?? file.data ?? "").length;
    }
  }
  if (cacheable) {
    messageCharsCache.set(message, chars);
  }
  return chars;
}

/** Rough model-input estimate. Preview bytes are not sent as tool-result text:
 *  count their model summary instead of letting media fill the indicator. */
export function estimateContextTokens(messages: UIMessage[]): number {
  let chars = 0;
  const lastIdx = messages.length - 1;
  for (let i = 0; i <= lastIdx; i++) {
    chars += singleMessageChars(messages[i]!, i < lastIdx);
  }
  return Math.ceil(chars / 4);
}
