import { describe, expect, it } from "vitest";
import { pwshQuotingHint } from "./shell";

describe("pwshQuotingHint", () => {
  it("appends the recovery hint to PS 7 string-terminator errors", () => {
    const out = pwshQuotingHint(
      "ParserError: Missing closing ' in string literal.",
    );
    expect(out).toContain("Missing closing");
    expect(out).toContain("[Kai hint:");
    expect(out).toContain("single-quoted");
  });

  it("appends the hint to PS 5.1 terminator errors", () => {
    const out = pwshQuotingHint(
      "The string is missing the terminator: \". ​+ CategoryInfo: ParserError",
    );
    expect(out).toContain("[Kai hint:");
  });

  it("appends the hint to Unexpected token parse errors", () => {
    const out = pwshQuotingHint("Unexpected token 'p' in expression or statement.");
    expect(out).toContain("[Kai hint:");
  });

  it("fires on the mangled-argument class: PS parses, child gets truncated code (Python SyntaxError)", () => {
    // Live-reproduced: `python -c "print(\"a\" + \"b\")"` — PowerShell closes
    // the string at the first `\"`, Python receives `print(` and errors.
    const out = pwshQuotingHint(
      '  File "<string>", line 1\n    print(\\\n         ^\nSyntaxError: \'(\' was never closed',
    );
    expect(out).toContain("[Kai hint:");
    expect(out).toContain("NOT a PowerShell escape");
    expect(out).toContain("truncated");
  });

  it("fires on Python unterminated string literal (the second mangling shape)", () => {
    const out = pwshQuotingHint(
      "SyntaxError: unterminated string literal (detected on line 1)",
    );
    expect(out).toContain("[Kai hint:");
  });

  it("leaves ordinary stderr untouched", () => {
    const err = "error: cannot find package 'foo'";
    expect(pwshQuotingHint(err)).toBe(err);
  });

  it("does not fire on unrelated ParserError-free runtime errors", () => {
    const err = "Get-ChildItem: Cannot find path 'C:\\nope' because it does not exist.";
    expect(pwshQuotingHint(err)).toBe(err);
  });
});
