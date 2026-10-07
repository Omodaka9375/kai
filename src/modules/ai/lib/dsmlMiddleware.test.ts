import { describe, expect, it } from "vitest";
import {
  createDsmlMiddleware,
  isStallError,
  parseDsmlToolCalls,
  stallMessageForBudgetMs,
} from "./dsmlMiddleware";

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
