import type { ProviderId } from "./providers";

/** 1 (lowest) – 5 (highest). For `cost`, higher = cheaper. */
export type CapabilityScore = 1 | 2 | 3 | 4 | 5;

export type ModelCapabilities = {
  intelligence: CapabilityScore;
  speed: CapabilityScore;
  cost: CapabilityScore;
};

export type ModelTag = "vision" | "reasoning" | "tools" | "coding" | "free";

/** Thinking / extended reasoning mode. Off = no thinking. Low/Med/High map to
 *  provider-specific budget tokens or effort levels. Only applies to models
 *  tagged "reasoning". */
export type ThinkingMode = "off" | "low" | "medium" | "high";

/** Token budgets per thinking mode for Anthropic (thinking.budgetTokens). */
export const THINKING_BUDGET_ANTHROPIC: Record<ThinkingMode, number> = {
  off: 0,
  low: 4000,
  medium: 16000,
  high: 32000,
};

/** Reasoning effort strings per mode for OpenAI. */
export const THINKING_EFFORT_OPENAI: Record<ThinkingMode, string> = {
  off: "",
  low: "low",
  medium: "medium",
  high: "high",
};

/** Thinking budget tokens for Google Gemini. */
export const THINKING_BUDGET_GOOGLE: Record<ThinkingMode, number> = {
  off: 0,
  low: 4096,
  medium: 8192,
  high: 16384,
};

/** Reasoning effort strings per mode for xAI (Grok). The chat endpoint only
 *  accepts "low" | "high", so "medium" maps up to "high". */
export const THINKING_EFFORT_XAI: Record<ThinkingMode, string> = {
  off: "",
  low: "low",
  medium: "high",
  high: "high",
};

/** Reasoning effort strings per mode for Groq. Groq's `reasoning_effort`
 *  enum is `none | default | low | medium | high`; we mirror the OpenAI
 *  strings so `thinkingMode` semantics stay consistent across providers. */
export const THINKING_EFFORT_GROQ: Record<ThinkingMode, string> = {
  off: "",
  low: "low",
  medium: "medium",
  high: "high",
};

export type ModelInfo = {
  id: string;
  provider: ProviderId;
  label: string;
  /** One short word for the dropdown trigger. */
  hint: string;
  /** One-line marketing-style description shown under the label. */
  description: string;
  capabilities: ModelCapabilities;
  tags?: readonly ModelTag[];
};

