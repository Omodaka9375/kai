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

describe("compactModelMessagesDetailed — screenshot dataUrl strip", () => {
  const historyWithScreenshot = (output: unknown): ModelMessage[] =>
    [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-s",
            toolName: "look_at_screen",
            input: { display: "primary" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          // convertToModelMessages copies toolName onto tool-result parts
          // (UI ToolUIPart carries it) — this is the real wire shape.
          {
            type: "tool-result",
            toolCallId: "call-s",
            toolName: "look_at_screen",
            output,
          },
        ],
      },
    ] as unknown as ModelMessage[];

  // The shape convertToModelMessages produces (no tools map → toModelOutput
  // skipped → {type:"json", value:{...}} stringified by providers).
  const convertedOutput = {
    type: "json",
    value: {
      monitor: { id: 0, resolution: "1920x1080" },
      image: { dataUrl: `data:image/jpeg;base64,${b64(20_000)}` },
    },
  };
  // The raw execute() return shape (defensive).
  const rawOutput = {
    monitor: { id: 0, resolution: "1920x1080" },
    image: { dataUrl: `data:image/jpeg;base64,${b64(20_000)}` },
  };

  it("strips the dataUrl from the converted json shape — ALWAYS ON", () => {
    const r = compactModelMessagesDetailed(historyWithScreenshot(convertedOutput), 1_000_000);
    const result = (r.messages[1].content as { type: string; output: Record<string, unknown> }[])
      .find((p) => p.type === "tool-result")!;
    const value = result.output.value as {
      image?: { dataUrlRemoved?: boolean; dataUrl?: string };
      monitor?: { resolution?: string };
    };
    expect(value.image?.dataUrl).toBeUndefined();
    expect(value.image?.dataUrlRemoved).toBe(true);
    // metadata survives
    expect(value.monitor?.resolution).toBe("1920x1080");
    expect(r.compacted).toBe(true);
  });

  it("strips the dataUrl from the raw output shape", () => {
    const r = compactModelMessagesDetailed(historyWithScreenshot(rawOutput), 1_000_000);
    const result = (r.messages[1].content as { type: string; output: Record<string, unknown> }[])
      .find((p) => p.type === "tool-result")!;
    expect(result.output.image).toEqual({ dataUrlRemoved: true });
    expect(r.compacted).toBe(true);
  });

  it("strips patched generate_image base64 from the converted json shape", () => {
    const r = compactModelMessagesDetailed(
      historyWithScreenshot({
        type: "json",
        value: {
          type: "image",
          provider: "openai",
          mimeType: "image/png",
          base64: b64(80_000),
          prompt: "a cat",
        },
      })
        .map((m) => ({
          ...m,
          content: (m.content as { toolName: string }[]).map((p) =>
            p.toolName === "look_at_screen" ? { ...p, toolName: "generate_image" } : p,
          ),
        })) as unknown as ModelMessage[],
      1_000_000,
    );
    const result = (r.messages[1].content as { type: string; output: Record<string, unknown> }[])
      .find((p) => p.type === "tool-result")!;
    const value = result.output.value as {
      base64?: string;
      base64Removed?: boolean;
      base64Chars?: number;
      prompt?: string;
      provider?: string;
    };
    expect(value.base64).toBeUndefined();
    expect(value.base64Removed).toBe(true);
    expect(value.base64Chars).toBe(80_000);
    // metadata survives
    expect(value.prompt).toBe("a cat");
    expect(value.provider).toBe("openai");
    expect(r.compacted).toBe(true);
  });

  it("leaves short base64 fields alone (threshold)", () => {
    const r = compactModelMessagesDetailed(
      historyWithScreenshot({
        type: "json",
        value: { type: "image", base64: b64(500), prompt: "icon" },
      })
        .map((m) => ({
          ...m,
          content: (m.content as { toolName: string }[]).map((p) =>
            p.toolName === "look_at_screen" ? { ...p, toolName: "generate_image" } : p,
          ),
        })) as unknown as ModelMessage[],
      1_000_000,
    );
    const result = (
      r.messages[1].content as { type: string; output: { value?: { base64?: string } } }[]
    ).find((p) => p.type === "tool-result")!;
    expect(result.output.value?.base64).toBe(b64(500));
  });

  it("leaves other tools' image-bearing outputs alone", () => {
    const r = compactModelMessagesDetailed(
      historyWithScreenshot({ image: { dataUrl: "data:image/jpeg;base64,AAAA" } })
        .map((m) => ({
          ...m,
          content: (m.content as { toolName: string }[]).map((p) =>
            p.toolName === "look_at_screen" ? { ...p, toolName: "some_other_tool" } : p,
          ),
        })) as unknown as ModelMessage[],
      1_000_000,
    );
    const result = (r.messages[1].content as { type: string; output: { image?: { dataUrl?: string } } }[])
      .find((p) => p.type === "tool-result")!;
    expect(result.output.image?.dataUrl).toBe("data:image/jpeg;base64,AAAA");
  });
});
