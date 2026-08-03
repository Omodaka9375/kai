import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { ModelInfo, ModelTag } from "../config";
import { MODELS, registerDynamicContextLimits, registerExternalModelLookup } from "../config";

// ── Types ───────────────────────────────────────────────────────────────────

type OpenRouterModelRaw = {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: { modality?: string; instruct_type?: string; tokenizer?: string };
  pricing?: { prompt?: string; completion?: string };
  top_provider?: { is_moderated?: boolean };
};

type OpenRouterResponse = {
  data?: OpenRouterModelRaw[];
};

// ── Store ───────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type State = {
  /** Merged ModelInfo list — hardcoded MODELS + fetched OpenRouter models, deduped. */
  models: ModelInfo[];
  lastFetched: number | null;
  loading: boolean;
  error: string | null;

  fetch: () => Promise<void>;
  /** Force a re-fetch regardless of cache age. */
  refresh: () => Promise<void>;
};

export const useOpenRouterModelsStore = create<State>((set, get) => ({
  models: MODELS as unknown as ModelInfo[],
  lastFetched: null,
  loading: false,
  error: null,

  fetch: async () => {
    const { lastFetched, loading } = get();
    // Don't double-fetch.
    if (loading) return;
    // Use cache if fresh.
    if (lastFetched && Date.now() - lastFetched < CACHE_TTL_MS) return;

    return get().refresh();
  },

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const raw = await invoke<string>("openrouter_list_models");
      const { models: parsed, contextLimits } = parseOpenRouterModels(raw);
      const merged = mergeModels(parsed);
      // Register a lookup so getModel() can resolve dynamically-fetched models.
      registerExternalModelLookup((id) => merged.find((m) => m.id === id));
      // Register context limits from fetched data so dynamic models
      // don't fall back to the 128K default.
      registerDynamicContextLimits(contextLimits);
      set({ models: merged, lastFetched: Date.now(), loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
      // Keep the previous model list on error — never degrade.
    }
  },
}));

// ── Parser ──────────────────────────────────────────────────────────────────

/** Tags we derive from the modality field. */
function tagsFromModality(modality: string | undefined): ModelTag[] {
  if (!modality) return [];
  const tags: ModelTag[] = [];
  const m = modality.toLowerCase();
  if (m.includes("image") || m.includes("text+image")) tags.push("vision");
  return tags;
}

/** Tags we derive from model id / name / description heuristics. */
function tagsFromHeuristics(id: string, name: string, desc: string): ModelTag[] {
  const tags: ModelTag[] = [];
  const haystack = `${id} ${name} ${desc}`.toLowerCase();

  if (
    /\b(reasoning|reasoner|thinking|chain.of.thought)\b/.test(haystack) ||
    /\b(reasoning)\b/.test(id)
  ) {
    tags.push("reasoning");
  }

  if (
    /\b(code|coder|coding|codex|programming|software)\b/.test(haystack) ||
    /(\bcoding\b)/.test(desc)
  ) {
    tags.push("coding");
  }

  // "tools" tag: models that claim function calling, tool use, or agentic work.
  if (
    /\b(function.calling|tool.use|agent|agentic)\b/.test(haystack) ||
    // Most non-legacy models support tools — tag unless explicitly not.
    (!/\b(embed|rerank|moderation|legacy|deprecated)\b/.test(haystack))
  ) {
    tags.push("tools");
  }

  return tags;
}

