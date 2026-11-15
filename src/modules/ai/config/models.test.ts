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
 *  can never be known here. Permanently exempt. */
const UNPRICED_PLACEHOLDERS: readonly string[] = ["openai-compatible-custom"];

/** Real models still missing a MODEL_PRICING entry. Every entry here is a
 *  known bug. This list must only ever get SHORTER — see the second test. */
const UNPRICED_TODO: readonly string[] = [
  // Direct Mistral API
  "mistral-large-latest",
  "mistral-medium-latest",
  "codestral-latest",
  // Cerebras
  "gpt-oss-120b",
  "llama3.3-70b",
  "qwen-3-32b",
  // Groq
  "openai/gpt-oss-20b",
  "llama-3.3-70b-versatile",
  "deepseek-r1-distill-llama-70b",
  // OpenRouter hardcoded picks (priced under their bare id, not this form)
  "anthropic/claude-opus-4-7",
  "anthropic/claude-sonnet-4-6",
  "openai/gpt-5.5",
  "openai/gpt-5.4-mini",
  "google/gemini-3.1-pro-preview",
  "x-ai/grok-4.20-reasoning",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-reasoner",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick",
  "moonshotai/kimi-k2.5",
  "mistralai/mistral-large-latest",
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
