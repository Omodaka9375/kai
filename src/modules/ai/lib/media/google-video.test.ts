import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateGoogleVideo } from "./google-video";

/**
 * Gemini Omni Flash's Interactions API wire contract (2026-11-12 live failure).
 *
 * A source-text pin would not have caught the shipped `store: false` request:
 * both text-to-video and image-to-video were rejected before rendering with
 *   400 "store=true is required when response format has video delivery set to URI."
 * Decode the actual body passed to the native HTTP bridge instead.
 */

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function response(status: number, body: unknown) {
  const bytes = typeof body === "string" ? body : JSON.stringify(body);
  return { status, body: Array.from(encoder.encode(bytes)) };
}

function requestBody(callIndex = 0): Record<string, unknown> {
  const args = invokeMock.mock.calls[callIndex]?.[1] as { body: number[] };
  return JSON.parse(decoder.decode(new Uint8Array(args.body))) as Record<string, unknown>;
}

beforeEach(() => {
  invokeMock.mockReset();
  vi.useFakeTimers();
});

afterEach(() => vi.useRealTimers());

describe("Gemini Omni video requests", () => {
  it("stores URI-delivered interactions instead of sending store:false", async () => {
    invokeMock
      .mockResolvedValueOnce(response(200, {
        id: "v1_test",
        status: "completed",
        steps: [{
          type: "model_output",
          content: [{ type: "video", data: "dmlkZW8=", mime_type: "video/mp4" }],
        }],
      }));

    const result = await generateGoogleVideo("test-key", {
      prompt: "A cow moving beside a creek",
      duration: 5,
    });

    const body = requestBody();
    expect(body.model).toBe("gemini-omni-1.2-flash");
    expect(body.background).toBe(false);
    expect(body.stream).toBe(false);
    expect(body.store).toBe(true);
    expect(body.response_format).toMatchObject({
      type: "video",
      delivery: "uri",
      duration: "5s",
      aspect_ratio: "16:9",
      resolution: "720p",
    });
    expect(result.base64).toBe("dmlkZW8=");
    expect(result.durationSeconds).toBe(5);
  });

  it("uses the same stored URI-delivery contract for image-to-video", async () => {
    invokeMock.mockResolvedValueOnce(response(200, {
      id: "v1_image",
      status: "completed",
      steps: [{
        type: "model_output",
        content: [{ type: "video", data: "dmlkZW8=", mime_type: "video/mp4" }],
      }],
    }));

    await generateGoogleVideo("test-key", {
      prompt: "Animate the opening frame",
      referenceImage: "aW1hZ2U=",
      duration: 8,
      aspectRatio: "9:16",
    });

    const body = requestBody();
    expect(body.store).toBe(true);
    expect(body.input).toMatchObject([
      { type: "image", data: "aW1hZ2U=", mime_type: "image/png" },
      { type: "text", text: "Animate the opening frame" },
    ]);
    expect(body.generation_config).toEqual({
      video_config: { task: "image_to_video" },
    });
    expect(body.response_format).toMatchObject({ delivery: "uri", aspect_ratio: "9:16" });
  });

  it("polls a URI-delivered file to ACTIVE and downloads it with the API key", async () => {
    invokeMock
      .mockResolvedValueOnce(response(200, {
        id: "v1_uri",
        status: "completed",
        steps: [{
          type: "model_output",
          content: [{
            type: "video",
            uri: "https://generativelanguage.googleapis.com/v1beta/files/file-1:download?alt=media",
            mime_type: "video/mp4",
          }],
        }],
      }))
      .mockResolvedValueOnce(response(200, { state: "PROCESSING" }))
      .mockResolvedValueOnce(response(200, { state: "ACTIVE" }))
      .mockResolvedValueOnce(response(200, "video"));

    const resultPromise = generateGoogleVideo("test-key", { prompt: "URI delivery" });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.base64).toBe(btoa("video"));
    expect(invokeMock.mock.calls[1]![1]).toMatchObject({
      url: "https://generativelanguage.googleapis.com/v1beta/files/file-1",
      headers: { "x-goog-api-key": "test-key" },
    });
    expect(invokeMock.mock.calls[3]![1]).toMatchObject({
      url: "https://generativelanguage.googleapis.com/v1beta/files/file-1:download?alt=media",
      headers: { "x-goog-api-key": "test-key" },
    });
  });

  it("accepts inline data from an early-submit interaction poll", async () => {
    // A GET of an interaction created with URI delivery returns INLINE bytes,
    // not the uri. The old `data || uri` wait therefore ignored a completed
    // clip and eventually timed out.
    invokeMock
      .mockResolvedValueOnce(response(200, {
        id: "v1_early",
        status: "in_progress",
        steps: [],
      }))
      .mockResolvedValueOnce(response(200, {
        id: "v1_early",
        status: "completed",
        steps: [{
          type: "model_output",
          content: [{ type: "video", data: "cG9sbGVk", mime_type: "video/mp4" }],
        }],
      }));

    const resultPromise = generateGoogleVideo("test-key", { prompt: "Poll once" });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.base64).toBe("cG9sbGVk");
    expect(invokeMock).toHaveBeenCalledTimes(2);
  }, 10_000);
});