/** Extract a short label from the model's OpenRouter id and name. */
function deriveLabel(id: string, name: string | undefined): string {
  if (name) {
    // "OpenAI: GPT-4o" → "GPT-4o"
    const colon = name.indexOf(":");
    if (colon !== -1) return name.slice(colon + 1).trim();
    // "google/gemini-2.5-pro" → "Gemini 2.5 Pro" (if name looks like id)
    return name.trim();
  }
  // Fallback: beautify the id segment after the slash.
  const slash = id.lastIndexOf("/");
  const slug = slash !== -1 ? id.slice(slash + 1) : id;
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Quick capability score from context length relative to peers. */
function deriveCapabilities(
  ctx: number | undefined,
  desc: string,
): { intelligence: 1 | 2 | 3 | 4 | 5; speed: 1 | 2 | 3 | 4 | 5; cost: 1 | 2 | 3 | 4 | 5 } {
  const d = desc.toLowerCase();
  // Intelligence: flag "frontier", "flagship", "state-of-the-art" → 5
  let intelligence: 1 | 2 | 3 | 4 | 5 = 3;
  if (/\b(frontier|flagship|state.of.the.art|best.in.class|leading)\b/.test(d)) intelligence = 5;
  else if (/\b(advanced|high.performance|powerful|premium)\b/.test(d)) intelligence = 4;
  else if (/\b(fast|efficient|lite|lightweight|tiny|small|nano|mini)\b/.test(d)) intelligence = 2;

  // Speed: small models are fast
  let speed: 1 | 2 | 3 | 4 | 5 = 3;
  if (ctx && ctx >= 1_000_000) speed = 2;
  else if (ctx && ctx >= 500_000) speed = 3;
  else speed = 4;
  if (/\b(fast|quick|instant|real.time|low.latency|turbo|flash)\b/.test(d)) speed = 5;
  if (/\b(reasoning|think|chain.of.thought)\b/.test(d)) speed = Math.max(1, speed - 1) as 1|2|3|4|5;

  // Cost: OpenRouter models are generally cheap
  let cost: 1 | 2 | 3 | 4 | 5 = 4;
  if (/\b(free|cheap|low.cost|affordable)\b/.test(d)) cost = 5;
  if (/\b(frontier|flagship|premium|enterprise)\b/.test(d)) cost = 3;

  return { intelligence, speed, cost };
}

/** Skip ancient/legacy model IDs that are no longer relevant for chat.
 *  The `shouldSkip` function handles the general case (embeddings, TTS, etc.). */
const SKIP_PREFIXES = [
  "openai/whisper",
  "openai/tts",
  "openai/dall-e",
  "openai/text-embedding",
  "openai/text-moderation",
  "google/palm",
  "google/embedding",
  "google/text-embedding",
  "google/aqa",
  "google/code-gecko",
  "anthropic/claude-1",
  "anthropic/claude-2",
  "anthropic/claude-instant",
  "meta-llama/llama-2",
  "meta-llama/codellama",
  "mistralai/mistral-7b",
  "mistralai/mistral-tiny",
  "mistralai/mixtral-8x7b",
  "mistralai/mixtral-8x22b",
  "qwen/qvq",
  "qwen/qwq",
];

function shouldSkip(id: string): boolean {
  const lower = id.toLowerCase();
  // Skip embeddings, moderation, TTS, STT, and other non-chat models.
  if (
    lower.includes("embedding") ||
    lower.includes("moderation") ||
    lower.includes("whisper") ||
    lower.includes("tts") ||
    lower.includes("dall-e") ||
    lower.includes("rerank") ||
    lower.includes("guard") ||
    lower.includes("safety") ||
    lower.includes("classifier")
  ) {
    return true;
  }
  for (const prefix of SKIP_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  // Skip models explicitly marked as moderated in OpenRouter.
  return false;
}

function parseOpenRouterModels(rawJson: string): { models: ModelInfo[]; contextLimits: Record<string, number> } {
  let data: OpenRouterModelRaw[];
  try {
    const parsed: OpenRouterResponse = JSON.parse(rawJson);
    data = parsed.data ?? [];
  } catch {
    return { models: [], contextLimits: {} };
  }

  const out: ModelInfo[] = [];
  const contextLimits: Record<string, number> = {};
  for (const m of data) {
    if (!m.id) continue;
    if (shouldSkip(m.id)) continue;
    // Skip models marked as moderated by OpenRouter (usually means not accessible).
    if (m.top_provider?.is_moderated) continue;

    const label = deriveLabel(m.id, m.name);
    const isFree =
      (m.pricing?.prompt === "0" && m.pricing?.completion === "0") ||
      m.id.endsWith(":free");
    const modalityTags = tagsFromModality(m.architecture?.modality);
    const heuristicTags = tagsFromHeuristics(m.id, m.name ?? "", m.description ?? "");
    const freeTag: ModelTag[] = isFree ? ["free"] : [];
    // Deduplicate tags.
    const tags = [...new Set([...modalityTags, ...heuristicTags, ...freeTag])];
    const capabilities = deriveCapabilities(m.context_length, m.description ?? "");

    out.push({
      id: m.id,
      provider: "openrouter" as const,
      label,
      hint: "OpenRouter",
      description: m.description ?? "",
      capabilities,
      tags: tags.length > 0 ? tags : undefined,
    });

    // Collect context limits from the API response so dynamic models
    // don't fall back to the 128K default.
    if (m.context_length && m.context_length > 0) {
      contextLimits[m.id] = m.context_length;
    }
  }

  // Sort: high-intelligence first, then alphabetically.
  out.sort((a, b) => {
    if (a.capabilities.intelligence !== b.capabilities.intelligence) {
      return b.capabilities.intelligence - a.capabilities.intelligence;
    }
    return a.label.localeCompare(b.label);
  });

  return { models: out, contextLimits };
}

// ── Merge ───────────────────────────────────────────────────────────────────

/** Merge hardcoded MODELS with fetched OpenRouter models, deduping by id. */
function mergeModels(fetched: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  const merged: ModelInfo[] = [];

  // Hardcoded models first (they have curated descriptions/capabilities).
  for (const m of MODELS) {
    seen.add(m.id);
    merged.push(m as unknown as ModelInfo);
  }

  // Fetched models that aren't already hardcoded.
  for (const m of fetched) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      merged.push(m);
    }
  }

  return merged;
}