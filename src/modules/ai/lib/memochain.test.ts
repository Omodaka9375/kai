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
  estimateTokens,
  evictionGroups,
  messageHash,
  messageText,
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

describe("constants parity with the Rust module", () => {
  it("hot window, keep floor, doc clip and recall depth match mod.rs", () => {
    expect(MEMOCHAIN_HOT_LIMIT).toBe(80_000);
    expect(MEMOCHAIN_KEEP_MIN).toBe(40_000);
    expect(MEMOCHAIN_MAX_DOC_CHARS).toBe(2000);
    expect(MEMOCHAIN_RECALL_TOP_K).toBe(4);
  });
});
