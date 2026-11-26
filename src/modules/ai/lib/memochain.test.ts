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
    memochainSessionInfo: vi.fn(),
  },
}));

import {
  MEMOCHAIN_HOT_LIMIT,
  MEMOCHAIN_KEEP_MIN,
  MEMOCHAIN_MAX_DOC_CHARS,
  MEMOCHAIN_RECALL_TOP_K,
  decideFold,
  foldMessages,
  injectRecalledBeforeLastUser,
  memoChainFoldPrefix,
  memoChainMemorySections,
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

  it("caps 1M-context cloud models at 80k/40k so MemoChain still folds", () => {
    expect(foldLimitsFor(1_000_000)).toEqual({
      hotLimit: MEMOCHAIN_HOT_LIMIT,
      keepMin: MEMOCHAIN_KEEP_MIN,
    });
    expect(foldLimitsFor(200_000)).toEqual({
      hotLimit: MEMOCHAIN_HOT_LIMIT,
      keepMin: MEMOCHAIN_KEEP_MIN,
    });
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

describe("memoChainFactSheet (honesty pass: locally-derived summary, 2026-11-26)", () => {
  it("derives asks/files/tools from the folded prefix and persists via set_summary", async () => {
    const { native } = await import("./native");
    vi.mocked(native.memochainSessionInfo).mockResolvedValue({
      exists: true,
      step: 3,
      stateDigest: "d",
      accumulator: "a",
      summary: "PREVIOUS SHEET",
      foldedHashes: ["h1"],
      weightsDigest: null,
      tampered: false,
    });
    vi.mocked(native.memochainSetSummary).mockResolvedValue(true);
    const folded = [
      user("Fix the login bug please"),
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "src/login.ts" } },
          { type: "tool-call", toolCallId: "c2", toolName: "edit", input: { path: "src/login.ts" } },
        ],
      } as unknown as ModelMessage,
    ];
    const { memoChainFactSheet } = await import("./memochain");
    await memoChainFactSheet("s-sheet", folded);
    const arg = vi.mocked(native.memochainSetSummary).mock.calls[0]?.[1] ?? "";
    // Merged with the existing sheet (older context kept).
    expect(arg).toContain("PREVIOUS SHEET");
    // Observables present, honestly labeled.
    expect(arg).toContain("Fix the login bug please");
    expect(arg).toContain("src/login.ts");
    expect(arg).toContain("read_file");
  });

  it("empty prefix is a no-op (no summary write)", async () => {
    const { native } = await import("./native");
    vi.mocked(native.memochainSetSummary).mockClear();
    const { memoChainFactSheet } = await import("./memochain");
    await memoChainFactSheet("s-sheet2", []);
    expect(native.memochainSetSummary).not.toHaveBeenCalled();
  });

  it("keeps the NEWEST 2000 chars when merged summary exceeds the cap", async () => {
    const { native } = await import("./native");
    vi.mocked(native.memochainSetSummary).mockClear();
    vi.mocked(native.memochainSessionInfo).mockResolvedValue({
      exists: true,
      step: 5,
      stateDigest: "d",
      accumulator: "a",
      summary: "OLD_SENTINEL_" + "a".repeat(1990),
      foldedHashes: [],
      weightsDigest: null,
      tampered: false,
    });
    vi.mocked(native.memochainSetSummary).mockResolvedValue(true);
    const { memoChainFactSheet } = await import("./memochain");
    await memoChainFactSheet("s-sheet-cap", [user("BRAND_NEW_ASK_MARKER")]);
    const written = vi.mocked(native.memochainSetSummary).mock.calls[0]?.[1] ?? "";
    expect(written.length).toBeLessThanOrEqual(2000);
    expect(written).toContain("BRAND_NEW_ASK_MARKER");
    expect(written).not.toContain("OLD_SENTINEL_");
  });

  it("skips its own injected memory blocks (memory-of-memory guard, 2026-11-27)", async () => {
    // LIVE DEFECT (3.5.6 dev build, session s-mwsdl9r0-2oqy2q): the recalled-
    // turns block is injected as a synthetic USER message before the latest
    // user turn; once folded, its header text landed verbatim in meta.json's
    // summary ("Earlier asks: [Durable memory - recalled turns]"). The fact
    // sheet must not summarize its own injections.
    const { native } = await import("./native");
    vi.mocked(native.memochainSetSummary).mockClear();
    vi.mocked(native.memochainSessionInfo).mockResolvedValue({
      exists: false,
      step: 0,
      stateDigest: "",
      accumulator: "",
      summary: "",
      foldedHashes: [],
      weightsDigest: null,
      tampered: false,
    });
    vi.mocked(native.memochainSetSummary).mockResolvedValue(true);
    const { memoChainFactSheet } = await import("./memochain");
    const syntheticRecall =
      "[Durable memory - recalled turns]\nRelevant verbatim turns recalled for the current question:\n[user] (score 0.91) use port 8080";
    await memoChainFactSheet("s-guard", [
      user(syntheticRecall),
      user("what port is the server on?"),
    ]);
    const written = vi.mocked(native.memochainSetSummary).mock.calls[0]?.[1] ?? "";
    expect(written).toContain("what port is the server on?");
    expect(written).not.toContain("[Durable memory");
  });

  it("never folds its own injected memory blocks into the capsule (mid-run fold, 2026-11-27)", async () => {
    // WRITE-SIDE GUARD: prepareStep's mid-run fold receives step messages
    // that still carry the CURRENT run's synthetic recall injection. The
    // pre-3.5.7 build folded those into capsule + chunks.bin, so later
    // recalls returned nested recall-of-recall blocks filling every top-K
    // slot (observed live). memoChainFoldPrefix must drop them BEFORE
    // hashing - and still fold the real turns around them.
    const { native } = await import("./native");
    vi.mocked(native.memochainSessionInfo).mockResolvedValue({
      exists: false,
      step: 0,
      stateDigest: "",
      accumulator: "",
      summary: "",
      foldedHashes: [],
      weightsDigest: null,
      tampered: false,
    });
    vi.mocked(native.memochainFold).mockClear();
    vi.mocked(native.memochainFold).mockResolvedValue({
      step: 1,
      stateDigest: "d1",
      weightsDigest: "w1",
      receiptRows: 1,
      chunkCount: 1,
      docsFolded: 1,
    });
    const { memoChainFoldPrefix } = await import("./memochain");
    const syntheticRecall =
      "[Durable memory - recalled turns]\nRelevant verbatim turns recalled for the current question:\n[user] (score 0.91) use port 8080";
    // Force a fold: 8k limit -> hot 6.4k / keep 4k, so ~7.5k tokens of history
    // overflows and decideFold evicts the leading groups.
    const msgs: ModelMessage[] = [
      user("old ask one " + "x".repeat(10_000)),
      user("old ask two " + "y".repeat(10_000)),
      user("old ask three " + "z".repeat(10_000)),
      user(syntheticRecall),
      user("current question"),
    ];
    const res = await memoChainFoldPrefix("s-fold-guard", msgs, 8_000);
    expect(res).not.toBeNull();
    const entries = vi.mocked(native.memochainFold).mock.calls[0]?.[1] ?? [];
    for (const e of entries) {
      expect(e.text).not.toContain("[Durable memory");
    }
    // Real turns around the injection still folded.
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.text.includes("old ask one"))).toBe(true);
  });
});

