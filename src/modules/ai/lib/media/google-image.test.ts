import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateGoogleImage } from "./google-image";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const { invoke } = await import("@tauri-apps/api/core");
const mockedInvoke = vi.mocked(invoke);

function response(body: unknown, status = 200) {
  return { status, headers: {}, body: Array.from(new TextEncoder().encode(JSON.stringify(body))) };
}

describe("generateGoogleImage response handling", () => {
  beforeEach(() => mockedInvoke.mockReset());

  it("accepts inline_data from a proxy using protobuf field names", async () => {
    mockedInvoke.mockResolvedValue(response({
      candidates: [{ content: { parts: [{ inline_data: { mimeType: "image/png", data: "real-image-bytes" } }] } }],
    }));
    const result = await generateGoogleImage("test-key", { prompt: "an icon" });
    expect(result.base64).toBe("real-image-bytes");
    expect(result.provider).toBe("google");
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
