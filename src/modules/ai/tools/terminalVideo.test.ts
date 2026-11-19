import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { videoMimeForTest } from "./terminalVideo";

describe("video MIME hints", () => {
  it("maps common containers", () => {
    expect(videoMimeForTest("out/neon-tunnel.mp4")).toBe("video/mp4");
    expect(videoMimeForTest("C:\\a\\b.MOV")).toBe("video/quicktime");
    expect(videoMimeForTest("clip.webm")).toBe("video/webm");
    expect(videoMimeForTest("film.mkv")).toBe("video/x-matroska");
    expect(videoMimeForTest("noext")).toBe("video/mp4");
  });
});

/** SOURCE PINS. display_video is CHAT-ONLY (2026-11-19): the old second
 *  surface extracted a poster frame with ffmpeg and pushed an OSC 1337
 *  inline image into the active terminal — agent output had no business in
 *  the user's terminal, and the sibling image path had already misfired
 *  into shell stdin. The ffmpeg/shell machinery is gone entirely. */
describe("display_video chat-only wiring (source pins)", () => {
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

  it("has no terminal write path, no ffmpeg, no shell quoting", () => {
    expect(src).not.toContain("writeToActiveTerminalDisplay");
    expect(src).not.toContain("injectIntoActivePty");
    expect(src).not.toContain("hasFfmpeg");
    expect(src).not.toContain("shellQuote");
    expect(src).not.toContain("runCommand");
    expect(src).not.toContain("buildOsc1337");
    // The head comment still documents OSC 1337 for the terminal module's
    // parser — but the TOOL must not build sequences.
    expect(src).not.toContain("extractPosterFrame");
  });

  it("the chat bytes are read through the fs module under a size cap", () => {
    expect(src).toContain("CHAT_VIDEO_CAP_BYTES");
    expect(src).toContain("native.readFileBytes(localPath)");
  });

  it("tool description tells the model nothing goes to the terminal", () => {
    expect(src).toContain("Nothing is ever written into the user's terminal");
  });

  it("AiChat routes display_video through MediaMessage", () => {
    expect(chat).toContain('toolName === "display_video"');
  });
});
