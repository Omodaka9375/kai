import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { persistGeneratedMedia, type PersistFs } from "./persist";
import {
  isMediaResultShape,
  summarizeMediaOutputs,
} from "../../extraction";
import type { ModelMessage } from "ai";

// ── Behavioral: summarizeMediaOutputs ─────────────────────────────────────

function toolResultMsg(output: unknown): ModelMessage {
  return {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: "call_1", toolName: "generate_image", output },
    ],
  } as unknown as ModelMessage;
}

describe("summarizeMediaOutputs", () => {
  it("replaces a resolved media payload with a short summary + savedPath", () => {
    const big = "A".repeat(2_700_000); // ~2.7MB base64 -> ~700k tokens
    const msg = toolResultMsg({
      type: "image",
      provider: "google",
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      base64: big,
      savedPath: "C:/Users/x/.kai/media/cat-20261112.png",
      prompt: "a cat",
    });
    const out = summarizeMediaOutputs([msg]);
    const part = (out[0]! as { content: { type: string; output: Record<string, unknown> }[] }).content[0]!;
    expect(part.type).toBe("tool-result");
    expect(part.output.summary).toBe("generated image, 1024x1024, provider: google");
    expect(part.output.savedPath).toBe("C:/Users/x/.kai/media/cat-20261112.png");
    expect(String(part.output.note)).toContain("generate_video (imagePath)");
    // THE fix: no base64 in the model-bound copy.
    expect(JSON.stringify(out).length).toBeLessThan(1000);
    expect(JSON.stringify(out)).not.toContain("AAAA");
  });

  it("summarizes a video result with duration", () => {
    const msg = toolResultMsg({
      type: "video",
      provider: "google",
      mimeType: "video/mp4",
      durationSeconds: 8,
      base64: "QUJD", // tiny stub — shape is what matters
      savedPath: "C:/Users/x/.kai/media/clip-20261112.mp4",
    });
    const out = summarizeMediaOutputs([msg]);
    const part = (out[0]! as { content: { output: Record<string, unknown> }[] }).content[0]!;
    expect(part.output.summary).toBe("generated video, 8s, provider: google");
    expect(part.output.savedPath).toBe("C:/Users/x/.kai/media/clip-20261112.mp4");
  });

  it("flags a result with no savedPath as chat-only", () => {
    const msg = toolResultMsg({ type: "image", base64: "QUJD", url: "https://x/y.png" });
    const out = summarizeMediaOutputs([msg]);
    const part = (out[0]! as { content: { output: Record<string, unknown> }[] }).content[0]!;
    expect(part.output.savedPath).toBeUndefined();
    expect(String(part.output.note)).toContain("chat card only");
  });

  it("leaves non-media tool results and plain messages untouched (identity)", () => {
    const plain: ModelMessage = { role: "user", content: "hello" };
    const other = toolResultMsg({ type: "text", content: "not media" });
    const out = summarizeMediaOutputs([plain, other]);
    expect(out[0]).toBe(plain); // identity — no needless clone
    expect(out[1]).toBe(other);
  });

  it("keeps error outputs as-is (they are small and actionable)", () => {
    const err = toolResultMsg({ error: "no key" });
    const out = summarizeMediaOutputs([err]);
    expect(out[0]).toBe(err); // isMediaResultShape is false — untouched
  });
});

// ── Behavioral: isMediaResultShape edge cases ─────────────────────────────

describe("isMediaResultShape", () => {
  it("rejects non-objects, arrays, and payload-less shapes", () => {
    expect(isMediaResultShape(null)).toBe(false);
    expect(isMediaResultShape("image")).toBe(false);
    expect(isMediaResultShape([{ type: "image" }])).toBe(false);
    expect(isMediaResultShape({ type: "image" })).toBe(false); // no base64/url
    expect(isMediaResultShape({ type: "text", base64: "x" })).toBe(false);
  });
});

// ── Behavioral: persistGeneratedMedia ─────────────────────────────────────

const fsMock: PersistFs = {
  createDir: vi.fn(async () => {}),
  writeFileBytes: vi.fn(async () => {}),
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "kai_home_dir") return "C:/Users/test";
    if (cmd === "fs_create_dir") return fsMock.createDir(args!.path as string);
    if (cmd === "fs_write_file_bytes") return fsMock.writeFileBytes(args!.path as string, args!.bytes as number[]);
    throw new Error(`unexpected invoke: ${cmd}`);
  }),
}));

