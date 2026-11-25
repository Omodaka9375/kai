import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getModelPricing, MODELS } from "./models";

/**
 * Pricing coverage gate (added 2026-11-15 after a dropdown/pricing review).
 *
 * `estimateCost` returns null when it has no price, and the UI then drops the
 * "Session cost" row silently — a missing entry is invisible, so the table
 * rotted until 22 of 69 registry models could not be priced. This test makes
 * any NEW unpriced model a build failure and shrinks the allowlist below as
 * entries land.
 */

/** Placeholder entry for user-run OpenAI-compatible endpoints (LM Studio,
 *  Ollama, vLLM). The real model is whatever the user points at, so a price
 *  can never be known here. Permanently exempt. Same for the proxy endpoint
 *  (MemoChain memory proxy): the backend model behind the proxy is
 *  user-chosen, the proxy may meter differently, so no static price. */
const UNPRICED_PLACEHOLDERS: readonly string[] = [
  "openai-compatible-custom",
  "proxy-custom",
];

/** Real models still missing a MODEL_PRICING entry. Every entry here is a
 *  known gap. This list must only ever get SHORTER — see the second test. */
const UNPRICED_TODO: readonly string[] = [
  // Direct Mistral API. Priced models are Large 4 / Medium 3.5 / Codestral,
  // but mistral.ai's pricing page is JS-rendered and the docs pricing route
  // moved — no scrapeable per-million numbers yet (2026-11-15).
  "mistral-large-latest",
  "mistral-medium-latest",
  "codestral-latest",
  // Cerebras dropped Llama 3.3 70B and Qwen 3 32B from its published dev
  // price sheet (now GPT OSS 120B + Qwen 3.8 27B). Registry refresh is the
  // real fix (G); pricing a possibly-retired id would invent data.
  "llama3.3-70b",
  "qwen-3-32b",
  // Groq: console.groq.com/pricing and the docs pricing page both 404
  // (2026-11-15); the price sheet moved behind the new console.
  "llama-3.3-70b-versatile",
  "deepseek-r1-distill-llama-70b",
  // Seed rows for models that ARE in the live OpenRouter catalog: at
  // runtime the catalog fetch registers their price in dynamicPricing, so
  // the static table deliberately omits them (one source of truth).
  "openai/gpt-oss-20b",
  "openai/gpt-5.5",
  "openai/gpt-5.4-mini",
  "google/gemini-3.1-pro-preview",
  "deepseek/deepseek-v4-pro",
  "meta-llama/llama-4-maverick",
  "moonshotai/kimi-k2.5",
];

const exempt = new Set<string>([...UNPRICED_PLACEHOLDERS, ...UNPRICED_TODO]);

describe("MODEL_PRICING coverage", () => {
  it("every registry model is either priced or explicitly exempted", () => {
    const unpriced = MODELS.filter(
      (m) => !exempt.has(m.id) && getModelPricing(m.id) === null,
    ).map((m) => m.id);
    expect(unpriced).toEqual([]);
  });

  it("the unpriced allowlist contains only ids that are still in the registry", () => {
    // A model removed from MODELS must be dropped from the allowlist too, so
    // the list cannot quietly accrete stale entries and hide real gaps.
    const live: Set<string> = new Set(MODELS.map((m) => m.id));
    const stale = UNPRICED_TODO.filter((id) => !live.has(id));
    expect(stale).toEqual([]);
  });

  it("prices are finite and non-negative with output >= input", () => {
    // output < input flags a transposed table row, the likeliest typo.
    const bad: string[] = [];
    for (const m of MODELS) {
      const p = getModelPricing(m.id);
      if (!p) continue;
      if (!Number.isFinite(p.input) || p.input < 0) bad.push(`${m.id} input`);
      if (!Number.isFinite(p.output) || p.output < 0) bad.push(`${m.id} output`);
      if (p.cacheRead !== undefined && (!Number.isFinite(p.cacheRead) || p.cacheRead < 0)) {
        bad.push(`${m.id} cacheRead`);
      }
      if (p.output < p.input) bad.push(`${m.id} output<input`);
    }
    expect(bad).toEqual([]);
  });
});

describe("cost display uses KAI pricing, not the bundled tokenlens catalog", () => {
  const src = readFileSync(
    new URL("../../../components/ai-elements/context.tsx", import.meta.url),
    "utf8",
  );

  it("context.tsx no longer imports tokenlens", () => {
    // tokenlens priced 12 of 69 models and returned an empty cost object for
    // the rest, which the old code formatted as a confident "$0.00".
    expect(src).not.toMatch(/from\s+"tokenlens"/);
    expect(src).not.toMatch(/\bgetUsage\s*\(/);
  });

  it("context.tsx resolves prices through the KAI registry", () => {
    expect(src).toContain("getModelPricing");
    expect(src).toContain("estimateCost");
  });
});
