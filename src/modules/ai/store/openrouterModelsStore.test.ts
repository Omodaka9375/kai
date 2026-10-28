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
