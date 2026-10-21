import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-contract pins: Nano Banana 2 (Gemini image) EDITING.
 *
 * The model is natively multimodal INPUT — image editing is the same
 * generateContent call with an inlineData part ahead of the text
 * instruction. No separate /edits endpoint. Pinned here so the wiring
 * (which existed in the type as `referenceImage` but was never sent)
 * can't silently regress to text-only requests:
 *   1. google-image.ts sends the reference image as an inlineData part.
 *   2. The tool schema exposes imagePath and threads it to referenceImage.
 *   3. Non-google providers refuse imagePath explicitly (never silently
 *      drop the edit input).
 *   4. The request mime comes from magic bytes, not a hardcoded constant.
 */

// NOTE depth: this file lives at src/modules/ai/lib/media/ — the sources it
// pins are CWD-relative here, NOT ../../../-style escapes (that class of
// off-by-N has bitten watch.test.ts and dndConfig tests before).
const googleSrc = readFileSync(new URL("./google-image.ts", import.meta.url), "utf8");
const toolSrc = readFileSync(new URL("../../tools/image-gen.ts", import.meta.url), "utf8");
const videoSrc = readFileSync(new URL("./google-video.ts", import.meta.url), "utf8");
const videoToolSrc = readFileSync(new URL("../../tools/video-gen.ts", import.meta.url), "utf8");

describe("Veo 3.1 image-to-video wiring", () => {
  it("sends the reference image as instances[0].image", () => {
    expect(videoSrc).toContain("sniffImageMime(opts.referenceImage)");
    expect(videoSrc).toContain("bytesBase64Encoded: opts.referenceImage");
    // Binary: image present → image-to-video; absent → text-to-video.
    expect(videoSrc).toMatch(
      /opts\.referenceImage[\s\S]*\? \{ prompt: opts\.prompt, image:[\s\S]*: \{ prompt: opts\.prompt \}/,
    );
  });

  it("tool schema exposes imagePath and threads it through", () => {
    expect(videoToolSrc).toContain("imagePath: z");
    expect(videoToolSrc).toMatch(
      /execute: async \(\{ prompt, duration, aspect_ratio, imagePath \}, options\)/,
    );
    expect(videoToolSrc).toContain("referenceImage,");
    expect(videoToolSrc).toContain("native.readFileBytes(abs)");
  });
});

describe("Nano Banana 2 image editing wiring", () => {
  it("sends the reference image as an inlineData part", () => {
    expect(googleSrc).toContain("inlineData: { mimeType: sniffImageMime");
    expect(googleSrc).toMatch(/inlineData[\s\S]*data: opts\.referenceImage/);
    // The text instruction rides alongside, not instead.
    expect(googleSrc).toContain("reqParts.push({ text: opts.prompt })");
    // parts: reqParts is what actually goes into contents[0].
    expect(googleSrc).toContain("parts: reqParts,");
  });

  it("sniffs the mime from magic bytes (Gemini rejects wrong mimeType)", () => {
    expect(googleSrc).toContain("function sniffImageMime");
    expect(googleSrc).toMatch(/0xd8.*image\/jpeg|image\/jpeg.*0xd8/);
    expect(googleSrc).toContain("return \"image/png\";");
  });

  it("tool schema exposes imagePath and threads it through", () => {
    expect(toolSrc).toContain("imagePath: z");
    expect(toolSrc).toMatch(
      /execute: async \(\{ prompt, provider, size, quality, imagePath \}, options\)/,
    );
    expect(toolSrc).toContain("referenceImage,");
  });

  it("non-google providers refuse imagePath explicitly", () => {
    expect(toolSrc).toContain("imagePath editing is google-only");
  });

  it("the tool reads the image bytes via the native fs bridge", () => {
    expect(toolSrc).toContain("native.readFileBytes(abs)");
    expect(toolSrc).toContain("resolvePath(imagePath, cwd)");
  });
});