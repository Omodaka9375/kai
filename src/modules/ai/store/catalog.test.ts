import { describe, expect, it } from "vitest";
import { reviveCatalog, type PersistedCatalog } from "./catalog";
import type { ModelPricing } from "../config";

const CAPS = { intelligence: 3, speed: 3, cost: 3 } as const;

function validModel(overrides: Partial<PersistedCatalog["models"][number]> = {}): PersistedCatalog["models"][number] {
  return {
    id: "vendor/model",
    provider: "openrouter",
    label: "Model",
    hint: "OpenRouter",
    description: "A test model.",
    capabilities: { ...CAPS },
    ...overrides,
  };
}

function validCatalog(overrides: Partial<PersistedCatalog> = {}): PersistedCatalog {
  return {
    fetchedAt: 1_700_000_000_000,
    models: [validModel()],
    contextLimits: { "vendor/model": 128_000 },
    pricing: { "vendor/model": { input: 1, output: 2, cacheRead: 0.1 } },
    ...overrides,
  };
}

describe("reviveCatalog", () => {
  it("accepts a well-formed catalog and keeps optional tags", () => {
    const c = validCatalog({
      models: [validModel({ tags: ["vision", "tools"] }), validModel({ id: "v/m2", label: "M2" })],
    });
    const out = reviveCatalog(c);
    expect(out).not.toBeNull();
    expect(out!.fetchedAt).toBe(1_700_000_000_000);
    expect(out!.models).toHaveLength(2);
    expect(out!.models[0]!.tags).toEqual(["vision", "tools"]);
    expect(out!.contextLimits["vendor/model"]).toBe(128_000);
    expect(out!.pricing["vendor/model"]!.input).toBe(1);
  });

  it("drops invalid models but keeps valid siblings", () => {
    const out = reviveCatalog({
      fetchedAt: 1,
      models: [
        validModel(),
        null,
        { id: "x", provider: "openrouter" }, // missing fields
        { ...validModel({ id: "bad/provider-tag" }), tags: ["vision", "nonsense-tag"] },
        { ...validModel({ id: "bad/caps" }), capabilities: { intelligence: 9, speed: 3, cost: 3 } },
        { ...validModel(), provider: "zai" },
      ],
      contextLimits: {},
      pricing: {},
    });
    expect(out).not.toBeNull();
    expect(out!.models).toHaveLength(2); // validModel + the tag-filtered one
    expect(out!.models[0]!.id).toBe("vendor/model");
    expect(out!.models[1]!.tags).toEqual(["vision"]); // unknown tags dropped, valid kept
  });

  it("rejects malformed payloads outright", () => {
    expect(reviveCatalog(null)).toBeNull();
    expect(reviveCatalog("junk")).toBeNull();
    expect(reviveCatalog({})).toBeNull();
    expect(reviveCatalog({ fetchedAt: 5, models: [] })).toBeNull(); // empty models
    expect(reviveCatalog({ fetchedAt: -1, models: [validModel()] })).toBeNull();
    expect(reviveCatalog({ fetchedAt: 5, models: [validModel()], contextLimits: "x" })).not.toBeNull();
  });

  it("sanitizes pricing: drops non-finite or negative values", () => {
    const out = reviveCatalog(
      validCatalog({
        pricing: {
          "good/model": { input: 0.5, output: 1.5, cacheRead: 0.01 },
          "neg/model": { input: -1, output: 1 },
          "nan/model": { input: Number.NaN, output: 1 },
          "incomplete/model": { input: 1, output: Number.NaN }, // invalid output → dropped
          "bad/model": 42 as unknown as ModelPricing,
        },
        contextLimits: {
          "ok/model": 4096,
          "zero/model": 0, // dropped: not > 0
          "bad/model": -5,
        },
      }),
    );
    expect(out).not.toBeNull();
    expect(Object.keys(out!.pricing).sort()).toEqual(["good/model"]);
    expect(Object.keys(out!.contextLimits).sort()).toEqual(["ok/model"]);
  });

  it("drops empty tag arrays instead of persisting them", () => {
    const out = reviveCatalog(validCatalog({ models: [validModel({ tags: [] })] }));
    expect(out).not.toBeNull();
    expect(out!.models[0]!.tags).toBeUndefined();
  });
});