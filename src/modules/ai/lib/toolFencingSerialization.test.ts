import { describe, expect, it, vi } from "vitest";

/**
 * Regression tests for provider-facing tool-output serialization.
 *
 * withToolGuard persists internal outcome metadata on the transcript, but it
 * must strip that metadata WITHOUT replacing a tool's own serializer. The
 * latter is how screenshots stay vision content (or OCR), rather than a JSON
 * object carrying megabytes of base64.
 */

vi.mock("./audit", () => ({
  auditAppend: vi.fn(),
  AUDIT_KINDS: { securityDeny: "security.deny" },
}));

const { createFenceState } = await import("./fence");
const { withToolGuard } = await import("./toolFencing");

type SerializationOptions = { toolCallId: string; input: unknown; output: unknown };
type SerializableTool = {
  execute: (_input: unknown) => Promise<unknown>;
  toModelOutput: (options: SerializationOptions) => unknown;
};

describe("withToolGuard provider serialization", () => {
  it("preserves a tool-owned content serializer and strips internal metadata from its input", async () => {
    const originalToModelOutput = vi.fn((_options: SerializationOptions) => ({
      type: "content",
      value: [
        { type: "text", text: "Screenshot captured." },
        { type: "image-data", data: "JPEG_BASE64", mediaType: "image/jpeg" },
      ],
    }));
    const tools = {
      look_at_screen: {
        execute: async () => ({
          image: { dataUrl: "data:image/jpeg;base64,JPEG_BASE64" },
        }),
        toModelOutput: originalToModelOutput,
      },
    };
    const guarded = withToolGuard(tools, createFenceState("s-screen"));
    const tool = guarded["look_at_screen"] as SerializableTool;
    const output = await tool.execute({});
    const serialized = tool.toModelOutput({
      toolCallId: "call-1",
      input: {},
      output,
    }) as { type: string; value: unknown };

    expect(originalToModelOutput).toHaveBeenCalledOnce();
    const delegated = originalToModelOutput.mock.calls[0]![0];
    expect(delegated.output).toMatchObject({
      image: { dataUrl: "data:image/jpeg;base64,JPEG_BASE64" },
    });
    expect(delegated.output).not.toHaveProperty("_effect");
    expect(serialized.type).toBe("content");
    expect(serialized.value).toContainEqual({
      type: "image-data",
      data: "JPEG_BASE64",
      mediaType: "image/jpeg",
    });
    // The whole point of the regression: this must NOT be JSON output.
    expect(serialized.type).not.toBe("json");
  });

  it("uses the SDK-default text/json shape when no tool serializer exists", async () => {
    const tools = {
      sample: { execute: async () => ({ ok: true }) },
    };
    const guarded = withToolGuard(tools, createFenceState("s-json"));
    const tool = guarded["sample"] as SerializableTool;
    const output = await tool.execute({});
    expect(output).toHaveProperty("_effect");
    expect(tool.toModelOutput({ toolCallId: "c", input: {}, output })).toEqual({
      type: "json",
      value: { ok: true },
    });
  });

  it("preserves MCP's structured content conversion", async () => {
    const tools = {
      netexpert__net_ping: {
        execute: async () => ({ host: "example.com", status: "ok" }),
        toModelOutput: ({ output }: SerializationOptions) => ({
          type: "content",
          value: [{ type: "text", text: JSON.stringify(output) }],
        }),
      },
    };
    const guarded = withToolGuard(tools, createFenceState("s-mcp"));
    const tool = guarded["netexpert__net_ping"] as SerializableTool;
    const output = await tool.execute({});
    const serialized = tool.toModelOutput({
      toolCallId: "c",
      input: {},
      output,
    }) as { type: string; value: Array<{ type: string; text: string }> };

    expect(serialized.type).toBe("content");
    expect(serialized.value[0]!.text).not.toContain("_effect");
  });
});
