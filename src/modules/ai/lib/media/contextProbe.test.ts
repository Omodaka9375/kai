import { describe, expect, it } from "vitest";
import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import { summarizeMediaOutputs } from "../../extraction";
import { summarizeMediaToolResult } from "./modelSummary";

const uiMediaMessage = (type: "image" | "video", base64: string): UIMessage => ({
  id: "media",
  role: "assistant",
  parts: [
    {
      type: `tool-generate_${type}`,
      toolCallId: "media-call",
      state: "output-available",
      input: { prompt: "test" },
      output: {
        type,
        provider: "google",
        base64,
        url: "https://example.test/result",
        savedPath: `C:/media/result.${type === "image" ? "png" : "mp4"}`,
        width: type === "image" ? 1024 : undefined,
        height: type === "image" ? 1024 : undefined,
        durationSeconds: type === "video" ? 8 : undefined,
        [`${type}s`]: [{ type, base64, savedPath: `C:/media/result.${type === "image" ? "png" : "mp4"}` }],
      },
    } as unknown as UIMessage["parts"][number],
  ],
});

describe("real AI SDK media conversion", () => {
  for (const [type, chars] of [["image", 2_000_000], ["video", 5_000_000]] as const) {
    it(`removes the ${type} payload from converted model history`, async () => {
      const base64 = "A".repeat(chars);
      const converted = await convertToModelMessages([uiMediaMessage(type, base64)]);
      const resultPart = (converted[1] as { content: Array<{ type: string; output: unknown }> }).content
        .find((part) => part.type === "tool-result");
      expect(resultPart?.output).toMatchObject({ type: "json" });
      const summarized = summarizeMediaOutputs(converted as ModelMessage[]);
      expect(JSON.stringify(summarized).length).toBeLessThan(1_000);
      expect(JSON.stringify(summarized)).not.toContain(base64);
    });
  }

  it("summarizes a persisted text-envelope result", () => {
    const big = "A".repeat(5_000_000);
    const result = summarizeMediaToolResult({
      type: "text",
      value: JSON.stringify({ type: "video", provider: "google", base64: big }),
    });
    expect(JSON.stringify(result).length).toBeLessThan(1_000);
    expect(JSON.stringify(result)).not.toContain(big);
  });
});
