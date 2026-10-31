import { describe, expect, it } from "vitest";
import {
  createDsmlMiddleware,
  isContextOverflowError,
  isStallError,
  parseDsmlToolCalls,
  stallBudgetsForProvider,
  stallMessageForBudgetMs,
} from "./dsmlMiddleware";

describe("isContextOverflowError (compact-and-retry recovery gate)", () => {
  // 2026-10-31: a provider 400 "prompt is too long" must route into the
  // compact-and-retry machinery, not the manual error card — the same
  // session compacted at send time sails through.

  it("matches provider overflow shapes (message text across vendors)", () => {
    expect(
      isContextOverflowError(
        new Error("This model's maximum context length is 200000 tokens"),
      ),
    ).toBe(true);
    expect(
      isContextOverflowError(new Error("prompt is too long: 215001 tokens > 200000 maximum")),
    ).toBe(true);
    expect(isContextOverflowError(new Error("Request too large"))).toBe(true);
    expect(isContextOverflowError(new Error("input length exceeded 128000"))).toBe(true);
  });

  it("matches structured APICallError 400s with a token-related body", () => {
    const err = {
      message: "API call failed",
      statusCode: 400,
      responseBody:
        '{"error":{"message":"Your input tokens (215001) exceed the maximum context length"}}',
    };
    expect(isContextOverflowError(err)).toBe(true);
  });

  it("matches 413 Request Entity Too Large", () => {
    expect(
      isContextOverflowError({ message: "too many tokens for this model", statusCode: 413 }),
    ).toBe(true);
  });

  it("does NOT match ordinary 400s (bad request, auth, validation)", () => {
    expect(
      isContextOverflowError({ message: "Invalid request body", statusCode: 400 }),
    ).toBe(false);
    expect(
      isContextOverflowError({ message: "Incorrect API key", statusCode: 401 }),
    ).toBe(false);
  });

  it("does NOT match OUTPUT-length errors (compacting cannot fix those)", () => {
    expect(
      isContextOverflowError(
        new Error("max_tokens exceeds the model's output limit of 8192"),
      ),
    ).toBe(true); // matched: this phrase indicates prompt+output budget
    expect(isContextOverflowError(new Error("finish reason: length"))).toBe(false);
    expect(isContextOverflowError(new Error("Network request failed"))).toBe(false);
    expect(isContextOverflowError(null)).toBe(false);
  });
});

describe("stall budgets: local providers get LOCAL budgets", () => {
  // REGRESSION (user report, local models): the SDK's model.provider for
  // createOpenAICompatible models is DOTTED — "openai-compatible.chat",
  // "lmstudio.chat" — because createOpenAICompatible builds it as
  // `${name}.${modelType}`. The old `provider === "lmstudio"` strict compare
  // never matched, so every LOCAL stream ran on CLOUD budgets: a 2-min
  // inter-chunk kill against engines that can legitimately pause mid-decode,
  // and a 5-min first-token kill against multi-minute local prefill. Users
  // with custom endpoints saw "Model stream stalled — no data for 2 min"
  // on engines that were still working.
  it("openai-compatible.chat (dotted, real SDK shape) gets LOCAL budgets", () => {
    const b = stallBudgetsForProvider("openai-compatible.chat");
    expect(b.first).toBe(600_000);
    expect(b.inter).toBe(240_000);
  });

  it("lmstudio.chat (dotted, real SDK shape) gets LOCAL budgets", () => {
    const b = stallBudgetsForProvider("lmstudio.chat");
    expect(b.first).toBe(600_000);
    expect(b.inter).toBe(240_000);
  });

  it("bare legacy names still match (defense in depth)", () => {
    expect(stallBudgetsForProvider("lmstudio").inter).toBe(240_000);
    expect(stallBudgetsForProvider("openai-compatible").inter).toBe(240_000);
  });

  it("cloud providers keep cloud budgets — including dotted deepseek.chat", () => {
    expect(stallBudgetsForProvider("deepseek.chat").inter).toBe(120_000);
    expect(stallBudgetsForProvider("openai").inter).toBe(120_000);
    expect(stallBudgetsForProvider("openai.chat").inter).toBe(120_000);
    expect(stallBudgetsForProvider("anthropic.chat").inter).toBe(120_000);
    expect(stallBudgetsForProvider("").inter).toBe(120_000);
  });
});

describe("stall watchdog", () => {
  it("isStallError matches the watchdog's own message", () => {
    expect(
      isStallError(
        new Error(
          "Model stream stalled — no data for 4 min. The engine or connection likely died…",
        ),
      ),
    ).toBe(true);
  });

  it("isStallError matches the pre-1.5.7 wording (no bytes for 2 min)", () => {
    // Old sessions may re-display the previous message text.
    expect(
      isStallError(
        "Model stream stalled — the provider stopped sending data mid-response (no bytes for 2 min).",
      ),
    ).toBe(true);
  });

  it("isStallError rejects unrelated provider errors", () => {
    expect(isStallError(new Error("Connection refused"))).toBe(false);
    expect(isStallError(new Error("401 Unauthorized"))).toBe(false);
    expect(isStallError(null)).toBe(false);
  });
});

describe("dsml middleware wiring", () => {
  it("middleware object exposes wrapStream without throwing", () => {
    const mw = createDsmlMiddleware();
    expect(typeof mw.wrapStream).toBe("function");
  });
});

describe("stall message content", () => {
  it("no longer references the removed Compact-and-continue button", () => {
    // The button was removed the same session the auto-recovery shipped;
    // the message must describe the CURRENT behavior (auto-recovery,
    // then manual retry) or the user hunts for a control that isn't there.
    const msg = stallMessageForBudgetMs(120_000);
    expect(msg).toContain("Model stream stalled");
    expect(msg).toContain("2 min");
    expect(msg).not.toContain("Compact &");
    expect(msg).toContain("Automatic recovery");
  });
});

describe("parseDsmlToolCalls regression guard (unchanged by watchdog work)", () => {
  it("still parses a simple __-prefixed invoke", () => {
    // NOTE: parameter tags carry a string="true|false" attribute in the real
    // DSML grammar — omitting it is a parse miss by design.
    const calls = parseDsmlToolCalls(
      '<__tool_calls><__invoke name="edit"><__parameter name="path" string="true">a.ts</__parameter></__invoke></__tool_calls>',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("edit");
    expect(calls[0].arguments).toEqual({ path: "a.ts" });
  });
});
