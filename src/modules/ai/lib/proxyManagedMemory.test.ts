import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MEMOCHAIN-MANAGED MEMORY gate (embedded handler, 2026-11-26).
 *
 * When a model id is toggled in Settings → Models → Durable memory
 * (MemoChain), the EMBEDDED memory handler owns context: it caps the prompt
 * at a hot window + compact memory and verifies state with a SHA-256
 * receipt chain (bundled student weights, 22,606-byte capsule, in-process
 * Rust module). KAI's local context machinery must stand down in that mode
 * — any local rewrite of the history (summarization, compaction elision,
 * /compact) diverges the model-visible prompt from the state the capsule
 * is verifying.
 *
 * These pins lock every gate that disables local context handling:
 *   1. agent.ts pre-run elision skips compactModelMessagesDetailed,
 *   2. agent.ts prepareStep mid-run re-elision skips it too,
 *   3. transport.ts maybeSummarize returns the messages untouched,
 *   4. chatStore.ts /compact refuses (both active-session and
 *      by-id paths) with an explanatory message,
 *   5. both context-ring footers (AiMiniWindow, ProjectChatGrid) say
 *      the handler owns context memory.
 */

const root = join(dirname(fileURLToPathSafe()), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function fileURLToPathSafe(): string {
  // Tiny wrapper so this file stays importable without node:url ceremony.
  return new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

/** setMemoChainModels pushes the toggle list; isProxyManagedModel reads it.
 *  Module state persists across static imports, so reset+re-import per test. */
async function importConfig(toggled: string[]) {
  vi.resetModules();
  const cfg = await import("../config");
  cfg.setMemoChainModels(toggled);
  return cfg;
}

describe("isProxyManagedModel (per-model MemoChain toggle)", () => {
  it("true only for toggled model ids, false for unknown/null/empty", async () => {
    const cfg = await importConfig(["gpt-5.4-mini", "claude-sonnet-5"]);
    expect(cfg.isProxyManagedModel("gpt-5.4-mini")).toBe(true);
    expect(cfg.isProxyManagedModel("claude-sonnet-5")).toBe(true);
    expect(cfg.isProxyManagedModel("gpt-5.5")).toBe(false);
    expect(cfg.isProxyManagedModel("proxy-custom")).toBe(false);
    expect(cfg.isProxyManagedModel("openai-compatible-custom")).toBe(false);
    expect(cfg.isProxyManagedModel(null)).toBe(false);
    expect(cfg.isProxyManagedModel(undefined)).toBe(false);
    expect(cfg.isProxyManagedModel("")).toBe(false);
  });

  it("toggling list replaces the previous set (no accumulation)", async () => {
    const cfg = await importConfig(["gpt-5.4-mini"]);
    expect(cfg.isProxyManagedModel("gpt-5.4-mini")).toBe(true);
    cfg.setMemoChainModels(["glm-5.3"]);
    expect(cfg.isProxyManagedModel("gpt-5.4-mini")).toBe(false);
    expect(cfg.isProxyManagedModel("glm-5.3")).toBe(true);
  });

  it("whitespace-only entries are dropped, ids are trimmed", async () => {
    const cfg = await importConfig(["  gpt-5.4-mini  ", "   "]);
    expect(cfg.isProxyManagedModel("gpt-5.4-mini")).toBe(true);
    expect(cfg.isProxyManagedModel("   ")).toBe(false);
  });

  it("preferences.ts pushes the persisted list on hydrate and on change", () => {
    const src = read("modules/settings/preferences.ts");
    expect(src).toContain("syncMemoChainModels(prefs)");
    expect(src).toContain('key === "memoChainModelIds"');
  });
});

describe("memoChain sessions disable local context handling (source pins)", () => {
  beforeEach(() => { void root; });

  it("agent.ts gates both elision sites and folds via the handler", () => {
    const src = read("modules/ai/lib/agent.ts");
    expect(src).toContain("isProxyManagedModel(modelId)");
    // Pre-run elision folds through the handler instead.
    const preRun = src.split("MEMOCHAIN-MANAGED MEMORY (2026-11-26)")[1]?.split("// PLAN MODE")[0] ?? "";
    expect(preRun).toContain("memoChainFoldPrefix");
    expect(preRun).toContain("const memoChain = isProxyManagedModel(modelId)");
    // prepareStep re-elision carries the same gate + mid-run fold.
    const prepareStep = src.split("MEMOCHAIN-MANAGED MEMORY: same gate")[1]?.split("// USER-MESSAGE IMAGE HANDOFF")[0] ?? "";
    expect(prepareStep).toContain("memoChain");
    // The memory block rides the system prompt.
    expect(src).toContain("memoChainMemoryBlock");
  });

  it("transport.ts maybeSummarize stands down for memoChain sessions", () => {
    const src = read("modules/ai/lib/transport.ts");
    const maybe = src.split("async function maybeSummarize")[1]?.split("/**")[0] ?? "";
    expect(maybe).toContain("if (isProxyManagedModel(modelId)) return messages;");
  });

  it("chatStore.ts /compact refuses memoChain sessions (both paths)", () => {
    const src = read("modules/ai/store/chatStore.ts");
    const refusals = src.match(/durable memory \(MemoChain\)/g)?.length ?? 0;
    expect(refusals).toBeGreaterThanOrEqual(2);
    const active = src.split("compactActiveSession: () => {")[1]?.split("compactSessionById:")[0] ?? "";
    const byId = src.split("compactSessionById: (sessionId: string) => {")[1]?.split("\n  },")[0] ?? "";
    for (const block of [active, byId]) {
      expect(block).toContain("isProxyManagedModel(");
      expect(block).toContain("projectIdForSession(");
    }
  });

  it("both context-ring footers explain memoChain sessions", () => {
    for (const p of [
      "modules/ai/components/AiMiniWindow.tsx",
      "modules/ai/components/ProjectChatGrid.tsx",
    ]) {
      const src = read(p);
      expect(src).toContain("Durable-memory session (MemoChain)");
      expect(src).toContain("isProxyManagedModel");
    }
  });

  it("the proxy endpoint slot is fully removed", () => {
    // No provider, no model entry, no build path.
    const providers = read("modules/ai/config/providers.ts");
    expect(providers).not.toContain('"proxy"');
    const models = read("modules/ai/config/models.ts");
    expect(models).not.toContain("proxy-custom");
    const agent = read("modules/ai/lib/agent.ts");
    expect(agent).not.toContain('case "proxy"');
    const store = read("modules/settings/store.ts");
    expect(store).not.toContain("proxyBaseURL");
    expect(store).not.toContain("proxyModelId");
    expect(store).toContain("memoChainModelIds");
  });
});
