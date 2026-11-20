import type { ModelMessage } from "ai";
import type { ProviderId } from "../config";

/**
 * Normalize model messages when switching providers mid-session.
 * Handles thinking/reasoning trace conversion and provider-specific cleanup.
 */
export function normalizeForProvider(
  messages: ModelMessage[],
  toProvider: ProviderId,
): ModelMessage[] {
  // OPENAI (2026-11-20 GPT-5.6 Luna fix): the Responses API REQUIRES every
  // replayed function_call to be accompanied by its paired reasoning item
  // (rs_ -> fc_). The generic path below drops all-but-last-assistant
  // reasoning and converts the survivor to a <thinking> text part - that
  // strips providerOptions.openai.itemId, leaves the fc unpaired, and the
  // API rejects the whole request ("function_call was provided without its
  // required 'reasoning' item"). Keep reasoning parts verbatim for openai:
  // the provider emits item_references for parts carrying openai itemIds
  // and silently skips foreign/legacy ones (no itemId, no encrypted
  // content), so stale traces from other providers are harmless.
  if (toProvider === "openai") {
    return messages.map((m) => stripProviderMeta(m, toProvider) as ModelMessage);
  }

  // For non-Anthropic targets we convert `reasoning` parts to text tags so
  // the target can still see the chain of thought. But re-injecting the
  // ENTIRE reasoning history on every step bloats the context and degrades
  // long conversations (models read stale chain-of-thought as fact). Only
  // the most recent assistant's reasoning is carried forward; older traces
  // are dropped.
  const lastAssistantIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return i;
    }
    return -1;
  })();

  return messages.map((m, idx) => {
    if (!Array.isArray(m.content)) return m;

    if (toProvider !== "anthropic") {
      let touched = false;
      const content = (
        m.content as { type: string; text?: string; [k: string]: unknown }[]
      ).map((part) => {
        if (part.type !== "reasoning" || typeof part.text !== "string") {
          return part;
        }
        touched = true;
        // Only carry the newest reasoning forward; drop stale traces so they
        // don't swamp the context window on later steps.
        return idx === lastAssistantIdx
          ? { type: "text", text: `<thinking>${part.text}</thinking>` }
          : null;
      }).filter((p): p is { type: string; text?: string; [k: string]: unknown } =>
        p != null,
      );
      if (!touched) {
        return stripProviderMeta(m, toProvider) as ModelMessage;
      }
      const cleaned = stripProviderMeta(m, toProvider);
      return { ...cleaned, content } as ModelMessage;
    }

    // For Anthropic: strip non-anthropic providerOptions.
    return stripProviderMeta(m, toProvider) as ModelMessage;
  });
}

function stripProviderMeta(
  m: ModelMessage,
  keep: ProviderId,
): ModelMessage {
  if (!m.providerOptions) return m;
  const opts = m.providerOptions as Record<string, unknown>;
  if (keep in opts) {
    return { ...m, providerOptions: { [keep]: opts[keep] } as typeof m.providerOptions };
  }
  // No matching provider options — remove entirely.
  const { providerOptions: _, ...rest } = m;
  return rest as ModelMessage;
}
