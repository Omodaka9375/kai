import { describe, expect, it } from "vitest";
import { isMediaOutput } from "./MediaMessage";

describe("isMediaOutput", () => {
  it("detects image output", () => {
    expect(
      isMediaOutput({
        type: "image",
        base64: "abc",
        mimeType: "image/png",
        width: 1024,
        height: 1024,
        provider: "openai",
        prompt: "a cat",
      }),
    ).toBe(true);
  });

  it("detects video output", () => {
    expect(
      isMediaOutput({
        type: "video",
        url: "https://example.com/video.mp4",
        mimeType: "video/mp4",
        durationSeconds: 5,
        provider: "kling",
        prompt: "a sunset",
      }),
    ).toBe(true);
  });

  it("rejects null", () => {
    expect(isMediaOutput(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isMediaOutput(undefined)).toBe(false);
  });

  it("rejects non-object", () => {
    expect(isMediaOutput("image")).toBe(false);
    expect(isMediaOutput(42)).toBe(false);
  });

  it("rejects object without type", () => {
    expect(isMediaOutput({ base64: "abc" })).toBe(false);
  });

  it("rejects object with wrong type", () => {
    expect(isMediaOutput({ type: "text", content: "hello" })).toBe(false);
  });

  it("rejects error output from tool", () => {
    expect(isMediaOutput({ error: "No API key configured" })).toBe(false);
  });
});
