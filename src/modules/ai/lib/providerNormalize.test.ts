import { describe, expect, it } from "vitest";
import { normalizeForProvider } from "./providerNormalize";
import type { ModelMessage } from "ai";

/**
 * Reasoning-pair contract (2026-11-20 GPT-5.6 Luna fix): the OpenAI
 * Responses API rejects a replayed function_call whose paired reasoning
 * item is missing ("Item 'fc_...' of type 'function_call' was provided
 * without its required 'reasoning' item: 'rs_...'"). The old normalizer
 * dropped all-but-last-assistant reasoning parts and converted the
 * survivor to a <thinking> text part, stripping the openai itemId that
 * makes the provider emit the item_reference. normalizeForProvider must
 * now keep reasoning parts verbatim for the openai wire.
 */

const openaiReasoning = {
  type: "reasoning" as const,
  text: "",
  providerOptions: {
    openai: { itemId: "rs_0026bd1d485326ac006affd171899887d2" },
  },
};

function openaiTurn(): ModelMessage[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "inspect the repo" }],
    },
    {
      role: "assistant",
      content: [
        { ...openaiReasoning },
        { type: "tool-call", toolCallId: "call_a", toolName: "todo_write", input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_a", toolName: "todo_write", output: { type: "json", value: {} } },
      ],
    },
    {
      // A second assistant message: the generic path drops reasoning here
      // ("not the last assistant"), the openai path must keep every part.
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "call_b", toolName: "glob", input: {} },
      ],
    },
  ];
}

describe("normalizeForProvider", () => {
  it("keeps reasoning parts verbatim for openai (fc/rs pairing contract)", () => {
    const out = normalizeForProvider(openaiTurn(), "openai");
    const reasoningParts = out.flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((p) => (p as { type: string }).type === "reasoning")
        : [],
    );
    expect(reasoningParts).toHaveLength(1);
    const part = reasoningParts[0] as { providerOptions?: Record<string, unknown> };
    // The itemId must survive untouched - it is what makes the provider
    // emit the item_reference the API pairs with the replayed fc_.
    expect(
      (part.providerOptions?.openai as { itemId?: string }).itemId,
    ).toBe("rs_0026bd1d485326ac006affd171899887d2");
  });

  it("does not convert reasoning to <thinking> text for openai", () => {
    const out = normalizeForProvider(openaiTurn(), "openai");
    const textParts = out.flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<{ type: string; text?: string }>).filter(
            (p) => p.type === "text" && p.text?.includes("<thinking>"),
          )
        : [],
    );
    expect(textParts).toHaveLength(0);
  });

  it("still drops stale reasoning for non-openai, non-anthropic targets", () => {
    const out = normalizeForProvider(openaiTurn(), "google");
    const reasoningParts = out.flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((p) => (p as { type: string }).type === "reasoning")
        : [],
    );
    // Generic behavior: only the LAST assistant's reasoning survives, and
    // as <thinking> text (not a reasoning part).
    expect(reasoningParts).toHaveLength(0);
    const lastAssistant = out[out.length - 1];
    const texts = (lastAssistant.content as Array<{ type: string; text?: string }>).filter(
      (p) => p.type === "text",
    );
    expect(texts).toHaveLength(0); // no reasoning existed on the last assistant
  });

  it("keeps non-reasoning parts untouched for openai", () => {
    const out = normalizeForProvider(openaiTurn(), "openai");
    const toolCalls = out.flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((p) => (p as { type: string }).type === "tool-call")
        : [],
    );
    expect(toolCalls).toHaveLength(2);
  });
});
