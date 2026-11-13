import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { estimateContextTokens } from "./contextTokens";

function mediaMessage(base64: string): UIMessage {
  return {
    id: "m1",
    role: "assistant",
    parts: [
      {
        type: "tool-generate_video",
        toolCallId: "call-1",
        state: "output-available",
        input: { prompt: "a field" },
        output: {
          type: "video",
          provider: "google",
          base64,
          durationSeconds: 8,
          savedPath: "C:/media/field.mp4",
        },
      } as unknown as UIMessage["parts"][number],
    ],
  };
}

describe("media-aware context estimate", () => {
  it("counts a generated-media summary, not raw preview bytes", () => {
    const base64 = "A".repeat(5_000_000);
    const messages = [mediaMessage(base64)];
    expect(estimateContextTokens(messages)).toBeLessThan(1_000);
    expect(JSON.stringify(messages)).toContain(base64);
  });

  it("leaves ordinary tool output accounting unchanged", () => {
    const messages = [{
      id: "m1",
      role: "assistant",
      parts: [{ type: "tool-grep", input: { pattern: "abc" }, output: { result: "1234" } }],
    } as unknown as UIMessage];
    const part = messages[0]!.parts[0] as { input: unknown; output: unknown };
    const chars = JSON.stringify(part.input).length + JSON.stringify(part.output).length;
    expect(estimateContextTokens(messages)).toBe(Math.ceil(chars / 4));
  });
});
