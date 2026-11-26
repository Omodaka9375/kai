import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

/**
 * MemoChain TS handler unit tests (2026-11-26): hashing parity with the
 * Python tooling, atomic eviction grouping, and the hot-window fold decision.
 * Native-backed paths (foldMessages/buildMemoryBlock) are exercised against
 * a mocked native.invoke to keep these pure.
 */

vi.mock("./native", () => ({
  native: {
    memochainFold: vi.fn(),
    memochainRecall: vi.fn(),
    memochainSetSummary: vi.fn(),
  },
}));

import {
  MEMOCHAIN_HOT_LIMIT,
  MEMOCHAIN_KEEP_MIN,
  MEMOCHAIN_MAX_DOC_CHARS,
  MEMOCHAIN_RECALL_TOP_K,
  decideFold,
  memoChainFoldPrefix,
  estimateTokens,
  evictionGroups,
  foldLimitsFor,
  messageHash,
  messageText,
  messageWeightText,
} from "./memochain";
import type { ModelMessage } from "ai";

const user = (text: string): ModelMessage =>
  ({ role: "user", content: text }) as ModelMessage;

describe("estimateTokens", () => {
  it("matches the ~4-chars-per-token convention", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abc")).toBe(1); // floor, min 1
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("")).toBe(1);
  });
});

describe("messageHash", () => {
  it("is stable and role-sensitive", async () => {
    const a = await messageHash(user("hello"));
    const b = await messageHash(user("hello"));
    const c = await messageHash({ role: "assistant", content: "hello" } as ModelMessage);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches a manual sha256 of the same JSON payload (node:crypto parity oracle)", async () => {
    const m: ModelMessage = { role: "user", content: "x" } as ModelMessage;
    const payload = JSON.stringify({
      role: m.role,
      content: m.content,
      tool_calls: undefined,
      tool_call_id: undefined,
      name: undefined,
    });
    // node:crypto is the ORACLE here (test runs in Node), pinning that the
    // browser-subtle implementation in memochain.ts produces the same digest
    // as the Python tooling's hashlib.sha256(...).hexdigest().
    const manual = createHash("sha256").update(payload, "utf8").digest("hex");
    expect(await messageHash(m)).toBe(manual);
  });
});

describe("messageText", () => {
  it("joins text blocks of array content", () => {
    const m = {
      role: "assistant",
      content: [
        { type: "text", text: "part one" },
        { type: "text", text: "part two" },
      ],
    } as unknown as ModelMessage;
    expect(messageText(m)).toBe("part one\npart two");
  });

  it("returns string content verbatim", () => {
    expect(messageText(user("plain"))).toBe("plain");
  });
});

