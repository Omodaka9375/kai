import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateGoogleImage } from "./google-image";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const { invoke } = await import("@tauri-apps/api/core");
const mockedInvoke = vi.mocked(invoke);

function response(body: unknown, status = 200) {
  return { status, headers: {}, body: Array.from(new TextEncoder().encode(JSON.stringify(body))) };
}

function sentBody(): Record<string, unknown> {
  const args = mockedInvoke.mock.calls[0]![1] as { body: number[] };
  return JSON.parse(new TextDecoder().decode(new Uint8Array(args.body))) as Record<string, unknown>;
}

describe("generateGoogleImage current Interactions contract", () => {
  beforeEach(() => mockedInvoke.mockReset());

  it("uses Nano Banana 2.1 and forwards editing, ratio, and resolution", async () => {
    mockedInvoke.mockResolvedValue(response({
      steps: [{ type: "model_output", content: [{ type: "image", data: "aW1hZ2U=", mime_type: "image/png" }] }],
    }));
    const result = await generateGoogleImage("test-key", {
      prompt: "restyle this",
      referenceImage: "aW1hZ2U=",
      size: "1792x1024",
      quality: "high",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("ai_http_request", expect.objectContaining({
      url: "https://generativelanguage.googleapis.com/v1beta/interactions",
      headers: expect.objectContaining({
        "x-goog-api-key": "test-key",
        "Api-Revision": "2026-05-20",
      }),
    }));
    const body = sentBody();
    expect(body.model).toBe("gemini-nano-banana-2.1");
    expect(body.input).toMatchObject([
      { type: "image", data: "aW1hZ2U=", mime_type: "image/png" },
      { type: "text", text: "restyle this" },
    ]);
    expect(body.response_format).toEqual({
      type: "image",
      mime_type: "image/png",
      image_size: "2K",
      aspect_ratio: "16:9",
    });
    expect(body.store).toBe(false);
    expect(result.base64).toBe("aW1hZ2U=");
    expect(result.provider).toBe("google");
  });

  it("parses both image field spellings and preserves real JPEG dimensions", async () => {
    const sof = Uint8Array.from(atob("/8AAEQgAFAGQAwERAAIRAAMRAAAAAA=="), (char) => char.charCodeAt(0));
    const jpeg = btoa(String.fromCharCode(0xff, 0xd8, ...sof, 0xff, 0xd9));
    mockedInvoke.mockResolvedValue(response({
      candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/jpeg", data: jpeg } }] } }],
    }));
    const result = await generateGoogleImage("test-key", { prompt: "an icon" });
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.width).toBe(400);
    expect(result.height).toBe(20);
  });

  it("surfaces the provider's reason when no image arrives", async () => {
    mockedInvoke.mockResolvedValue(response({
      promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "The prompt was blocked." },
    }));
    await expect(generateGoogleImage("test-key", { prompt: "blocked" })).rejects.toThrow("The prompt was blocked.");
  });

  it("surfaces a text-only finish reason instead of a generic failure", async () => {
    mockedInvoke.mockResolvedValue(response({
      candidates: [{ finishReason: "PROHIBITED_CONTENT", content: { parts: [{ text: "I cannot create that image." }] } }],
    }));
    await expect(generateGoogleImage("test-key", { prompt: "blocked" })).rejects.toThrow("PROHIBITED_CONTENT");
  });
});