describe("regression guards (2026-11-26 audit fixes)", () => {
  it("preserves leading system messages during mid-run prepareStep fold", async () => {
    const { native } = await import("./native");
    vi.mocked(native.memochainSessionInfo).mockResolvedValue({
      exists: false,
      step: 0,
      stateDigest: "",
      accumulator: "",
      summary: "",
      foldedHashes: [],
      weightsDigest: null,
      tampered: false,
    });
    vi.mocked(native.memochainFold).mockClear();
    vi.mocked(native.memochainFold).mockResolvedValue({
      step: 5,
      stateDigest: "s5",
      weightsDigest: "w",
      receiptRows: 5,
      chunkCount: 5,
      docsFolded: 5,
    });
    const sysMsg: ModelMessage = { role: "system", content: "SYSTEM_PROMPT_MUST_SURVIVE" };
    const conv = Array.from(
      { length: 200 },
      (_, i) => user(`turn ${i} ${"x".repeat(200)}`),
    );
    const stepMessages: ModelMessage[] = [sysMsg, ...conv];
    const res = await memoChainFoldPrefix("s-prep", stepMessages, 8_000);
    expect(res).not.toBeNull();
    // System message stays verbatim at index 0 and is NEVER sent to memochainFold.
    expect(res!.trimmedMessages[0]).toBe(sysMsg);
    const foldedEntries = vi.mocked(native.memochainFold).mock.calls[0]?.[1] ?? [];
    expect(foldedEntries.some((e) => e.role === "system")).toBe(false);
    expect(foldedEntries.some((e) => e.text.includes("SYSTEM_PROMPT_MUST_SURVIVE"))).toBe(false);
  });

  it("strips already-folded prefix on subsequent turns without re-folding or repeating notices", async () => {
    const { native } = await import("./native");
    const msgs = Array.from({ length: 10 }, (_, i) => user(`turn ${i} ${"x".repeat(40)}`));
    const alreadyHashes = await Promise.all(msgs.slice(0, 4).map((m) => messageHash(m)));
    vi.mocked(native.memochainSessionInfo).mockResolvedValue({
      exists: true,
      step: 4,
      stateDigest: "d4",
      accumulator: "a4",
      summary: "earlier",
      foldedHashes: alreadyHashes,
      weightsDigest: null,
      tampered: false,
    });
    vi.mocked(native.memochainFold).mockClear();
    // Total hot tail is well under limit, so NO new fold should run — only strip.
    const res = await memoChainFoldPrefix("s-strip", msgs, 128_000);
    expect(res).not.toBeNull();
    expect(res!.alreadyFolded).toBe(4);
    expect(res!.foldedMessages).toBe(0);
    expect(res!.newlyFolded).toEqual([]);
    expect(res!.trimmedMessages).toEqual(msgs.slice(4));
    expect(native.memochainFold).not.toHaveBeenCalled();
  });

  it("foldMessages indexes tool-only messages via messageWeightText so hashes and outputs are retained", async () => {
    const { native } = await import("./native");
    vi.mocked(native.memochainFold).mockClear();
    vi.mocked(native.memochainFold).mockResolvedValue({
      step: 2,
      stateDigest: "d2",
      weightsDigest: "w",
      receiptRows: 2,
      chunkCount: 2,
      docsFolded: 2,
    });
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "src/app.ts" } },
        ],
      } as unknown as ModelMessage,
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", toolName: "read_file", output: "export const PORT = 8080;" },
        ],
      } as unknown as ModelMessage,
    ];
    await foldMessages("s-tool", msgs);
    const entries = vi.mocked(native.memochainFold).mock.calls[0]?.[1] ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toContain("src/app.ts");
    expect(entries[1].text).toContain("PORT = 8080");
    expect(entries[0].msgHash).toBe(await messageHash(msgs[0]));
    expect(entries[1].msgHash).toBe(await messageHash(msgs[1]));
  });

  it("splits stable summary from per-turn recalled chunks and injects recall before the last user turn", async () => {
    const { native } = await import("./native");
    vi.mocked(native.memochainRecall).mockResolvedValue({
      summary: "Earlier asks:\n- build server",
      step: 3,
      stateDigest: "d3",
      chunks: [{ score: 0.91, step: 1, role: "user", text: "use port 8080" }],
    });
    const fenceState = {
      nonces: { tool: "t1", web: "w1", watch: "wa1", mcp: "m1" },
    } as unknown as import("./fence").FenceState;
    const history: ModelMessage[] = [
      user("first ask"),
      { role: "assistant", content: "first reply" } as ModelMessage,
      user("which port?"),
    ];
    const sections = await memoChainMemorySections("s-split", history, fenceState);
    expect(sections).not.toBeNull();
    expect(sections!.summaryBlock).toContain("build server");
    expect(sections!.summaryBlock).not.toContain("use port 8080");
    expect(sections!.recalledBlock).toContain("use port 8080");
    expect(sections!.recalledBlock).toContain("[start tool_t1]");

    const injected = injectRecalledBeforeLastUser(history, sections!.recalledBlock);
    expect(injected).toHaveLength(4);
    expect(injected[2].role).toBe("user");
    expect(String(injected[2].content)).toContain("use port 8080");
    expect(injected[3]).toBe(history[2]);
  });

  it("filters polluted recall chunks and leaked summary lines (read-side guard, 2026-11-27)", async () => {
    // Chunk stores written by builds BEFORE the write-side guard contain
    // synthetic [Durable memory...] user messages. buildMemoryBlock must
    // drop them on read so a polluted store heals instead of injecting
    // nested recall-of-recall noise; summary lines leak the same way.
    const { native } = await import("./native");
    vi.mocked(native.memochainRecall).mockResolvedValue({
      summary:
        "Earlier asks:\n- [Durable memory - recalled turns]\n- rebuild the tarball\nFiles touched:\n- src/app.ts",
      step: 9,
      stateDigest: "d9",
      chunks: [
        {
          score: 0.9,
          step: 4,
          role: "user",
          text: "[Durable memory - recalled turns]\nRelevant verbatim turns:\n- [user] old ask",
        },
        { score: 0.85, step: 5, role: "user", text: "rebuild the tarball please" },
      ],
    });
    const fenceState = {
      nonces: { tool: "t1", web: "w1", watch: "wa1", mcp: "m1" },
    } as unknown as import("./fence").FenceState;
    const history: ModelMessage[] = [user("what did we build?")];
    const sections = await memoChainMemorySections("s-read-guard", history, fenceState);
    expect(sections).not.toBeNull();
    // The polluted chunk is gone; the real one survives.
    expect(sections!.recalledChunks).toHaveLength(1);
    expect(sections!.recalledChunks[0].text).toContain("rebuild the tarball");
    expect(sections!.summary).not.toContain("[Durable memory");
    expect(sections!.summary).toContain("rebuild the tarball");
    expect(sections!.summary).toContain("src/app.ts");
  });
});

