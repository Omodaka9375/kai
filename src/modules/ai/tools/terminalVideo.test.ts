import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { shellQuoteForTest, videoMimeForTest } from "./terminalVideo";

/**
 * Adversarial cases for the shellQuote gate. The command runs through the
 * Rust oneshot runner (PowerShell -File on Windows, sh elsewhere), so every
 * metachar must be rejected outright — an earlier draft had `&` outside the
 * regex character class, which accepted `x"; cmd; #` (statement injection).
 */
describe("shellQuote gate", () => {
  it("rejects statement/quoting injection attempts", () => {
    for (const evil of [
      'x"; calc; #',
      "a;b",
      'a"b',
      "$(calc)",
      "`calc`",
      "a&b",
      "C:\\Videos\\x.mp4",
    ]) {
      expect(() => shellQuoteForTest(evil)).toThrow();
    }
  });

  it("allows ordinary paths and URLs (quoted)", () => {
    for (const fine of ["plain-name.mp4", "my (final) cut.mp4", "https://host/v.mp4"]) {
      expect(shellQuoteForTest(fine)).toBe(`"${fine}"`);
    }
  });
});

describe("video MIME hints", () => {
  it("maps common containers", () => {
    expect(videoMimeForTest("out/neon-tunnel.mp4")).toBe("video/mp4");
    expect(videoMimeForTest("C:\\a\\b.MOV")).toBe("video/quicktime");
    expect(videoMimeForTest("clip.webm")).toBe("video/webm");
    expect(videoMimeForTest("film.mkv")).toBe("video/x-matroska");
    expect(videoMimeForTest("noext")).toBe("video/mp4");
  });
});

/** SOURCE PINS (2026-11-06: "Videos should be displayed in chat as well as
 *  images" — display_video erroled "no active terminal tab to display into"
 *  instead of showing the video in the chat like generate_video does). */
describe("display_video chat-card wiring (source pins)", () => {
  const src = readFileSync(new URL("./terminalVideo.ts", import.meta.url), "utf8");
  const chat = readFileSync(
    new URL("../components/AiChat.tsx", import.meta.url),
    "utf8",
  );

  it("success output carries the MediaMessage video shape (isMediaOutput matches)", () => {
    // The card payload: type video + base64, so isMediaOutput(part.output)
    // is true and MediaMessage renders the playable card.
    expect(src).toContain('type: "video" as const');
    expect(src).toContain("base64,");
  });

  it("no ffmpeg no longer fails the tool — only skips the terminal poster", () => {
    // The old hard return { ok:false, note:"ffmpeg not found..." } is gone.
    expect(src).not.toContain("ok: false");
    expect(src).toContain("skipping the terminal poster frame");
  });

  it("no active terminal no longer errors — chat card is a first-class surface", () => {
    // The old hard error on a missing terminal is gone; the only remaining
    // error path fires when BOTH surfaces failed (oversized + no terminal).
    expect(src).not.toContain('return { error: "no active terminal tab to display into" };');
    // The chat bytes are read through the fs module under a size cap.
    expect(src).toContain("CHAT_VIDEO_CAP_BYTES");
    expect(src).toContain("native.readFileBytes(localPath)");
  });

  it("AiChat routes display_video through MediaMessage", () => {
    expect(chat).toContain('toolName === "display_video"');
  });
});
