import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProxyManagedModel } from "../config";

/**
 * PROXY-MANAGED MEMORY gate (MemoChain integration 2026-11-25).
 *
 * When a session routes through the Proxy endpoint (proxy-custom), the
 * PROXY owns context memory: it caps the prompt at a hot window + compact
 * memory and verifies state with a SHA-256 receipt chain. KAI's local
 * context machinery must stand down in that mode — any local rewrite of
 * the history (summarization, compaction elision, /compact) diverges the
 * model-visible prompt from the state the proxy is verifying.
 *
 * These pins lock every gate that disables local context handling:
 *   1. agent.ts pre-run elision skips compactModelMessagesDetailed,
 *   2. agent.ts prepareStep mid-run re-elision skips it too,
 *   3. transport.ts maybeSummarize returns the messages untouched,
 *   4. chatStore.ts /compact refuses (both active-session and
 *      by-id paths) with an explanatory message,
 *   5. both context-ring footers (AiMiniWindow, ProjectChatGrid) say
 *      the proxy owns context memory.
 */

const root = join(dirname(fileURLToPathSafe()), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function fileURLToPathSafe(): string {
  // Tiny wrapper so this file stays importable without node:url ceremony.
  return new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

describe("isProxyManagedModel", () => {
  it("true only for proxy-custom", () => {
    expect(isProxyManagedModel("proxy-custom")).toBe(true);
    expect(isProxyManagedModel("openai-compatible-custom")).toBe(false);
    expect(isProxyManagedModel("gpt-5.4-mini")).toBe(false);
    expect(isProxyManagedModel(null)).toBe(false);
    expect(isProxyManagedModel(undefined)).toBe(false);
    expect(isProxyManagedModel("")).toBe(false);
  });
});

describe("proxy sessions disable local context handling (source pins)", () => {
  it("agent.ts gates both elision sites on isProxyManagedModel", () => {
    const src = read("modules/ai/lib/agent.ts");
    expect(src).toContain("isProxyManagedModel(modelId)");
    // Pre-run elision and prepareStep re-elision both carry the gate.
    const preRun = src.split("PROXY-MANAGED MEMORY (MemoChain 2026-11-25): a proxy-routed session sends")[1]?.split("// PLAN MODE")[0] ?? "";
    expect(preRun).toContain("compactModelMessagesDetailed(history, contextLimit)");
    expect(preRun).toContain("isProxyManagedModel(modelId)");
    const prepareStep = src.split("PROXY-MANAGED MEMORY: same gate as the pre-run elision")[1]?.split("// USER-MESSAGE IMAGE HANDOFF")[0] ?? "";
    expect(prepareStep).toContain("isProxyManagedModel(modelId)");
  });

  it("transport.ts maybeSummarize stands down for proxy sessions", () => {
    const src = read("modules/ai/lib/transport.ts");
    const maybe = src.split("async function maybeSummarize")[1]?.split("/**")[0] ?? "";
    expect(maybe).toContain("if (isProxyManagedModel(modelId)) return messages;");
  });

  it("chatStore.ts /compact refuses proxy-managed sessions (both paths)", () => {
    const src = read("modules/ai/store/chatStore.ts");
    const refusals = src.match(/proxy endpoint \(MemoChain\)/g)?.length ?? 0;
    expect(refusals).toBeGreaterThanOrEqual(2);
    const active = src.split("compactActiveSession: () => {")[1]?.split("compactSessionById:")[0] ?? "";
    const byId = src.split("compactSessionById: (sessionId: string) => {")[1]?.split("\n  },")[0] ?? "";
    for (const block of [active, byId]) {
      expect(block).toContain("isProxyManagedModel(");
      expect(block).toContain("projectIdForSession(");
    }
  });

  it("both context-ring footers explain proxy-managed sessions", () => {
    for (const p of [
      "modules/ai/components/AiMiniWindow.tsx",
      "modules/ai/components/ProjectChatGrid.tsx",
    ]) {
      const src = read(p);
      expect(src).toContain("Proxy-managed session (MemoChain)");
      expect(src).toContain("isProxyManagedModel");
    }
  });
});