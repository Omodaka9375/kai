import { describe, expect, it } from "vitest";
import { looksLikeVisionModel, modelTextOnly } from "./extraction";

describe("looksLikeVisionModel", () => {
  it.each([
    ["qwen2-vl-7b-instruct", true],
    ["Qwen2.5-VL-32B-Instruct", true],
    ["internvl2-8b", true],
    ["llava-v1.6-mistral-7b", true],
    ["minicpm-v-2.6-gguf", true],
    ["moondream2", true],
    ["Florence-2-base", true],
    ["pixtral-12b", true],
    ["gpt-4-vision-preview", true],
  ])("%s → %s", (name, expected) => {
    expect(looksLikeVisionModel(name)).toBe(expected);
  });

  it.each([
    ["qwen2.5-coder-7b-instruct", false],
    ["llama-3.1-8b-instruct", false],
    ["mistral-7b-instruct-v0.3", false], // "v0.3" is a version, not vision
    ["evolved-model", false], // no vl token boundary
    ["deepseek-r1-distill-qwen-7b", false],
    [null, false],
    ["", false],
  ])("%s → %s", (name, expected) => {
    expect(looksLikeVisionModel(name)).toBe(expected);
  });
});

describe("modelTextOnly (custom endpoints resolve the runtime name)", () => {
  it("registry vision models are never text-only", () => {
    expect(modelTextOnly("gpt-5.4-mini")).toBe(false);
  });

  it("registry text-only models stay text-only", () => {
    expect(modelTextOnly("deepseek-chat")).toBe(true);
  });

  it("lmstudio-local with a vision-family runtime name sees images", () => {
    expect(modelTextOnly("lmstudio-local", "qwen2-vl-7b-instruct")).toBe(false);
  });

  it("lmstudio-local with a text runtime name is text-only", () => {
    expect(modelTextOnly("lmstudio-local", "qwen2.5-coder-7b")).toBe(true);
  });

  it("openai-compatible-custom with a vision runtime name sees images", () => {
    expect(modelTextOnly("openai-compatible-custom", "llava-1.6")).toBe(false);
  });

  it("custom endpoint with no runtime name set stays text-only (safe default)", () => {
    expect(modelTextOnly("openai-compatible-custom", null)).toBe(true);
  });
});

describe("modelTextOnly (vision override beats name detection)", () => {
  it('override "on" forces vision even without a vision name', () => {
    expect(modelTextOnly("lmstudio-local", "my-plain-model", "on")).toBe(false);
    expect(
      modelTextOnly("openai-compatible-custom", "some-model", "on"),
    ).toBe(false);
  });

  it('override "off" forces text-only even with a vision name', () => {
    expect(modelTextOnly("lmstudio-local", "qwen2-vl-7b", "off")).toBe(true);
    expect(modelTextOnly("openai-compatible-custom", "llava-1.6", "off")).toBe(
      true,
    );
  });

  it('override "auto" keeps the name heuristic', () => {
    expect(modelTextOnly("lmstudio-local", "qwen2-vl-7b", "auto")).toBe(false);
    expect(modelTextOnly("lmstudio-local", "qwen2.5-coder-7b", "auto")).toBe(
      true,
    );
  });

  it("override does not apply to registry models (they have known tags)", () => {
    // "on" cannot grant vision to a registry text-only model — the override
    // only exists because custom endpoints' registry entries are placeholders.
    expect(modelTextOnly("deepseek-chat", "qwen2-vl", "on")).toBe(true);
  });
});