describe("evictionGroups", () => {
  it("fuses assistant tool_calls with their tool results", () => {
    const msgs: ModelMessage[] = [
      user("q"),
      { role: "assistant", content: "calling", tool_calls: [{ id: "t1" }] },
      { role: "tool", content: "r1", tool_call_id: "t1" } as unknown as ModelMessage,
      { role: "assistant", content: "done" },
    ] as ModelMessage[];
    const groups = evictionGroups(msgs);
    // user | (assistant+tool fused) | assistant
    expect(groups).toEqual([[0, 1], [1, 3], [3, 4]]);
  });

  it("single messages are their own group", () => {
    const groups = evictionGroups([user("a"), user("b")]);
    expect(groups).toEqual([[0, 1], [1, 2]]);
  });

  it("fuses SDK v6 tool-call content blocks with their tool-result blocks (2026-11-26 fix)", () => {
    // The wire shape KAI's converted history actually uses: assistant
    // content holds tool-call blocks, tool-role content holds tool-result
    // blocks. The original grouping only knew the native tool_calls field,
    // so runtime grouping fused NOTHING and a fold boundary could split a
    // call from its result.
    const msgs = [
      user("q"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool-call", toolCallId: "c1", toolName: "grep", input: { pattern: "x" } },
          { type: "tool-call", toolCallId: "c2", toolName: "read_file", input: { path: "y" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c2", toolName: "read_file", output: "file body" },
          { type: "tool-result", toolCallId: "c1", toolName: "grep", output: ["hit1"] },
        ],
      } as unknown as ModelMessage,
      { role: "assistant", content: "done" },
    ] as unknown as ModelMessage[];
    const groups = evictionGroups(msgs);
    // user | (assistant + its tool result fused, ids matched in any order) | assistant
    expect(groups).toEqual([[0, 1], [1, 3], [3, 4]]);
  });
});

describe("decideFold", () => {
  const big = (n: number) => Array.from({ length: n }, (_, i) => user(`msg ${i} ${"x".repeat(400)}`));

  it("no fold under the hot limit", () => {
    const msgs = big(3);
    const d = decideFold(msgs);
    expect(d.overflow).toBe(false);
    expect(d.foldEnd).toBe(0);
  });

  it("folds the oldest groups when over the limit, keeps the floor and last user turn", () => {
    // ~100 tokens per message: 300 messages ≈ 30k tokens... build a set that
    // crosses the limit while keeping the remainder above the keep floor.
    const msgs = big(300); // 300 * ~103 tokens ≈ 31k — need more.
    const huge = big(1000); // ≈ 103k tokens
    const d = decideFold(huge, MEMOCHAIN_HOT_LIMIT, MEMOCHAIN_KEEP_MIN);
    expect(d.overflow).toBe(true);
    expect(d.foldEnd).toBeGreaterThan(0);
    expect(d.foldEnd).toBeLessThan(huge.length);
    // The remainder must stay at/above the keep floor (or the fold stops).
    expect(d.hotTokens).toBeGreaterThanOrEqual(Math.min(MEMOCHAIN_KEEP_MIN, MEMOCHAIN_HOT_LIMIT) - 200);
    // The last message (active turn) is never folded.
    expect(d.foldEnd).toBeLessThan(1000);
    void msgs;
  });

  it("never folds a single group", () => {
    const msgs = big(1);
    expect(decideFold(msgs).overflow).toBe(false);
  });

  it("empty history is a no-op", () => {
    expect(decideFold([]).overflow).toBe(false);
  });
});

describe("messageWeightText (tool i/o counts toward the hot window, 2026-11-26 fix)", () => {
  it("counts SDK v6 tool-call input and tool-result output blocks", () => {
    const assistant = {
      role: "assistant",
      content: [
        { type: "text", text: "looking" },
        { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "src/lib.rs", offset: 0, limit: 2000 } },
      ],
    } as unknown as ModelMessage;
    // messageText (hash/capsule parity) sees ONLY the text block; the weight
    // variant must see the tool input too - otherwise tool-heavy sessions
    // undercount forever and never fold.
    expect(messageText(assistant)).toBe("looking");
    expect(messageWeightText(assistant)).toContain("looking");
    expect(messageWeightText(assistant)).toContain("src/lib.rs");

    const tool = {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "c1", toolName: "read_file", output: "fn main() {}" },
      ],
    } as unknown as ModelMessage;
    expect(messageText(tool)).toBe("");
    expect(messageWeightText(tool)).toContain("fn main() {}");
  });

  it("counts reasoning and approval blocks (real request tokens)", () => {
    const m = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking it through" },
        { type: "tool-approval-request", approvalId: "a1", toolCallId: "c1" },
      ],
    } as unknown as ModelMessage;
    expect(messageWeightText(m)).toContain("thinking it through");
    expect(messageWeightText(m)).toContain("a1");
  });

  it("a tool-heavy session over the hot limit now folds (regression)", () => {
    // 200 user/tool exchanges whose TEXT is tiny but whose tool i/o is big -
    // the exact shape of the s-mwsdl9r0 session that never folded.
    const msgs: ModelMessage[] = [];
    for (let i = 0; i < 200; i++) {
      msgs.push({
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: `c${i}`, toolName: "bash_run", input: { command: `echo ${i}`, arg: "y".repeat(1200) } },
        ],
      } as unknown as ModelMessage);
      msgs.push({
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: `c${i}`, toolName: "bash_run", output: "z".repeat(1200) },
        ],
      } as unknown as ModelMessage);
    }
    // With the OLD text-only estimator this estimated ~0 tokens. The
    // weighted estimate must cross the default hot limit and fold.
    const d = decideFold(msgs, MEMOCHAIN_HOT_LIMIT, MEMOCHAIN_KEEP_MIN);
    expect(d.overflow).toBe(true);
    expect(d.foldEnd).toBeGreaterThan(0);
    // The fold boundary lands ON a group boundary (never splits a call
    // from its result).
    const groups = evictionGroups(msgs);
    expect(groups.some(([, e]) => e === d.foldEnd)).toBe(true);
  });
});

