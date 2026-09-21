import type { ModelInfo, ModelPricing, ModelTag } from "../config";

/** Shape persisted to disk (`Kai-openrouter-models.json`) so every app
 *  instance starts from the last good OpenRouter catalog — a failed startup
 *  fetch no longer drops dynamic models for that session. */
export type PersistedCatalog = {
  /** Unix ms of the successful fetch that produced this catalog. */
  fetchedAt: number;
  models: ModelInfo[];
  contextLimits: Record<string, number>;
  pricing: Record<string, ModelPricing>;
};

const MODEL_TAGS: readonly ModelTag[] = ["vision", "reasoning", "tools", "coding", "free"];

function isScore(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 5;
}

function reviveNumberRecord(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === "string" && k.length > 0 && typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[k] = v;
    }
  }
  return out;
}

function revivePricing(raw: unknown): Record<string, ModelPricing> {
  const out: Record<string, ModelPricing> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length === 0 || typeof v !== "object" || v === null) continue;
    const p = v as Partial<ModelPricing>;
    if (typeof p.input !== "number" || !Number.isFinite(p.input) || p.input < 0) continue;
    if (typeof p.output !== "number" || !Number.isFinite(p.output) || p.output < 0) continue;
    const entry: ModelPricing = { input: p.input, output: p.output };
    if (typeof p.cacheRead === "number" && Number.isFinite(p.cacheRead) && p.cacheRead >= 0) {
      entry.cacheRead = p.cacheRead;
    }
    out[k] = entry;
  }
  return out;
}

/** Validate untrusted data read from disk into a PersistedCatalog. Returns
 *  null when the payload is absent or malformed — never trusts the file.
 *  Invalid individual entries are dropped; valid ones are kept. */
export function reviveCatalog(raw: unknown): PersistedCatalog | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Partial<PersistedCatalog>;
  if (typeof r.fetchedAt !== "number" || !Number.isFinite(r.fetchedAt) || r.fetchedAt <= 0) return null;
  if (!Array.isArray(r.models)) return null;

  const models: ModelInfo[] = [];
  for (const m of r.models) {
    if (typeof m !== "object" || m === null) continue;
    const rec = m as Partial<ModelInfo>;
    if (typeof rec.id !== "string" || rec.id.length === 0) continue;
    if (rec.provider !== "openrouter") continue;
    if (typeof rec.label !== "string" || rec.label.length === 0) continue;
    if (typeof rec.hint !== "string" || rec.hint.length === 0) continue;
    if (typeof rec.description !== "string") continue;
    const caps = rec.capabilities as ModelInfo["capabilities"] | undefined;
    if (
      caps === null || typeof caps !== "object" ||
      !isScore(caps.intelligence) || !isScore(caps.speed) || !isScore(caps.cost)
    ) {
      continue;
    }
    const tags = Array.isArray(rec.tags)
      ? rec.tags.filter((t): t is (typeof MODEL_TAGS)[number] =>
          typeof t === "string" && (MODEL_TAGS as readonly string[]).includes(t),
        )
      : undefined;
    const model: ModelInfo = {
      id: rec.id,
      provider: "openrouter",
      label: rec.label,
      hint: rec.hint,
      description: rec.description,
      capabilities: {
        intelligence: caps.intelligence,
        speed: caps.speed,
        cost: caps.cost,
      },
      ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
    };
    models.push(model);
  }
  if (models.length === 0) return null;

  return {
    fetchedAt: r.fetchedAt,
    models,
    contextLimits: reviveNumberRecord(r.contextLimits),
    pricing: revivePricing(r.pricing),
  };
}