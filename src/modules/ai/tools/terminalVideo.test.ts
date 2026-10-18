import { describe, expect, it } from "vitest";
import { shellQuoteForTest } from "./terminalVideo";

/**
 * Adversarial cases for the shellQuote gate. The command runs through the
 * Rust oneshot runner (PowerShell -File on Windows, sh elsewhere), so every
 * metachar must be rejected outright — an earlier draft had `&` outside the
 * regex character class, which accepted `x"; cmd; #` (statement injection).
 */
describe("shellQuote gate", () => {
  it("rejects statement/quoting injection attempts", () => {
    for (const evil of [
      'x"; calc; #',
      "a;b",
      'a"b',
      "$(calc)",
      "`calc`",
      "a&b",
      "C:\\Videos\\x.mp4",
    ]) {
      expect(() => shellQuoteForTest(evil)).toThrow();
    }
  });

  it("allows ordinary paths and URLs (quoted)", () => {
    for (const fine of ["plain-name.mp4", "my (final) cut.mp4", "https://host/v.mp4"]) {
      expect(shellQuoteForTest(fine)).toBe(`"${fine}"`);
    }
  });
});
