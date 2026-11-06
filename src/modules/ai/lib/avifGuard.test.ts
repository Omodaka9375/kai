import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * SOURCE PINS for the 2026-11-06 report: "Uploading files like avif via +
 * button broke the session convo. Tried re-uploading new one but couldn't
 * continue."
 *
 * Mechanism: readAttachment's image/* branch attached ANY image type; the
 * providers only accept png/jpeg/webp/gif and 400 the whole request for an
 * unsupported part - and because the part PERSISTS into session history,
 * every later request (including the good re-upload) replayed the poison
 * and failed. Three-layer fix pinned here: intake transcode, text fallback,
 * and the model-bound replay sanitizer that un-bricks already-poisoned
 * sessions.
 */
describe("AVIF poison-image guard (source pins)", () => {
  const composer = readFileSync(
    new URL("../components/composer.tsx", import.meta.url),
    "utf8",
  );
  const agent = readFileSync(
    new URL("./agent.ts", import.meta.url),
    "utf8",
  );
  const extraction = readFileSync(
    new URL("../extraction.ts", import.meta.url),
    "utf8",
  );

  it("the shared allowlist exists (png/jpeg/webp/gif only)", () => {
    expect(extraction).toContain("export const PROVIDER_IMAGE_TYPES");
    expect(extraction).toContain('"image/png"');
    expect(extraction).toContain('"image/webp"');
    expect(extraction).not.toContain('"image/avif"');
  });

  it("readAttachment transcodes non-provider images and falls back to text", () => {
    // The gate: provider-safe types pass through untouched...
    expect(composer).toContain("if (isProviderImageType(file.type))");
    // ...everything else transcodes to PNG...
    expect(composer).toContain("const pngUrl = await transcodeToProviderImage(rawUrl);");
    expect(composer).toContain('mediaType: "image/png"');
    // ...and a failed transcode attaches a TEXT note, never a poison image part.
    expect(composer).toContain("could not be converted to a provider-supported format");
  });

  it("agent.ts scrubs unsupported image parts from MODEL-BOUND history (un-bricks poisoned sessions)", () => {
    expect(agent).toContain("function stripUnsupportedImageParts(");
    // The sanitizer runs on rawHistory BEFORE the vision swap / provider send.
    const stripIdx = agent.indexOf("stripUnsupportedImageParts(");
    const rawIdx = agent.indexOf("const rawHistory = stripUnsupportedImageParts(");
    expect(stripIdx).toBeGreaterThan(-1);
    expect(rawIdx).toBeGreaterThan(-1);
    // It gates on the same allowlist (no parallel list to drift).
    expect(agent).toContain("isProviderImageType(part.mediaType)");
    // The check runs regardless of vision capability (a text-only model's
    // OCR swap also cannot decode avif).
    expect(agent.indexOf("stripUnsupportedImageParts(")).toBeLessThan(
      agent.indexOf("swapImagePartsToText(rawHistory)"),
    );
  });
});
