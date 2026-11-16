import { describe, expect, it } from "vitest";
import { buildScreenTools } from "./screen";
import type { ToolContext, PendingToolImage } from "./context";

/**
 * USER-MESSAGE IMAGE HANDOFF (2026-11-16): a vision model on an
 * openai-compatible wire cannot receive tool-result image parts (the
 * converter stringifies them), but its USER-message converter renders image
 * file parts as image_url. look_at_screen must queue the screenshot for the
 * agent loop to splice, and tell the model where to find it — NOT claim the
 * provider "cannot receive images" (the 2026-11-16 report: a Qwen vision
 * endpoint honestly reported it got no pixels while the user's Vision
 * setting was ON).
 */

const IMG = "aGVsbG8="; // "hello" in base64 — only shape matters here
const DATA_URL = `data:image/jpeg;base64,${IMG}`;

type Ctx = Partial<ToolContext> & {
  pending: PendingToolImage[];
};

function makeCtx(over: Partial<ToolContext>): Ctx {
  const pending: PendingToolImage[] = [];
  return {
    pending,
    supportsToolResultImages: over.supportsToolResultImages,
    canSeeImages: over.canSeeImages,
    registerPendingToolImage: (img) => pending.push(img),
    consumePendingToolImages: () => pending.splice(0),
  };
}

async function runTool(ctx: Ctx, focus?: string) {
  const tools = buildScreenTools(ctx as ToolContext);
  const t = tools.look_at_screen as unknown as {
    toModelOutput: (args: { output: unknown }) => Promise<unknown>;
  };
  const output = {
    monitor: { id: 0, resolution: "1920x1080" },
    sizeBytes: 1234,
    image: { dataUrl: DATA_URL },
    ...(focus ? { focus } : {}),
  };
  return t.toModelOutput({ output });
}

describe("look_at_screen image delivery routing", () => {
  it("first-party wire: image-data tool-result part, no queue", async () => {
    const ctx = makeCtx({ supportsToolResultImages: () => true, canSeeImages: () => true });
    const out = (await runTool(ctx)) as {
      type: string;
      value: { type: string }[];
    };
    expect(out.type).toBe("content");
    expect(out.value.some((p) => p.type === "image-data")).toBe(true);
    expect(ctx.pending).toHaveLength(0);
  });

  it("vision model on openai-compatible wire: queues the image and says where it is", async () => {
    const ctx = makeCtx({ supportsToolResultImages: () => false, canSeeImages: () => true });
    const out = (await runTool(ctx, "the save dialog")) as {
      type: string;
      value: string;
    };
    expect(out.type).toBe("text");
    // Tells the model the image follows separately — no "cannot receive
    // images" claim that a vision model would (correctly) dispute.
    expect(out.value).toMatch(/attached below/i);
    expect(out.value).not.toMatch(/cannot (see|receive)/i);
    // The exact pixels were queued for the agent loop to splice.
    expect(ctx.pending).toHaveLength(1);
    expect(ctx.pending[0]).toEqual({
      data: IMG,
      mediaType: "image/jpeg",
      note: "screenshot (focus: the save dialog)",
    });
  });

  it("text-only model: OCR fallback text, nothing queued", async () => {
    const ctx = makeCtx({ supportsToolResultImages: () => false, canSeeImages: () => false });
    const out = (await runTool(ctx)) as { type: string; value: string };
    expect(out.type).toBe("text");
    expect(ctx.pending).toHaveLength(0);
  });
});
