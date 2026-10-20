import { describe, expect, it } from "vitest";
import { sanitizeDroppedText } from "./dropText";

/**
 * Dropped-text sanitization for the terminal drop target. The drop target
 * accepts ANY text/plain payload (including external drags from the
 * browser), so the text written to the PTY must never carry a newline
 * (auto-executes at a bash/zsh prompt — LF == Enter) or control bytes.
 */

describe("sanitizeDroppedText", () => {
  it("passes plain paths through unchanged", () => {
    expect(sanitizeDroppedText("src/lib/main.ts")).toBe("src/lib/main.ts");
    expect(sanitizeDroppedText("'my file.txt' 'second.txt'")).toBe(
      "'my file.txt' 'second.txt'",
    );
  });

  it("joins newlines into spaces (no auto-execution at Enter)", () => {
    expect(sanitizeDroppedText("evil\nrm -rf ~")).toBe("evil rm -rf ~");
    expect(sanitizeDroppedText("line1\r\nline2")).toBe("line1 line2");
    // Trailing newline does not leave a dangling space.
    expect(sanitizeDroppedText("path/to/file\n")).toBe("path/to/file");
  });

  it("strips CR outright", () => {
    expect(sanitizeDroppedText("ab\rcd")).toBe("abcd");
  });

  it("strips control bytes (NUL, tab, ESC, DEL)", () => {
    expect(sanitizeDroppedText("a\tb")).toBe("ab");
    expect(sanitizeDroppedText("a\x00b")).toBe("ab");
    expect(sanitizeDroppedText("a\x1bb")).toBe("ab");
    expect(sanitizeDroppedText("a\x7fb")).toBe("ab");
  });

  it("returns empty for payload that is only whitespace/controls", () => {
    expect(sanitizeDroppedText("\n\t\r\n")).toBe("");
    expect(sanitizeDroppedText("   ")).toBe("");
  });
});