describe("persistGeneratedMedia", () => {
  it("writes the decoded bytes under ~/.kai/media with a safe name", async () => {
    const path = await persistGeneratedMedia(fsMock, {
      kind: "image",
      prompt: "a cat on a / roof",
      mimeType: "image/png",
      base64: "QUJD", // "ABC"
    });
    // safeMediaFilename = sanitized stem + second-precision timestamp + ext.
    expect(path).toMatch(/^C:\/Users\/test\/\.kai\/media\/a-cat-on-a-roof-\d{8}-\d{6}\.png$/);
    const calls = (fsMock.writeFileBytes as ReturnType<typeof vi.fn>).mock.calls;
    const [target, bytes] = calls[calls.length - 1]!;
    expect(target).toBe(path);
    expect(bytes).toEqual([65, 66, 67]);
  });

  it("disambiguates entries of one request with an index suffix", async () => {
    const p0 = await persistGeneratedMedia(fsMock, { kind: "image", prompt: "x", mimeType: "image/png", base64: "QUJD", index: 0 });
    const p1 = await persistGeneratedMedia(fsMock, { kind: "image", prompt: "x", mimeType: "image/png", base64: "QUJD", index: 1 });
    expect(p0).not.toBe(p1);
    expect(String(p1)).toMatch(/-2\.png$/);
  });

  it("returns undefined for an empty payload instead of writing garbage", async () => {
    const path = await persistGeneratedMedia(fsMock, { kind: "image", prompt: "x", mimeType: "image/png", base64: "" });
    expect(path).toBeUndefined();
  });

  it("never throws when the fs write fails", async () => {
    (fsMock.writeFileBytes as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("disk full"));
    const path = await persistGeneratedMedia(fsMock, { kind: "video", prompt: "x", mimeType: "video/mp4", base64: "QUJD" });
    expect(path).toBeUndefined();
  });
});

// ── Source pins: the wiring cannot silently regress ───────────────────────

const agentSrc = readFileSync(new URL("../agent.ts", import.meta.url), "utf8");
const imageToolSrc = readFileSync(new URL("../../tools/image-gen.ts", import.meta.url), "utf8");
const videoToolSrc = readFileSync(new URL("../../tools/video-gen.ts", import.meta.url), "utf8");
const persistSrc = readFileSync(new URL("./persist.ts", import.meta.url), "utf8");

describe("media context fix wiring (2026-11-12)", () => {
  it("agent.ts summarizes media outputs in the model-bound history", () => {
    // Pin AFTER normalization: provider-specific tool serialization cannot
    // reintroduce a wrapped payload the summarizer has already discarded.
    expect(agentSrc).toContain("summarizeMediaOutputs");
    expect(agentSrc).toMatch(/const history = summarizeMediaOutputs\(\s*normalizeForProvider\(/);
  });

  it("both media tools persist results and surface savedPath", () => {
    for (const src of [imageToolSrc, videoToolSrc]) {
      expect(src).toContain("persistGeneratedMedia");
      expect(src).toContain("savedPath");
    }
    // The single-fields mirror + per-entry copies both carry the path.
    expect(imageToolSrc).toContain("savedPath: savedPaths[0]");
    expect(imageToolSrc).toContain("savedPath: savedPaths[i]");
    expect(videoToolSrc).toContain("savedPath: savedPaths[0]");
    expect(videoToolSrc).toContain("savedPath: savedPaths[i]");
  });

  it("the summarizer drops base64 from the model-bound copy only", () => {
    // The summary builder must NOT copy base64/bytes/image fields through.
    const summarySrc = readFileSync(new URL("./modelSummary.ts", import.meta.url), "utf8");
    const summaryStart = summarySrc.indexOf("export function mediaSummary(");
    const summaryBlock = summarySrc.slice(
      summaryStart,
      summarySrc.indexOf("/** Safe for both", summaryStart),
    );
    expect(summaryBlock).not.toMatch(/\bbase64\b/);
    expect(summaryBlock).not.toMatch(/\bbytes\b/);
  });

  it("persist writes under the .kai media dir via the native bridge", () => {
    expect(persistSrc).toContain("/.kai/media");
    expect(persistSrc).toContain("kai_home_dir");
    expect(persistSrc).toContain("writeFileBytes");
  });
});