describe("constants parity with the Rust module", () => {
  it("hot window, keep floor, doc clip and recall depth match mod.rs", () => {
    expect(MEMOCHAIN_HOT_LIMIT).toBe(80_000);
    expect(MEMOCHAIN_KEEP_MIN).toBe(40_000);
    expect(MEMOCHAIN_MAX_DOC_CHARS).toBe(2000);
    expect(MEMOCHAIN_RECALL_TOP_K).toBe(4);
  });
});

describe("foldLimitsFor (custom-endpoint context scaling, 2026-11-26)", () => {
  it("missing or zero limit keeps the proxy defaults (cloud registry models)", () => {
    expect(foldLimitsFor(undefined)).toEqual({
      hotLimit: MEMOCHAIN_HOT_LIMIT,
      keepMin: MEMOCHAIN_KEEP_MIN,
    });
    expect(foldLimitsFor(0)).toEqual({
      hotLimit: MEMOCHAIN_HOT_LIMIT,
      keepMin: MEMOCHAIN_KEEP_MIN,
    });
  });

  it("scales hot to 80% and keep to 50% of a small local window", () => {
    // 8k local model: folds start at 6.4k, keep floor 4k.
    expect(foldLimitsFor(8_000)).toEqual({ hotLimit: 6_400, keepMin: 4_000 });
    // 32k local model: folds at 25.6k, keeps 16k.
    expect(foldLimitsFor(32_000)).toEqual({ hotLimit: 25_600, keepMin: 16_000 });
  });

  it("keepMin never exceeds hotLimit and floors protect degenerate windows", () => {
    // 1k window: hot floors at the 1k minimum, keep at 500.
    expect(foldLimitsFor(1_000)).toEqual({ hotLimit: 1_000, keepMin: 500 });
    // keepMin (50%) can only exceed hot (80%) if the floors cross - it can't
    // for sane inputs, but the min() guard is pinned for tampered values.
    const l = foldLimitsFor(2_000);
    expect(l.keepMin).toBeLessThanOrEqual(l.hotLimit);
  });

  it("decideFold fires under a scaled hot limit (small-window fold works)", () => {
    // 30k-token history against an 8k window: with the DEFAULT 80k limit this
    // never folds; with foldLimitsFor it must evict down to the keep floor.
    const { hotLimit, keepMin } = foldLimitsFor(8_000);
    const big = "x".repeat(120); // 30 tokens per message
    const msgs = Array.from({ length: 1000 }, (_, i) => user(`${i} ${big}`));
    const d = decideFold(msgs, hotLimit, keepMin);
    expect(d.overflow).toBe(true);
    expect(d.foldEnd).toBeGreaterThan(0);
    expect(d.hotTokens).toBeGreaterThanOrEqual(Math.min(keepMin, hotLimit) - 200);
  });
});

describe("memoChainFoldPrefix hot-window trim (2026-11-26 specialist review)", () => {
  it("returns the folded prefix REMOVED - the caller must send trimmedMessages, not its original", async () => {
    const { native } = await import("./native");
    vi.mocked(native.memochainFold).mockResolvedValue({
      step: 1,
      stateDigest: "abc",
      weightsDigest: "w",
      receiptRows: 2,
      chunkCount: 2,
      docsFolded: 2,
    });
    // ~103 tokens/message x 1000: crosses the default hot limit.
    const msgs = Array.from(
      { length: 1000 },
      (_, i) => user(`msg ${i} ${"x".repeat(400)}`),
    );
    const result = await memoChainFoldPrefix("s-test", msgs);
    expect(result).not.toBeNull();
    // THE FIX: the folded messages leave the model-bound window.
    expect(result!.trimmedMessages.length).toBe(msgs.length - result!.foldedMessages);
    // And the trim is a real suffix of the original (not copies/mutations).
    expect(result!.trimmedMessages[0]).toBe(msgs[result!.foldedMessages]);
    expect(result!.trimmedMessages.length).toBeGreaterThan(0);
  });

  it("no fold under the limit returns null (no trim, full history)", async () => {
    const result = await memoChainFoldPrefix("s-test2", [user("hi"), user("there")]);
    expect(result).toBeNull();
  });
});
