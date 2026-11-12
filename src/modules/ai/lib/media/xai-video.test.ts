import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateXAIVideo } from "./xai-video";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function response(status: number, body: unknown) {
  const bytes = typeof body === "string" ? body : JSON.stringify(body);
  return { status, body: Array.from(new TextEncoder().encode(bytes)) };
}

function sentBody(index = 0): Record<string, unknown> {
  const args = invokeMock.mock.calls[index]![1] as { body: number[] };
  return JSON.parse(new TextDecoder().decode(new Uint8Array(args.body))) as Record<string, unknown>;
}

describe("xAI Imagine Video 1.5 Lite", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it("submits, polls, and downloads the temporary video URL", async () => {
    invokeMock
      .mockResolvedValueOnce(response(200, { request_id: "req-1" }))
      .mockResolvedValueOnce(response(200, { status: "pending" }))
      .mockResolvedValueOnce(response(200, {
        status: "done",
        video: { url: "https://vidgen.x.ai/video.mp4", duration: 5 },
      }))
      .mockResolvedValueOnce(response(200, "video"));

    const resultPromise = generateXAIVideo("test-key", { prompt: "A creek", duration: 5 });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(sentBody()).toMatchObject({
      model: "grok-imagine-video-1.5-lite",
      prompt: "A creek",
      duration: 5,
      aspect_ratio: "16:9",
      resolution: "720p",
    });
    expect(invokeMock.mock.calls[1]![1]).toMatchObject({
      url: "https://api.x.ai/v1/videos/req-1",
      method: "GET",
      headers: { Authorization: "Bearer test-key" },
    });
    expect(invokeMock.mock.calls[3]![1]).toMatchObject({
      url: "https://vidgen.x.ai/video.mp4",
      method: "GET",
    });
    expect(result.provider).toBe("xai");
    expect(result.durationSeconds).toBe(5);
    expect(result.base64).toBe(btoa("video"));
  });

  it("sends a reference image as a data URI and does not override its ratio", async () => {
    invokeMock
      .mockResolvedValueOnce(response(200, { request_id: "req-2" }))
      .mockResolvedValueOnce(response(200, {
        status: "done",
        video: { url: "https://vidgen.x.ai/video.mp4", duration: 8 },
      }))
      .mockResolvedValueOnce(response(200, "video"));

    await generateXAIVideo("test-key", {
      prompt: "Animate",
      referenceImage: "aW1hZ2U=",
      aspectRatio: "1:1",
    });
    const body = sentBody();
    expect(body.image).toEqual({ url: "data:image/png;base64,aW1hZ2U=" });
    expect(body).not.toHaveProperty("aspect_ratio");
  });

  it("surfaces a failed poll with the provider reason", async () => {
    invokeMock
      .mockResolvedValueOnce(response(200, { request_id: "req-3" }))
      .mockResolvedValueOnce(response(200, {
        status: "failed",
        error: { message: "prompt rejected" },
      }));
    await expect(generateXAIVideo("test-key", { prompt: "blocked" })).rejects.toThrow("prompt rejected");
  });
});
