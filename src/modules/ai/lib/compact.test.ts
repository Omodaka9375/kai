import { describe, expect, it } from "vitest";
import { compactModelMessagesDetailed } from "./compact";
import type { ModelMessage } from "ai";

const b64 = (n: number) => "A".repeat(n);

function historyWithDisplayImage(payloadLen: number): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "display_image",
          input: { base64_data: b64(payloadLen), name: "footer.png" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call-1", output: { ok: true } },
      ],
    },
  ] as unknown as ModelMessage[];
}

describe("compactModelMessagesDetailed — bulky tool inputs", () => {
  it("elides display_image base64 payloads (always on)", () => {
    const r = compactModelMessagesDetailed(historyWithDisplayImage(50_000), 1_000_000);
    const call = (r.messages[0].content as { type: string; input: Record<string, unknown> }[])
      .find((p) => p.type === "tool-call");
    expect(call).toBeDefined();
    const data = String(call!.input.base64_data);
    expect(data.length).toBeLessThan(500);
    expect(data).toContain("elided");
    // name untouched
    expect(call!.input.name).toBe("footer.png");
    // marked compacted
    expect(r.compacted).toBe(true);
  });

  it("leaves short payloads and other tools untouched", () => {
    const r = compactModelMessagesDetailed(
      [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-2",
              toolName: "write_file",
              input: { path: "x.txt", content: "a".repeat(600) },
            },
          ],
        },
      ] as unknown as ModelMessage[],
      1_000_000,
    );
    const call = (r.messages[0].content as { type: string; input: Record<string, unknown> }[])
      .find((p) => p.type === "tool-call");
    expect(String(call!.input.content).length).toBe(600);
    expect(r.compacted).toBe(false);
  });
});
