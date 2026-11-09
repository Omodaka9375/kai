import { describe, expect, it, vi } from "vitest";

/**
 * Deliverable guarantee (2026-11-09 report: "subagents that go far deliver
 * nothing and it's time waste"). runSubagent used to return whatever
 * generateText left in result.text — which is EMPTY when the step budget ran
 * out mid-investigation, because the loop's last step was tool calls. A 20
 * minute fork returned a fenced "(no output)". Two behaviors are pinned:
 *   1. A budget-exhausted or text-less run triggers ONE extra no-tools
 *      wrap-up call over the gathered conversation, which can never fork
 *      again and is therefore bounded.
 *   2. A run that finished naturally with text does NOT pay for a wrap-up.
 * runSubagent pulls the whole tool stack, so the AI SDK and tool builders
 * are mocked and only the budget/wrap-up state machine is exercised.
 */
vi.mock("ai", () => ({
  generateText: vi.fn(),
  stepCountIs: (n: number) => ({ kind: "stepCount", n }),
}));

vi.mock("../config", () => ({
  DEFAULT_MODEL_ID: "m",
  getModel: () => ({ id: "m", provider: "openai" }),
}));

vi.mock("../lib/agent", () => ({ buildLanguageModel: vi.fn(async () => ({})) }));
vi.mock("../tools/fs", () => ({ buildFsTools: () => ({}) }));
vi.mock("../tools/search", () => ({ buildSearchTools: () => ({}) }));
vi.mock("../lib/toolFencing", () => ({
  withToolRedaction: (t: unknown) => t,
  withToolGuard: (t: unknown) => t,
}));
vi.mock("../lib/fence", () => ({
  createFenceState: () => ({ nonces: { tool: "nonce" } }),
  fence: (_k: string, _n: string, text: string) => text,
  fenceSystemPrompt: () => "",
}));
vi.mock("./registry", () => ({
  SUBAGENTS: {
    explore: { description: "d", systemPrompt: "sp", tools: [] },
  },
}));

import { generateText } from "ai";
import { runSubagent } from "./runSubagent";
import { beforeEach } from "vitest";

const gen = vi.mocked(generateText);

beforeEach(() => {
  gen.mockReset();
});

const base = {
  type: "explore" as const,
  prompt: "investigate",
  keys: {},
  modelId: "m" as never,
  toolContext: {} as never,
};

describe("subagent deliverable guarantee", () => {
  it("wraps up with a no-tools final report when the budget is exhausted on tool calls", async () => {
    // Step 1..N: tool calls only, no final text.
    gen
      .mockResolvedValueOnce({
        text: "",
        steps: [{}, {}],
        response: { messages: [{ role: "assistant" }] },
      } as never)
      // Wrap-up pass: the report.
      .mockResolvedValueOnce({ text: "FINDINGS: nothing yet, here is what I ruled out." } as never);

    const r = await runSubagent({ ...base, maxSteps: 2 });

    expect(r.summary).toBe("FINDINGS: nothing yet, here is what I ruled out.");
    expect(r.truncated).toBe(true);
    expect(gen).toHaveBeenCalledTimes(2);
    const wrapCall = gen.mock.calls[1][0] as {
      tools?: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    // The wrap-up must be tool-free: a final report can never fork again.
    expect(wrapCall.tools).toBeUndefined();
    // It replays the gathered conversation and ends with the report directive.
    expect(wrapCall.messages.length).toBe(2);
    expect(wrapCall.messages[0]).toMatchObject({ role: "assistant" });
    expect(wrapCall.messages[1].role).toBe("user");
    expect(wrapCall.messages[1].content).toContain("final report");
  });

  it("pays no wrap-up call when the run finished naturally with text", async () => {
    gen.mockResolvedValueOnce({
      text: "All done: 3 findings.",
      steps: [{}, {}, {}],
      response: { messages: [] },
    } as never);

    const r = await runSubagent({ ...base, maxSteps: 24 });

    expect(r.summary).toBe("All done: 3 findings.");
    expect(r.truncated).toBe(false);
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it("keeps the main run's text when the wrap-up pass yields nothing", async () => {
    gen
      .mockResolvedValueOnce({
        text: "partial narration",
        steps: [{}, {}, {}, {}],
        response: { messages: [] },
      } as never)
      .mockResolvedValueOnce({ text: "" } as never);

    const r = await runSubagent({ ...base, maxSteps: 4 });

    expect(r.summary).toBe("partial narration");
    expect(r.truncated).toBe(true);
    expect(gen).toHaveBeenCalledTimes(2);
  });
});
