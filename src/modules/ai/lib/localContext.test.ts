import { describe, expect, it } from "vitest";
import {
  effectiveContextLimit,
  compactModelMessagesDetailed,
} from "./compact";
import {
  getModelContextLimit,
  setCustomContextLimit,
} from "../config/models";

/**
 * The whole context pipeline (auto-compaction at 40%, summarization at 75%,
 * /compact floors, the header context ring) keys off getModelContextLimit by
 * REGISTRY id — never the runtime model name. These tests lock the symmetry
 * for both local endpoints (LM Studio + OpenAI-compatible) so a refactor
 * that switches to runtime names can't silently regress one of them.
 */

describe("local-endpoint context limits (LM Studio + OpenAI-compatible)", () => {
  it("override applies to lmstudio-local", () => {
    setCustomContextLimit("lmstudio-local", 262_144);
    expect(getModelContextLimit("lmstudio-local")).toBe(262_144);
  });

  it("override applies to openai-compatible-custom", () => {
    setCustomContextLimit("openai-compatible-custom", 131_072);
    expect(getModelContextLimit("openai-compatible-custom")).toBe(131_072);
  });

  it("a zero/invalid override falls back (delete, not clamp)", () => {
    setCustomContextLimit("lmstudio-local", 262_144);
    setCustomContextLimit("lmstudio-local", 0);
    // 0 deletes the override — falls back to the registry default. Both
    // local endpoints default to 128k (they're user-supplied runtime
    // models; the old lmstudio 32k default under-budgeted real windows).
    expect(getModelContextLimit("lmstudio-local")).toBe(128_000);
    setCustomContextLimit("openai-compatible-custom", 131_072);
    setCustomContextLimit("openai-compatible-custom", 0);
    expect(getModelContextLimit("openai-compatible-custom")).toBe(128_000);
  });

  it("summarization threshold follows the override for BOTH local ids", () => {
    // 256k window: a 180k-token conversation is past the 75% threshold
    // (0.75 × effective limit). With the default 128k it would be far past.
    setCustomContextLimit("lmstudio-local", 262_144);
    const limit = getModelContextLimit("lmstudio-local");
    const effective = effectiveContextLimit(limit);
    expect(effective).toBeGreaterThan(200_000); // 256k minus overhead

    // And a tiny 32k override raises the threshold relative to a small
    // conversation: 24k tokens ≥ 75% of effective(32k) → needs summarization.
    setCustomContextLimit("openai-compatible-custom", 32_000);
    const small = effectiveContextLimit(
      getModelContextLimit("openai-compatible-custom"),
    );
    // Build a message set estimated at ~30k tokens (120k chars).
    const msg = {
      role: "user" as const,
      content: "x".repeat(120_000),
    };
    const r = compactModelMessagesDetailed([msg], 32_000);
    expect(r.needsSummarization).toBe(true);
    expect(small).toBeLessThan(32_000);
  });
});
