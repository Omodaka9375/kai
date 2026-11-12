import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-contract pins for the two defects behind "the image showed up, then
 * vanished and regenerated" (2026-11-12).
 *
 * 1. The AI SDK owns `chat.messages`. `replaceMessage` rewrites the in-flight
 *    assistant message from the SDK's OWN response state on the next stream
 *    write, which never saw the detached media patch — so a resolved image was
 *    clobbered back to `{status:"generating"}`. The fix is a render-time
 *    overlay (`getMediaOverride`) that the card reads first; the chat card must
 *    NEVER read `part.output` directly for a media tool.
 * 2. A model that reads the placeholder as a failure retries. The tool result
 *    now carries a `next` instruction, and the task layer dedupes by job key
 *    (in-flight sharing + completed reuse) so a retry cannot buy a second
 *    generation.
 */

const chatStoreSrc = readFileSync(
  new URL("../../store/chatStore.ts", import.meta.url),
  "utf8",
);
const aiChatSrc = readFileSync(
  new URL("../../components/AiChat.tsx", import.meta.url),
  "utf8",
);
const taskSrc = readFileSync(new URL("./task.ts", import.meta.url), "utf8");
const imageToolSrc = readFileSync(new URL("../../tools/image-gen.ts", import.meta.url), "utf8");
const videoToolSrc = readFileSync(new URL("../../tools/video-gen.ts", import.meta.url), "utf8");

describe("resolved media survives SDK state churn", () => {
  it("resolveMedia records the overlay even with no live chat", () => {
    expect(chatStoreSrc).toContain("const mediaOverrides = new Map<string, unknown>();");
    expect(chatStoreSrc).toContain("export function getMediaOverride(");
    // The overlay write must happen BEFORE the `if (!chat) return;` bail -
    // a card that mounts later still has to find the result.
    const overlayIdx = chatStoreSrc.indexOf("mediaOverrides.set(toolCallId, output);");
    const bailIdx = chatStoreSrc.indexOf("    if (!chat) return;", overlayIdx);
    expect(overlayIdx).toBeGreaterThan(-1);
    expect(bailIdx).toBeGreaterThan(overlayIdx);
  });

  it("a resolve re-renders even when the transcript patch misses", () => {
    // The clobber window: the part lookup fails while the SDK is mid-stream.
    expect(chatStoreSrc).toMatch(
      /if \(!mutated\) \{\s*set\(\{ _tick: Date\.now\(\) \}\);\s*return;\s*\}/,
    );
  });

  it("the media card reads the overlay, not part.output", () => {
    expect(aiChatSrc).toContain("getMediaOverride(part.toolCallId)");
    expect(aiChatSrc).toMatch(
      /const mediaOutput =\s*resolvedMediaOutput \?\? \("output" in part \? part\.output : undefined\)/,
    );
    // Every media branch must go through `mediaOutput`; reading part.output
    // directly is the exact regression this pins.
    for (const [label, pattern] of [
      ["isMediaOutput", /isMediaOutput\(mediaOutput\)/],
      ["isGeneratingMedia", /isGeneratingMedia\(mediaOutput\)/],
      ["error branch", /\(mediaOutput as \{ error\?: unknown \} \| undefined\)\?\.error/],
      ["MediaMessage", /<MediaMessage output=\{mediaOutput\} \/>/],
    ] as const) {
      expect(aiChatSrc, label).toMatch(pattern);
    }
    expect(aiChatSrc).not.toContain("isGeneratingMedia(part.output)");
    expect(aiChatSrc).not.toContain("<MediaMessage output={part.output} />");
  });

  it("deleting a session retires its overlay entries", () => {
    expect(chatStoreSrc).toContain("clearMediaOverridesForSession(id);");
    expect(chatStoreSrc).toMatch(
      /function clearMediaOverridesForSession\(sessionId: string\): void \{[\s\S]*mediaOverrides\.delete\(r\.toolCallId\)/,
    );
  });
});

describe("a retry cannot buy a second generation", () => {
  it("both media tools pass a dedupe key", () => {
    // The key carries `wanted` (count) too: two calls for 2 images must NOT
    // be treated as a retry of a 1-image job.
    expect(imageToolSrc).toMatch(/const dedupeKey = `image:\$\{engine\}:\$\{wanted\}/);
    expect(imageToolSrc).toMatch(/\n\s*dedupeKey,\n\s*\);/);
    expect(videoToolSrc).toMatch(/const dedupeKey = `video:\$\{wanted\}/);
    expect(videoToolSrc).toMatch(/\n\s*dedupeKey,\n\s*\);/);
  });

  it("the placeholder tells the model not to retry", () => {
    expect(imageToolSrc).toContain("Do NOT call generate_image again");
    expect(videoToolSrc).toContain("Do NOT call generate_video again");
  });

  it("an in-flight or completed job answer is shared, a failure is not", () => {
    expect(taskSrc).toContain("inFlight.toolCallIds.add(toolCallId);");
    expect(taskSrc).toContain("completedJobs.get(sessionId)?.get(jobKey)");
    // Failures must stay retryable.
    expect(taskSrc).toMatch(
      /function rememberCompleted[\s\S]*"error" in output\) return;/,
    );
    // Bounded: image base64 is megabytes per entry.
    expect(taskSrc).toContain("COMPLETED_KEY_CAP");
  });
});