export const MODELS = [
  // ── OpenAI ────────────────────────────────────────────────────────────────
  {
    id: "gpt-5.6-sol",
    provider: "openai",
    label: "GPT-5.6 Sol",
    hint: "Flagship",
    description: "Newest flagship — parallel subagents, max reasoning, top-tier coding.",
    capabilities: { intelligence: 5, speed: 3, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "gpt-5.6-terra",
    provider: "openai",
    label: "GPT-5.6 Terra",
    hint: "Balanced",
    description: "GPT-5.5-class quality at half the price.",
    capabilities: { intelligence: 4, speed: 4, cost: 3 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "gpt-5.6-luna",
    provider: "openai",
    label: "GPT-5.6 Luna",
    hint: "Fastest",
    description: "Cheapest tier for high-volume, speed-sensitive work.",
    capabilities: { intelligence: 3, speed: 5, cost: 4 },
    tags: ["vision", "tools"],
  },
  {
    id: "gpt-5.5",
    provider: "openai",
    label: "GPT-5.5",
    hint: "Previous",
    description: "Previous-gen frontier reasoning and code.",
    capabilities: { intelligence: 5, speed: 3, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "gpt-5.4-mini",
    provider: "openai",
    label: "GPT-5.4 mini",
    hint: "Fast",
    description: "Snappy default at low cost.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["vision", "tools"],
  },
  {
    id: "gpt-5.4-nano",
    provider: "openai",
    label: "GPT-5.4 nano",
    hint: "Fastest",
    description: "Tiny and instant — great for quick snippets.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["tools"],
  },
  {
    id: "gpt-5.3-codex",
    provider: "openai",
    label: "GPT-5.3 Codex",
    hint: "Coding",
    description: "Tuned for code and tool use.",
    capabilities: { intelligence: 4, speed: 4, cost: 3 },
    tags: ["tools", "coding"],
  },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  {
    id: "claude-fable-5",
    provider: "anthropic",
    label: "Claude Fable 5",
    hint: "Extreme",
    description: "Anthropic's Mythos-class frontier model. State-of-the-art reasoning.",
    capabilities: { intelligence: 5, speed: 2, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "claude-opus-5",
    provider: "anthropic",
    label: "Claude Opus 5",
    hint: "Best",
    description: "Latest Opus for complex agentic coding and enterprise work.",
    capabilities: { intelligence: 5, speed: 3, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    label: "Claude Sonnet 5",
    hint: "Balanced",
    description: "Best combination of speed and intelligence. 1M context.",
    capabilities: { intelligence: 4, speed: 4, cost: 2 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "claude-opus-4-8",
    provider: "anthropic",
    label: "Claude Opus 4.8",
    hint: "Legacy",
    description: "Previous-gen Opus flagship.",
    capabilities: { intelligence: 5, speed: 2, cost: 2 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "claude-opus-4-7",
    provider: "anthropic",
    label: "Claude Opus 4.7",
    hint: "Best",
    description: "Anthropic's flagship for long reasoning.",
    capabilities: { intelligence: 5, speed: 2, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    label: "Claude Sonnet 4.6",
    hint: "Balanced",
    description: "Sweet spot of quality and speed.",
    capabilities: { intelligence: 4, speed: 4, cost: 1 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    label: "Claude Haiku 4.5",
    hint: "Fast",
    description: "Quick, cheap, multimodal.",
    capabilities: { intelligence: 3, speed: 5, cost: 4 },
    tags: ["vision", "tools"],
  },
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    label: "Claude Opus 4.6",
    hint: "Legacy",
    description: "Previous-gen Opus.",
    capabilities: { intelligence: 5, speed: 2, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },

  // ── Google ────────────────────────────────────────────────────────────────
  {
    id: "gemini-3.6-flash",
    provider: "google",
    label: "Gemini 3.6 Flash",
    hint: "Latest",
    description: "Latest Flash — speed with intelligence for agentic and multimodal tasks.",
    capabilities: { intelligence: 4, speed: 5, cost: 4 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "gemini-3.1-pro",
    provider: "google",
    label: "Gemini 3.1 Pro",
    hint: "Flagship",
    description: "Strong reasoning, 1M context.",
    capabilities: { intelligence: 5, speed: 3, cost: 2 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "gemini-3.5-flash",
    provider: "google",
    label: "Gemini 3.5 Flash",
    hint: "Fast",
    description: "Fast multimodal, 1M context.",
    capabilities: { intelligence: 4, speed: 5, cost: 4 },
    tags: ["vision", "tools"],
  },
  {
    id: "gemini-2.5-pro",
    provider: "google",
    label: "Gemini 2.5 Pro",
    hint: "Stable",
    description: "Production-stable Gemini.",
    capabilities: { intelligence: 4, speed: 3, cost: 3 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "gemini-2.5-flash",
    provider: "google",
    label: "Gemini 2.5 Flash",
    hint: "Cheap",
    description: "Bulk throughput at low cost.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["vision", "tools"],
  },

  // ── xAI ───────────────────────────────────────────────────────────────────
  {
    id: "grok-4.20-reasoning",
    provider: "xai",
    label: "Grok 4.20 Reasoning",
    hint: "Reasoning",
    description: "Frontier reasoning with extended thinking.",
    capabilities: { intelligence: 5, speed: 2, cost: 2 },
    tags: ["reasoning", "tools", "coding"],
  },
  {
    id: "grok-4.20-non-reasoning",
    provider: "xai",
    label: "Grok 4.20",
    hint: "Fast",
    description: "Fast tier for chat and tools.",
    capabilities: { intelligence: 4, speed: 4, cost: 3 },
    tags: ["tools"],
  },
  {
    id: "grok-4-fast-reasoning",
    provider: "xai",
    label: "Grok 4 Fast",
    hint: "Reasoning",
    description: "Cheaper Grok 4 with vision and reasoning.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["vision", "reasoning", "tools"],
  },

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    label: "DeepSeek V4 Pro",
    hint: "Best",
    description: "Strong open-weight code model.",
    capabilities: { intelligence: 5, speed: 3, cost: 4 },
    tags: ["reasoning", "tools", "coding"],
  },
  {
    id: "deepseek-v4-flash",
    provider: "deepseek",
    label: "DeepSeek V4 Flash",
    hint: "Fast",
    description: "Cheap and fast everyday tier.",
    capabilities: { intelligence: 4, speed: 5, cost: 5 },
    tags: ["tools"],
  },
  {
    id: "deepseek-reasoner",
    provider: "deepseek",
    label: "DeepSeek Reasoner",
    hint: "Thinking",
    description: "Chain-of-thought at open-weight prices.",
    capabilities: { intelligence: 5, speed: 2, cost: 4 },
    tags: ["reasoning", "coding"],
  },

  // ── Mistral ────────────────────────────────────────────────────────────────
  {
    id: "mistral-large-latest",
    provider: "mistral",
    label: "Mistral Large 3",
    hint: "Best",
    description: "Flagship Mistral model with 128K context.",
    capabilities: { intelligence: 5, speed: 3, cost: 3 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "mistral-medium-latest",
    provider: "mistral",
    label: "Mistral Medium 3.5",
    hint: "Balanced",
    description: "Good balance of speed and intelligence.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["vision", "tools"],
  },
  {
    id: "codestral-latest",
    provider: "mistral",
    label: "Codestral",
    hint: "Code",
    description: "Purpose-built coding model from Mistral.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["coding"],
  },

  // ── Cerebras (fast-tier) ─────────────────────────────────────────────────
  {
    id: "gpt-oss-120b",
    provider: "cerebras",
    label: "GPT-OSS 120B",
    hint: "Ultra-fast",
    description: "Fastest inference on Cerebras silicon.",
    capabilities: { intelligence: 4, speed: 5, cost: 4 },
    tags: ["tools", "coding"],
  },
  {
    id: "llama3.3-70b",
    provider: "cerebras",
    label: "Llama 3.3 70B",
    hint: "Fast",
    description: "Meta's open model on wafer-scale silicon.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["tools"],
  },
  {
    id: "qwen-3-32b",
    provider: "cerebras",
    label: "Qwen 3 32B",
    hint: "Fast",
    description: "Multilingual model at extreme speed.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["tools", "coding"],
  },

  // ── Groq (fast-tier) ─────────────────────────────────────────────────────
  {
    id: "openai/gpt-oss-20b",
    provider: "groq",
    label: "GPT-OSS 20B",
    hint: "Ultra-fast",
    description: "Sub-second responses on Groq LPU.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["tools", "coding"],
  },
  {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    label: "Llama 3.3 70B",
    hint: "Versatile",
    description: "Fast and broadly capable.",
    capabilities: { intelligence: 4, speed: 5, cost: 5 },
    tags: ["tools"],
  },
  {
    id: "deepseek-r1-distill-llama-70b",
    provider: "groq",
    label: "DeepSeek R1 Distill 70B",
    hint: "Thinking",
    description: "Reasoning-distilled Llama on Groq.",
    capabilities: { intelligence: 4, speed: 5, cost: 5 },
    tags: ["reasoning", "tools"],
  },

  // ── OpenRouter (gateway — curated cross-provider routes) ──────────────────
  {
    id: "anthropic/claude-opus-4-7",
    provider: "openrouter",
    label: "Claude Opus 4.7",
    hint: "OpenRouter",
    description: "Anthropic flagship via OpenRouter.",
    capabilities: { intelligence: 5, speed: 2, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    provider: "openrouter",
    label: "Claude Sonnet 4.6",
    hint: "OpenRouter",
    description: "Balanced Claude via OpenRouter.",
    capabilities: { intelligence: 4, speed: 4, cost: 3 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "openai/gpt-5.5",
    provider: "openrouter",
    label: "GPT-5.5",
    hint: "OpenRouter",
    description: "OpenAI flagship via OpenRouter.",
    capabilities: { intelligence: 5, speed: 3, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "openai/gpt-5.4-mini",
    provider: "openrouter",
    label: "GPT-5.4 mini",
    hint: "OpenRouter",
    description: "Snappy GPT via OpenRouter.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["vision", "tools"],
  },
  {
    id: "google/gemini-3.1-pro-preview",
    provider: "openrouter",
    label: "Gemini 3.1 Pro",
    hint: "OpenRouter",
    description: "Google flagship via OpenRouter.",
    capabilities: { intelligence: 5, speed: 3, cost: 2 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "x-ai/grok-4.20-reasoning",
    provider: "openrouter",
    label: "Grok 4.20 Reasoning",
    hint: "OpenRouter",
    description: "xAI reasoning via OpenRouter.",
    capabilities: { intelligence: 5, speed: 2, cost: 2 },
    tags: ["reasoning", "tools", "coding"],
  },
  {
    id: "deepseek/deepseek-v4-pro",
    provider: "openrouter",
    label: "DeepSeek V4 Pro",
    hint: "OpenRouter",
    description: "Open-weight coding model.",
    capabilities: { intelligence: 5, speed: 3, cost: 5 },
    tags: ["reasoning", "tools", "coding"],
  },
  {
    id: "deepseek/deepseek-reasoner",
    provider: "openrouter",
    label: "DeepSeek Reasoner",
    hint: "OpenRouter",
    description: "Cheap chain-of-thought reasoner.",
    capabilities: { intelligence: 5, speed: 2, cost: 5 },
    tags: ["reasoning", "coding"],
  },
  {
    id: "meta-llama/llama-4-scout-17b-16e-instruct",
    provider: "openrouter",
    label: "Llama 4 Scout",
    hint: "OpenRouter",
    description: "Meta's efficient multimodal model.",
    capabilities: { intelligence: 4, speed: 4, cost: 5 },
    tags: ["vision", "tools"],
  },
  {
    id: "meta-llama/llama-4-maverick",
    provider: "openrouter",
    label: "Llama 4 Maverick",
    hint: "OpenRouter",
    description: "Meta's flagship open multimodal model.",
    capabilities: { intelligence: 4, speed: 3, cost: 5 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "moonshotai/kimi-k2.5",
    provider: "openrouter",
    label: "Kimi K2.5",
    hint: "OpenRouter",
    description: "Moonshot's agentic flagship.",
    capabilities: { intelligence: 5, speed: 3, cost: 4 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "moonshotai/kimi-k3",
    provider: "openrouter",
    label: "Kimi K3",
    hint: "OpenRouter",
    description: "Moonshot's latest flagship with 1M context and enhanced reasoning.",
    capabilities: { intelligence: 5, speed: 3, cost: 3 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "qwen/qwen3.7-max",
    provider: "openrouter",
    label: "Qwen 3.7 Max",
    hint: "OpenRouter",
    description: "Alibaba's flagship multilingual reasoner.",
    capabilities: { intelligence: 5, speed: 3, cost: 4 },
    tags: ["reasoning", "tools", "coding"],
  },
  {
    id: "qwen/qwen3.7-plus",
    provider: "openrouter",
    label: "Qwen 3.7 Plus",
    hint: "OpenRouter",
    description: "High-speed balanced model from Alibaba.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["tools", "coding"],
  },
  {
    id: "qwen/qwen3.7-flash",
    provider: "openrouter",
    label: "Qwen 3.7 Flash",
    hint: "OpenRouter",
    description: "Fast, cheap Qwen tier for high-throughput tasks.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["tools"],
  },
  {
    id: "qwen/qwen3.6-27b",
    provider: "openrouter",
    label: "Qwen 3.6 27B",
    hint: "OpenRouter",
    description: "Compact Qwen for lightweight coding and chat.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["tools", "coding"],
  },
  {
    id: "mistralai/mistral-large-latest",
    provider: "openrouter",
    label: "Mistral Large",
    hint: "OpenRouter",
    description: "EU-hosted general-purpose flagship.",
    capabilities: { intelligence: 4, speed: 4, cost: 3 },
    tags: ["tools", "coding"],
  },
  {
    id: "z-ai/glm-5.2",
    provider: "openrouter",
    label: "GLM 5.2",
    hint: "OpenRouter",
    description: "Zhipu's 744B MoE flagship coding model with 1M-token context. MIT-licensed.",
    capabilities: { intelligence: 5, speed: 4, cost: 5 },
    tags: ["reasoning", "tools", "coding"],
  },

  // ── New OpenRouter additions (July 2026) ───────────────────────────────
  {
    id: "minimax/minimax-m3",
    provider: "openrouter",
    label: "MiniMax M3",
    hint: "OpenRouter",
    description: "Multimodal 1M-context model — agentic work, coding, long-horizon.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "google/gemini-3.5-flash-lite",
    provider: "openrouter",
    label: "Gemini 3.5 Flash Lite",
    hint: "OpenRouter",
    description: "Ultra-efficient subagent tier — focused tasks in multi-agent workflows.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["vision", "tools"],
  },
  {
    id: "poolside/laguna-s-2.1",
    provider: "openrouter",
    label: "Laguna S 2.1",
    hint: "OpenRouter",
    description: "Poolside's coding agent specialist — 118B MoE, 8B active.",
    capabilities: { intelligence: 4, speed: 4, cost: 5 },
    tags: ["tools", "coding"],
  },
  {
    id: "thinkingmachines/inkling",
    provider: "openrouter",
    label: "Inkling",
    hint: "OpenRouter",
    description: "Open-weight multimodal MoE — 41B active / 975B total.",
    capabilities: { intelligence: 4, speed: 3, cost: 4 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "meituan/longcat-2.0",
    provider: "openrouter",
    label: "LongCat 2.0",
    hint: "OpenRouter",
    description: "Sparse MoE for coding and long-horizon problem solving — 48B/1.6T.",
    capabilities: { intelligence: 4, speed: 3, cost: 4 },
    tags: ["tools", "coding"],
  },
  {
    id: "x-ai/grok-build-0.1",
    provider: "openrouter",
    label: "Grok Build 0.1",
    hint: "OpenRouter",
    description: "xAI's coding-specific model for agentic software engineering.",
    capabilities: { intelligence: 4, speed: 5, cost: 4 },
    tags: ["tools", "coding"],
  },

  // ── Generic OpenAI-compatible (user-defined endpoint) ─────────────────────
  {
    id: "openai-compatible-custom",
    provider: "openai-compatible",
    label: "Custom endpoint",
    hint: "Configurable",
    description: "Any OpenAI-compatible endpoint.",
    capabilities: { intelligence: 3, speed: 3, cost: 3 },
  },

  // ── LM Studio (local; model id is user-supplied at runtime) ───────────────
  {
    id: "lmstudio-local",
    provider: "lmstudio",
    label: "LM Studio",
    hint: "Local",
    description: "Local GGUF models via LM Studio.",
    capabilities: { intelligence: 3, speed: 3, cost: 5 },
  },

  // ── Z.ai (GLM) ─────────────────────────────────────────────────────────────
  {
    id: "glm-5.2",
    provider: "zai",
    label: "GLM 5.2",
    hint: "Flagship",
    description: "Latest 744B MoE flagship coding and reasoning model with 1M-token context.",
    capabilities: { intelligence: 5, speed: 4, cost: 5 },
    tags: ["reasoning", "tools", "coding"],
  },
  {
    id: "glm-5.1",
    provider: "zai",
    label: "GLM 5.1",
    hint: "Fast",
    description: "Advanced reasoning with ultra-fast inference.",
    capabilities: { intelligence: 4, speed: 5, cost: 5 },
    tags: ["reasoning", "tools", "coding"],
  },
  {
    id: "glm-4.7",
    provider: "zai",
    label: "GLM 4.7",
    hint: "Stable",
    description: "Production-stable GLM model.",
    capabilities: { intelligence: 4, speed: 4, cost: 5 },
    tags: ["tools", "coding"],
  },
] as const satisfies readonly ModelInfo[];

export type ModelId = (typeof MODELS)[number]["id"];

/** Resolver populated by the OpenRouter models store so getModel() can find
 *  models that were fetched dynamically and aren't in the hardcoded MODELS array. */
let externalModelLookup: ((id: string) => ModelInfo | undefined) | null = null;
export function registerExternalModelLookup(fn: (id: string) => ModelInfo | undefined): void {
  externalModelLookup = fn;
}

export function getModel(id: ModelId): ModelInfo {
  // Check hardcoded models first.
  const m =
    (MODELS as readonly ModelInfo[]).find((x) => x.id === id) ??
    externalModelLookup?.(id);
  if (!m) {
    // Fall back to a synthetic entry instead of crashing. A saved session
    // may reference a model that was removed from MODELS or hasn't loaded
    // yet via the OpenRouter dynamic fetch. The user can switch models.
    console.warn(`Unknown model "${id}" — using synthetic fallback.`);
    return {
      id,
      provider: "openrouter" as ProviderId,
      label: id.split("/").pop() ?? id,
      hint: "Unknown",
      description: `Model "${id}" not found in the registry. You may need to switch to a known model.`,
      capabilities: { intelligence: 3, speed: 3, cost: 3 },
    };
  }
  return m;
}

export const DEFAULT_MODEL_ID: ModelId = "gpt-5.4-mini";

/** Approximate context window (in tokens) per model. Used for the
 *  context-usage indicator in the AI mini-window header. Conservative
 *  estimates — actual provider limits may shift. */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
  "gpt-5.5": 1_050_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.4-nano": 400_000,
  "gpt-5.3-codex": 400_000,
  "claude-fable-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "claude-opus-4-6": 1_000_000,
  "gemini-3.6-flash": 1_000_000,
  "gemini-3.1-pro": 1_000_000,
  "gemini-3.5-flash": 1_000_000,
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "grok-4.20-reasoning": 2_000_000,
  "grok-4.20-non-reasoning": 2_000_000,
  "grok-4-fast-reasoning": 2_000_000,
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-reasoner": 128_000,
  "gpt-oss-120b": 128_000,
  "llama3.3-70b": 128_000,
  "qwen-3-32b": 32_000,
  "openai/gpt-oss-20b": 128_000,
  "llama-3.3-70b-versatile": 128_000,
  "deepseek-r1-distill-llama-70b": 128_000,
  "openai/gpt-5.6-sol": 1_050_000,
  "openai/gpt-5.6-terra": 1_050_000,
  "anthropic/claude-opus-5": 1_000_000,
  "anthropic/claude-sonnet-5": 1_000_000,
  "google/gemini-3.6-flash": 1_000_000,
  "anthropic/claude-opus-4-7": 1_000_000,
  "anthropic/claude-sonnet-4-6": 1_000_000,
  "openai/gpt-5.5": 1_050_000,
  "openai/gpt-5.4-mini": 400_000,
  "google/gemini-3.1-pro": 1_000_000,
  "google/gemini-3.1-pro-preview": 1_000_000,
  "x-ai/grok-4.20-reasoning": 2_000_000,
  "deepseek/deepseek-v4-pro": 1_000_000,
  "deepseek/deepseek-reasoner": 128_000,
  "meta-llama/llama-4-scout-17b-16e-instruct": 1_000_000,
  "meta-llama/llama-4-maverick": 1_000_000,
  "moonshotai/kimi-k3": 1_000_000,
  "moonshotai/kimi-k2.5": 262_144,
  "minimax/minimax-m3": 1_048_576,
  "google/gemini-3.5-flash-lite": 1_000_000,
  "poolside/laguna-s-2.1": 1_048_576,
  "thinkingmachines/inkling": 1_048_576,
  "meituan/longcat-2.0": 1_048_756,
  "x-ai/grok-build-0.1": 256_000,
  "qwen/qwen3.7-flash": 1_000_000,
  "qwen/qwen3.7-max": 1_000_000,
  "qwen/qwen3.7-plus": 1_000_000,
  "qwen/qwen3.6-27b": 262_144,
  "mistralai/mistral-large-latest": 128_000,
  "z-ai/glm-5.2": 1_000_000,
  "glm-5.2": 1_000_000,
  "glm-5.1": 205_000,
  "glm-4.7": 128_000,
  "openai-compatible-custom": 128_000,
  "lmstudio-local": 32_000,
  "mistral-large-latest": 131_072,
  "mistral-medium-latest": 32_768,
  "codestral-latest": 256_000,
};

/** Runtime overrides for custom endpoint context sizes, set by the preferences store. */
const customContextOverrides: Record<string, number> = {};

/** Called by the preferences layer to push custom context sizes into the config module. */
/** Dynamic limit registry — populated by the OpenRouter models store at fetch time. */
const dynamicContextLimits: Record<string, number> = {};

export function registerDynamicContextLimits(limits: Record<string, number>): void {
  Object.assign(dynamicContextLimits, limits);
}

export function setCustomContextLimit(modelId: string, size: number): void {
  if (size > 0) customContextOverrides[modelId] = size;
  else delete customContextOverrides[modelId];
}

export function getModelContextLimit(modelId: string | undefined): number {
  if (!modelId) return 128_000;
  const override = customContextOverrides[modelId];
  if (override && override > 0) return override;
  if (MODEL_CONTEXT_LIMITS[modelId] != null) return MODEL_CONTEXT_LIMITS[modelId];
  if (dynamicContextLimits[modelId] != null) return dynamicContextLimits[modelId];
  return 128_000;
}

export type ModelPricing = {
  input: number;
  output: number;
  cacheRead?: number;
};

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5 },
  "gpt-5.6-terra": { input: 2.5, output: 15, cacheRead: 0.25 },
  "gpt-5.6-luna": { input: 1, output: 6, cacheRead: 0.1 },
  "gpt-5.5": { input: 5, output: 15, cacheRead: 0.5 },
  "gpt-5.4-mini": { input: 0.4, output: 1.6, cacheRead: 0.04 },
  "gpt-5.4-nano": { input: 0.1, output: 0.4, cacheRead: 0.01 },
  "gpt-5.3-codex": { input: 1.5, output: 6, cacheRead: 0.15 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1.0 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-opus-4-8": { input: 15, output: 75, cacheRead: 1.5 },
  "claude-opus-4-7": { input: 15, output: 75, cacheRead: 1.5 },
  "claude-opus-4-6": { input: 15, output: 75, cacheRead: 1.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  "gemini-3.6-flash": { input: 0.3, output: 2.5, cacheRead: 0.075 },
  "gemini-3.1-pro": { input: 1.25, output: 10, cacheRead: 0.31 },
  "gemini-3.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.075 },
  "gemini-2.5-pro": { input: 1.25, output: 10, cacheRead: 0.31 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.075 },
  "grok-4.20-reasoning": { input: 3, output: 15 },
  "grok-4.20-non-reasoning": { input: 1, output: 5 },
  "grok-4-fast-reasoning": { input: 0.2, output: 0.5 },
  "deepseek-v4-pro": { input: 0.28, output: 1.1, cacheRead: 0.028 },
  "deepseek-v4-flash": { input: 0.07, output: 0.27, cacheRead: 0.007 },
  "deepseek-reasoner": { input: 0.55, output: 2.19, cacheRead: 0.14 },
  "z-ai/glm-5.2": { input: 1.0, output: 3.2, cacheRead: 0.1 },
  "z-ai/glm-5.2[1m]": { input: 1.0, output: 3.2, cacheRead: 0.1 },
  "glm-5.2": { input: 1.0, output: 3.2, cacheRead: 0.1 },
  "glm-5.2[1m]": { input: 1.0, output: 3.2, cacheRead: 0.1 },
  "glm-5.1": { input: 1.0, output: 3.2, cacheRead: 0.1 },
  "glm-4.7": { input: 0.1, output: 0.1 },
  "qwen/qwen3.7-max": { input: 2.5, output: 7.5 },
  "qwen/qwen3.7-plus": { input: 2.5, output: 7.5 },
  "qwen/qwen3.7-flash": { input: 0.03, output: 0.13, cacheRead: 0.006 },
  "moonshotai/kimi-k3": { input: 3, output: 15, cacheRead: 0.3 },
  "minimax/minimax-m3": { input: 0.3, output: 1.2, cacheRead: 0.06 },
  "google/gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cacheRead: 0.03 },
  "poolside/laguna-s-2.1": { input: 0.09, output: 0.18, cacheRead: 0.009 },
  "thinkingmachines/inkling": { input: 1.0, output: 4.05, cacheRead: 0.17 },
  "meituan/longcat-2.0": { input: 0.3, output: 1.2, cacheRead: 0.006 },
  "x-ai/grok-build-0.1": { input: 1.0, output: 2.0 },
  "qwen/qwen3.6-27b": { input: 0.4, output: 1.6 },
};

/** Dynamic pricing registry — populated by the OpenRouter models store at fetch time. */
const dynamicPricing: Record<string, ModelPricing> = {};

export function registerDynamicPricing(pricing: Record<string, ModelPricing>): void {
  Object.assign(dynamicPricing, pricing);
}

export function estimateCost(
  modelId: string | undefined,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
): number | null {
  if (!modelId) return null;
  const p = MODEL_PRICING[modelId] ?? dynamicPricing[modelId];
  if (!p) return null;
  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cached = usage.cachedInputTokens;
  return (
    (fresh * p.input + cached * (p.cacheRead ?? p.input) + usage.outputTokens * p.output) /
    1_000_000
  );
}
