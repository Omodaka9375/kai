import { describe, expect, it } from "vitest";
import {
  hasInlineImageParts,
  looksLikeVisionModel,
  modelTextOnly,
  swapImagePartsToText,
} from "./extraction";

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

describe("hasInlineImageParts (both part shapes)", () => {
  it("detects the desktop file-shape image part", () => {
    expect(
      hasInlineImageParts([
        { role: "user", content: [{ type: "file", mediaType: "image/png", data: "AAAA" }] },
      ] as never),
    ).toBe(true);
  });
  it("detects the assistant image-shape part", () => {
    expect(
      hasInlineImageParts([
        { role: "user", content: [{ type: "text", text: "x" }, { type: "image", image: "AAAA" }] },
      ] as never),
    ).toBe(true);
  });
  it("false for text-only messages and non-image files", () => {
    expect(hasInlineImageParts([{ role: "user", content: "hi" }] as never)).toBe(false);
    expect(
      hasInlineImageParts([
        { role: "user", content: [{ type: "file", mediaType: "application/pdf", data: "AAAA" }] },
      ] as never),
    ).toBe(false);
  });
});

describe("swapImagePartsToText (shared OCR fallback)", () => {
  it("replaces the assistant image-shape part with a text part, keeping siblings", async () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this?" },
          { type: "image", image: "AAAA", mediaType: "image/jpeg" },
        ],
      },
    ] as never;
    const out = (await swapImagePartsToText(msgs)) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;
    const parts = out[0].content;
    // The text sibling survives; the image part became a text part.
    expect(parts[0]).toEqual({ type: "text", text: "what is in this?" });
    expect(parts[1].type).toBe("text");
    // No OCR engine in node test env → graceful fallback, never a throw, and
    // never a raw image left behind.
    expect(parts[1].text).toContain("image");
  });

  it("returns non-image messages by identity (no needless clones)", async () => {
    const plain = { role: "user", content: [{ type: "text", text: "hi" }] } as never;
    const out = await swapImagePartsToText([plain]);
    expect(out[0]).toBe(plain);
  });
});