describe("cache-aware passthrough (mina parity, 2026-11-26)", () => {
  it("reaches passthrough only after the streak of high-hit responses", async () => {
    const { memoChainCachePassthrough, noteMemoChainCacheHitRatio, resetMemoChainPassthrough } =
      await import("./memochain");
    const sid = "s-pass";
    resetMemoChainPassthrough(sid);
    // No history yet: no passthrough.
    expect(memoChainCachePassthrough(sid)).toBe(false);
    // 70% hit (>= 0.5): streak 1 — not enough.
    expect(noteMemoChainCacheHitRatio(sid, 0.7)).toBe(false);
    expect(memoChainCachePassthrough(sid)).toBe(false);
    // Second consecutive high hit: streak 2 — passthrough NOW.
    expect(noteMemoChainCacheHitRatio(sid, 0.7)).toBe(true);
    expect(memoChainCachePassthrough(sid)).toBe(true);
  });

  it("resets the streak on a below-threshold response", async () => {
    const { memoChainCachePassthrough, noteMemoChainCacheHitRatio, resetMemoChainPassthrough } =
      await import("./memochain");
    const sid = "s-reset";
    resetMemoChainPassthrough(sid);
    expect(noteMemoChainCacheHitRatio(sid, 0.9)).toBe(false);
    expect(noteMemoChainCacheHitRatio(sid, 0.4)).toBe(false); // resets
    expect(memoChainCachePassthrough(sid)).toBe(false);
    // Streak restarts from zero: one high hit is not enough.
    expect(noteMemoChainCacheHitRatio(sid, 0.9)).toBe(false);
    expect(noteMemoChainCacheHitRatio(sid, 0.9)).toBe(true);
  });

  it("null ratio (no usage reported) resets the streak, like the proxy default 0.0", async () => {
    const { memoChainCachePassthrough, noteMemoChainCacheHitRatio, resetMemoChainPassthrough } =
      await import("./memochain");
    const sid = "s-null";
    resetMemoChainPassthrough(sid);
    expect(noteMemoChainCacheHitRatio(sid, 0.8)).toBe(false);
    expect(noteMemoChainCacheHitRatio(sid, null)).toBe(false); // provider silent: reset
    expect(memoChainCachePassthrough(sid)).toBe(false);
  });

  it("memoChainCacheHitRatio clamps to 1 and returns null on zero input", async () => {
    const { memoChainCacheHitRatio } = await import("./memochain");
    expect(memoChainCacheHitRatio(100, 70)).toBe(0.7);
    expect(memoChainCacheHitRatio(100, 500)).toBe(1); // clamped
    expect(memoChainCacheHitRatio(0, 0)).toBeNull();
  });

  it("is per-session: another session's streak does not leak", async () => {
    const { memoChainCachePassthrough, noteMemoChainCacheHitRatio, resetMemoChainPassthrough } =
      await import("./memochain");
    const a = "s-a";
    const b = "s-b";
    resetMemoChainPassthrough(a);
    resetMemoChainPassthrough(b);
    noteMemoChainCacheHitRatio(a, 0.9);
    noteMemoChainCacheHitRatio(a, 0.9);
    expect(memoChainCachePassthrough(a)).toBe(true);
    expect(memoChainCachePassthrough(b)).toBe(false);
  });
});

describe("cumulative savings accumulator (context dropdown Saved row)", () => {
  it("accumulates net avoided tokens across fold passes and floors negatives", async () => {
    const { getMemoChainSavings, noteMemoChainSavings, resetMemoChainSavings } = await import(
      "./memochain"
    );
    const sid = "s-savings";
    resetMemoChainSavings(sid);
    expect(getMemoChainSavings(sid)).toBe(0);
    // No-fold / passthrough request: 0, no growth.
    noteMemoChainSavings(sid, 0);
    expect(getMemoChainSavings(sid)).toBe(0);
    // A fold avoiding 12k net tokens.
    noteMemoChainSavings(sid, 12_000);
    expect(getMemoChainSavings(sid)).toBe(12_000);
    // Memory blocks cost more than the fold saved this request: floored, never negative.
    noteMemoChainSavings(sid, -500);
    expect(getMemoChainSavings(sid)).toBe(12_000);
    // Second fold accumulates.
    noteMemoChainSavings(sid, 3_000);
    expect(getMemoChainSavings(sid)).toBe(15_000);
    // Null session reads 0.
    expect(getMemoChainSavings(null)).toBe(0);
  });
});
