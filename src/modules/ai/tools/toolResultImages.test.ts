import { describe, expect, it } from "vitest";
import { canDeliverToolResultImages } from "./context";
import { modelCanSee } from "../extraction";

/**
 * Tool-result images require BOTH provider serialization support and model
 * vision. A provider allowlist alone sent screenshots to text-only OpenAI
 * models while the prompt claimed they would be OCR text.
 */

describe("canDeliverToolResultImages", () => {
  it("requires a provider whose wire format preserves image parts", () => {
    expect(canDeliverToolResultImages("openai-compatible", true)).toBe(false);
    expect(canDeliverToolResultImages("lmstudio", true)).toBe(false);
    expect(canDeliverToolResultImages("openrouter", true)).toBe(false);
  });

  it("rejects text-only models even on image-capable providers", () => {
    expect(canDeliverToolResultImages("openai", false)).toBe(false);
    expect(canDeliverToolResultImages("anthropic", false)).toBe(false);
    expect(canDeliverToolResultImages("google", false)).toBe(false);
  });

  it("accepts only the provider+vision conjunction", () => {
    expect(canDeliverToolResultImages("openai", true)).toBe(true);
    expect(canDeliverToolResultImages("anthropic", true)).toBe(true);
    expect(canDeliverToolResultImages("google", true)).toBe(true);
  });

  it("the real registry distinguishes a text-only OpenAI model from a vision one", () => {
    expect(modelCanSee("gpt-5.4-nano")).toBe(false);
    expect(canDeliverToolResultImages("openai", modelCanSee("gpt-5.4-nano"))).toBe(false);
    expect(modelCanSee("gpt-5.4-mini")).toBe(true);
    expect(canDeliverToolResultImages("openai", modelCanSee("gpt-5.4-mini"))).toBe(true);
  });
});
