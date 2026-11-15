import { describe, expect, it } from "vitest";
import { parseOpenRouterModels } from "./openrouterModelsStore";

/** Pricing, not marketing prose, is authoritative for the affordability bar. */
describe("OpenRouter capability derivation", () => {
  it("marks genuinely free models maximally affordable even with frontier prose", () => {
    const parsed = parseOpenRouterModels(JSON.stringify({
      data: [{
        id: "vendor/frontier-free:free",
        name: "Frontier Free",
        description: "A frontier flagship model for everyone.",
        context_length: 128_000,
        pricing: { prompt: "0", completion: "0" },
      }],
    }));
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0]!.capabilities.cost).toBe(5);
    expect(parsed.models[0]!.tags).toContain("free");
  });

  it("does not infer free pricing for an ordinary model", () => {
    const parsed = parseOpenRouterModels(JSON.stringify({
      data: [{
        id: "vendor/paid",
        name: "Paid",
        description: "A normal model.",
        context_length: 32_000,
        pricing: { prompt: "0.001", completion: "0.002" },
      }],
    }));
    expect(parsed.models[0]!.capabilities.cost).toBe(4);
  });
});

describe("OpenRouter catalog ingest (2026-11-15 pricing review)", () => {
  it("keeps moderated models — is_moderated is content filtering, not access", () => {
    // The old filter dropped every is_moderated endpoint with a comment
    // claiming they were "not accessible". That hid current flagships: the
    // Claude Fable and Meta Muse lines both ship is_moderated: true.
    const parsed = parseOpenRouterModels(JSON.stringify({
      data: [{
        id: "vendor/flagship",
        name: "Flagship",
        description: "A frontier model.",
        context_length: 1_000_000,
        pricing: { prompt: "0.000008", completion: "0.00004" },
        top_provider: { is_moderated: true },
      }],
    }));
    expect(parsed.models.map((m) => m.id)).toEqual(["vendor/flagship"]);
  });

  it("captures cache-read pricing so cache hits do not bill at full input rate", () => {
    const parsed = parseOpenRouterModels(JSON.stringify({
      data: [{
        id: "vendor/with-cache",
        name: "With Cache",
        description: "Model.",
        context_length: 200_000,
        // per-token: $8 in / $40 out / $0.80 cache read per 1M
        pricing: {
          prompt: "0.000008",
          completion: "0.00004",
          input_cache_read: "0.0000008",
        },
      }],
    }));
    expect(parsed.pricing["vendor/with-cache"]).toEqual({
      input: 8,
      output: 40,
      cacheRead: 0.8,
    });
  });

  it("omits cacheRead when the endpoint reports none (falls back to input rate)", () => {
    const parsed = parseOpenRouterModels(JSON.stringify({
      data: [{
        id: "vendor/no-cache",
        name: "No Cache",
        description: "Model.",
        context_length: 200_000,
        pricing: { prompt: "0.000001", completion: "0.000005" },
      }],
    }));
    expect(parsed.pricing["vendor/no-cache"]).toEqual({ input: 1, output: 5 });
    expect(parsed.pricing["vendor/no-cache"]!.cacheRead).toBeUndefined();
  });

  it("registers a free variant at $0 instead of dropping it", () => {
    // A missing entry made estimateCost return null and the "Session cost"
    // row disappear on a model that genuinely costs nothing.
    const parsed = parseOpenRouterModels(JSON.stringify({
      data: [{
        id: "vendor/model:free",
        name: "Model Free",
        description: "Free tier.",
        context_length: 128_000,
        pricing: { prompt: "0", completion: "0" },
      }],
    }));
    expect(parsed.pricing["vendor/model:free"]).toEqual({ input: 0, output: 0 });
  });
});
