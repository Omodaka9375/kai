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
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;

    if (toProvider !== "anthropic") {
      // Convert reasoning parts to text tags for non-Anthropic targets.
      let touched = false;
      const content = (
        m.content as { type: string; text?: string; [k: string]: unknown }[]
      ).map((part) => {
        if (
          part.type === "reasoning" &&
          typeof part.text === "string"
        ) {
          touched = true;
          return { type: "text", text: `<thinking>${part.text}</thinking>` };
        }
        return part;
      });
      if (touched) {
        const cleaned = stripProviderMeta(m, toProvider);
        return { ...cleaned, content } as ModelMessage;
      }
      return stripProviderMeta(m, toProvider) as ModelMessage;
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
