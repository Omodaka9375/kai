import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * "when user ask for an image or video gen it should generate exactly one,
 * unless user specifies 2 or more" (2026-11-12).
 *
 * Before: the tools had no count input, so the ONLY way a model could satisfy
 * "give me two versions" was to call the tool twice - and it also called twice
 * whenever it misread the placeholder as a failure. Now `count` is an explicit
 * input (default 1, clamped) and the description forbids repeat calls.
 */

const imageToolSrc = readFileSync(new URL("../../tools/image-gen.ts", import.meta.url), "utf8");
const videoToolSrc = readFileSync(new URL("../../tools/video-gen.ts", import.meta.url), "utf8");
const mediaSrc = readFileSync(new URL("../../components/MediaMessage.tsx", import.meta.url), "utf8");

describe("image count contract", () => {
  it("exposes a count input clamped to 1..4", () => {
    expect(imageToolSrc).toMatch(/count: z\s*\n\s*\.number\(\)\s*\n\s*\.int\(\)\s*\n\s*\.min\(1\)\s*\n\s*\.max\(4\)/);
    expect(imageToolSrc).toContain("Math.min(4, Math.max(1, Math.round(count ?? 1)))");
  });

  it("tells the model to generate exactly one unless asked otherwise", () => {
    expect(imageToolSrc).toContain("ONE GENERATION PER REQUEST");
    expect(imageToolSrc).toContain("set count instead");
  });

  it("count participates in the dedupe key", () => {
    // Two calls for 2 images must not be treated as a retry of a 1-image job.
    expect(imageToolSrc).toMatch(/dedupeKey = `image:\$\{engine\}:\$\{wanted\}/);
  });

  it("generates sequentially so a burst cannot trip the rate limiter", () => {
    expect(imageToolSrc).toMatch(/async function generateMany[\s\S]*for \(let i = 0; i < n; i\+\+\) out\.push\(await gen\(\)\)/);
  });

  it("keeps the single-image fields as entry 0 for existing consumers", () => {
    expect(imageToolSrc).toMatch(/base64: results\[0\]!\.base64/);
    expect(imageToolSrc).toContain("images: results.map(");
  });
});

describe("video count contract", () => {
  it("exposes a count input clamped to 1..3", () => {
    expect(videoToolSrc).toMatch(/count: z\s*\n\s*\.number\(\)\s*\n\s*\.int\(\)\s*\n\s*\.min\(1\)\s*\n\s*\.max\(3\)/);
    expect(videoToolSrc).toContain("Math.min(3, Math.max(1, Math.round(count ?? 1)))");
    expect(videoToolSrc).toContain("ONE GENERATION PER REQUEST");
  });

  it("threads count through the dedupe key and the result", () => {
    expect(videoToolSrc).toMatch(/dedupeKey = `video:\$\{wanted\}/);
    expect(videoToolSrc).toContain("videos: results.map(");
    expect(videoToolSrc).toMatch(/async function generateVideos[\s\S]*await gen\(\)/);
  });
});

describe("multi-media rendering", () => {
  it("renders every entry inside ONE card", () => {
    expect(mediaSrc).toContain("imageEntries.map((entry, i) => (");
    expect(mediaSrc).toContain("videoEntries.map((entry, i) => (");
    // A grid must only engage for multi - a single entry keeps the big view.
    expect(mediaSrc).toMatch(/const multi = output\.type === "image"\s*\?\s*imageEntries\.length > 1\s*:\s*videoEntries\.length > 1/);
  });

  it("does not render a broken entry as a blank frame", () => {
    expect(mediaSrc).toMatch(/return all\.filter\(\(e\) => entrySrc\(e\) !== ""\)/);
  });

  it("saving targets the clicked image, not always the first", () => {
    expect(mediaSrc).toContain("const download = (entry?: ImageEntry) => {");
    expect(mediaSrc).toContain("a.href = entry ? entrySrc(entry) : src");
  });
});

describe("download filenames are normalized", () => {
  it("no media component feeds a prompt straight into a.download", () => {
    // The live bug: `a.download = alt ?? ...` put the whole prompt in the
    // save dialog's name field.
    expect(mediaSrc).not.toMatch(/a\.download = output\.prompt/);
    expect(mediaSrc).toContain("safeMediaFilename(");
  });

  it("the lightbox generates a safe name instead of using alt", () => {
    const lightboxSrc = readFileSync(
      new URL("../../components/MediaLightbox.tsx", import.meta.url),
      "utf8",
    );
    expect(lightboxSrc).toContain("safeMediaFilename(alt,");
    expect(lightboxSrc).not.toMatch(/a\.download = alt \?\?/);
    // `alt` stays the accessible description only.
    expect(lightboxSrc).toMatch(/alt=\{alt \?\? "Generated image"\}/);
  });

  it("the lightbox is portaled to document.body, not rendered inline", () => {
    const lightboxSrc = readFileSync(
      new URL("../../components/MediaLightbox.tsx", import.meta.url),
      "utf8",
    );
    // Every chat message part sits inside a framer-motion wrapper
    // (PartAppear) with willChange: transform, which is BOTH a containing
    // block for `fixed` descendants and its own stacking context. An inline
    // lightbox was therefore clamped to that part's rect and could not paint
    // above sibling tool output (text over the image, close button
    // unclickable). The portal is what makes inset-0 mean the viewport.
    expect(lightboxSrc).toContain('from "react-dom"');
    expect(lightboxSrc).toContain("createPortal(");
    expect(lightboxSrc).toMatch(/^\s*document\.body,$/m);
    // Guards against a partial revert: no bare `return (` of the overlay.
    expect(lightboxSrc).not.toMatch(/return\s*\(\s*<div\s+className="fixed inset-0/);
  });
});
