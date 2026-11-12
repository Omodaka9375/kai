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
const tgMediaSrc = readFileSync(
  new URL("../../../assistant/media.ts", import.meta.url),
  "utf8",
);
const tgIndexSrc = readFileSync(
  new URL("../../../assistant/index.ts", import.meta.url),
  "utf8",
);
// Provider SELECTION moved out of the tool when the engine became
// key-driven (2026-11-12): the google-only rule for imagePath lives here now.
const providerChoiceSrc = readFileSync(
  new URL("./providerChoice.ts", import.meta.url),
  "utf8",
);

describe("Gemini Omni Flash image-to-video wiring", () => {
  it("sends the reference image as an image input part with task image_to_video", () => {
    expect(videoSrc).toContain("sniffImageMime(image)");
    // Interactions API shape: image part (opening frame) + text part.
    expect(videoSrc).toContain(
      '{ type: "image", data: image, mime_type: sniffImageMime(image) }',
    );
    expect(videoSrc).toContain('{ type: "text", text: opts.prompt }');
    // With an image the task is pinned so it is treated as the OPENING
    // FRAME; text-only leaves the task unset (model infers text_to_video).
    expect(videoSrc).toMatch(
      /image\s*\?\s*\{ video_config: \{ task: "image_to_video" \} \}/,
    );
  });

  it("uses the live Omni model and the Interactions API, not the dead Veo LRO", () => {
    // veo-3.1-generate-preview was shut down 2026-10-22; every call 404s
    // with NOT_FOUND. This pin is the drift gate: if the constant ever
    // references a veo-* or *-preview id again, the suite fails and the
    // model id must be re-verified against the Gemini API docs.
    expect(videoSrc).toContain('const MODEL = "gemini-omni-1.2-flash";');
    expect(videoSrc).not.toMatch(/veo-3\.1-generate-preview/);
    expect(videoSrc).not.toMatch(/predictLongRunning/);
    // The Interactions endpoint, synchronous unary POST.
    expect(videoSrc).toContain("`${BASE}/interactions`");
    // URI delivery (>4MB clips overflow inline base64) + auth'd download.
    expect(videoSrc).toContain('delivery: "uri"');
    expect(videoSrc).toContain("x-goog-api-key");
  });

  it("clamps duration to Omni's 3-15s range and aspect to 16:9/9:16", () => {
    expect(videoSrc).toMatch(/Math\.min\(15, Math\.max\(3, Math\.round\(d as number\)\)\)/);
    expect(videoSrc).toMatch(/function normalizeAspect\(a: string \| undefined\): "16:9" \| "9:16"/);
  });

  it("tool schema exposes imagePath and threads it through", () => {
    expect(videoToolSrc).toContain("imagePath: z");
    expect(videoToolSrc).toMatch(
      /execute: async \(\{ prompt, duration, aspect_ratio, imagePath, count \}, options\)/,
    );
    expect(videoToolSrc).toContain("referenceImage,");
    expect(videoToolSrc).toContain("native.readFileBytes(abs)");
  });

  it("scales the detached-job timeout with the requested count", () => {
    // The old code passed `undefined` (fixed 10-min default) while rendering
    // up to three videos SEQUENTIALLY — count>1 always hit a bogus timeout
    // while later renders were still running.
    expect(videoToolSrc).toContain("wanted * PER_VIDEO_BUDGET_MS");
    expect(videoToolSrc).not.toMatch(/spawnMediaTask\(\s*\n?\s*ctx\.getSessionId\(\),\s*\n?\s*options\.toolCallId,[\s\S]*?\n\s*undefined,/);
  });
});

describe("Telegram assistant edit/animate wiring", () => {
  it("assistant media tools expose the attached-photo edit/animate path", () => {
    // Schema flags (model-visible surface).
    expect(tgMediaSrc).toContain("edit_attached_image");
    expect(tgMediaSrc).toContain("animate_attached_image");
    // 2026-11-02: the edit/animate source is resolved LAZILY at call time -
    // the current turn's photo first, then the newest photo in history
    // (photos.ts edit-follow-up seam). The old eager turnImage lost the
    // photo on follow-up turns ("try now" after an expired-key error) and
    // asked the user to re-send it.
    expect(tgMediaSrc).toMatch(/edit_attached_image \? await getTurnImage\?\.\(\)/);
    expect(tgMediaSrc).toMatch(/animate_attached_image \? await getTurnImage\?\.\(\)/);
    expect(tgMediaSrc).toMatch(/referenceImage = edit_attached_image \? turnImage\?\.base64/);
    expect(tgMediaSrc).toMatch(/referenceImage = animate_attached_image \? turnImage\?\.base64/);
    // Both thread through to the underlying gens.
    expect(tgMediaSrc).toContain("gen(p.key, { prompt, size, referenceImage })");
    expect(tgMediaSrc).toContain("referenceImage,");
  });

  it("runAssistantTurn threads a LAZY image resolver into both tools", () => {
    // 2026-11-02: the resolver prefers the current turn's attachment and
    // falls back to the newest photo in history (read back from scratch via
    // sourcePath - latestPhotoSourcePath in photos.ts), so a "try now"
    // follow-up after an expired-key error still finds the photo.
    expect(tgIndexSrc).toContain("buildAssistantMediaTools(getTurnImage)");
    expect(tgIndexSrc).toMatch(/turnImageNow = opts\?\.imageBase64/);
    expect(tgIndexSrc).toContain("if (turnImageNow) return turnImageNow;");
    expect(tgIndexSrc).toContain("latestPhotoSourcePath(await loadHistory(sessionId))");
    // Built once and both keys read from it (allowlist-gated), rather than
    // building twice. The photo must reach both the image and video tool.
    expect(tgIndexSrc).toContain(`assistantMedia["generate_image"]`);
    expect(tgIndexSrc).toContain(`assistantMedia["generate_video"]`);
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
      /execute: async \(\{ prompt, provider, size, quality, count, imagePath \}, options\)/,
    );
    // The reference image must reach the provider call (the call object is
    // inline now that the tool also threads count/engine).
    expect(toolSrc).toMatch(/callProvider\(engine, key, \{[\s\S]*?referenceImage[\s\S]*?\}\)/);
  });

  it("non-google providers refuse imagePath explicitly", () => {
    // The refusal is a key-availability decision now (documented in
    // providerChoice.ts): editing needs a Google key, so a request with
    // imagePath either uses Google or fails with an actionable message
    // instead of silently dropping the reference image.
    expect(providerChoiceSrc).toContain("imagePath editing needs a Google API key");
    expect(providerChoiceSrc).toMatch(/needsEditing[\s\S]*available\.includes\("google"\)/);
    // The tool must pass needsEditing whenever a reference image was read.
    expect(toolSrc).toContain("needsEditing: referenceImage !== undefined");
  });

  it("the tool reads the image bytes via the native fs bridge", () => {
    expect(toolSrc).toContain("native.readFileBytes(abs)");
    expect(toolSrc).toContain("resolvePath(imagePath, cwd)");
  });
});
