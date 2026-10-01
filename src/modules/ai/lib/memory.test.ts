import { describe, expect, it } from "vitest";
import { capMemoryForPrompt } from "./memory";

const HEADER = "# Kai Memory — auto-generated project knowledge\n\nThis file is written by the AI agent across sessions. Edit freely.\n";

function entry(date: string, body: string): string {
  return `\n## ${date} (session: s-test)\n${body}\n`;
}

function entryLine(date: string): string {
  return `- knowledge from ${date}`;
}

describe("capMemoryForPrompt", () => {
  it("returns short content whole", () => {
    const content = `${HEADER}${entry("2026-08-17", entryLine("2026-08-17"))}`;
    expect(capMemoryForPrompt(content, "C:/mem/MEMORY.md")).toBe(content);
  });

  it("keeps the NEWEST entries when the file outgrows the cap", () => {
    // Build a file whose 2026-08-17 entries alone exceed the byte cap, then
    // append a 2026-09-28 entry — the regression: head-loading showed only
    // the old block; tail-loading must show the new one.
    const oldBlock = Array.from({ length: 400 }, (_, i) =>
      entry(`2026-08-17T10:00:${String(i).padStart(2, "0")}`, entryLine(`2026-08-17 #${i} ${"x".repeat(60)}`)),
    ).join("");
    const newest = entry("2026-09-28T23:59:00.000Z", "- FIXED-THE-MEMORY-BUG");
    const content = HEADER + oldBlock + newest;

    const out = capMemoryForPrompt(content, "C:/mem/MEMORY.md");

    // The newest entry must be present — the whole point of the fix.
    expect(out).toContain("FIXED-THE-MEMORY-BUG");
    // Old-only loading (the bug) would never contain this.
    expect(out).toContain("2026-09-28");
    // Truncation notice names the full file for follow-up reads.
    expect(out).toContain("C:/mem/MEMORY.md");
    // Starts at an entry boundary after the notice.
    expect(out).toMatch(/\[kai-memory\][^\n]*\n\n## 2026-/);
    // Cap honored (notice overhead allowed).
    expect(out.length).toBeLessThanOrEqual(25 * 1024 + 400);
  });

  it("snaps the window start to a `## ` entry header", () => {
    // Realistic layout: entry headers throughout the body (every ~6 lines),
    // so the snap scan finds a boundary. The window must start at a header.
    const lines: string[] = [HEADER];
    for (let i = 0; i < 420; i++) {
      if (i % 6 === 0) lines.push(`## 2026-08-17T10:${String(i).padStart(3, "0")} (session: s)`);
      lines.push(`line ${i} ${"y".repeat(70)}`);
    }
    const out = capMemoryForPrompt(lines.join("\n"), "mem.md");
    const body = out.split("\n\n").slice(1).join("\n\n");
    expect(body.trimStart().startsWith("## ")).toBe(true);
    // Newest content present.
    expect(out).toContain("line 419");
  });

  it("keeps the newest lines when the file is long but byte-small", () => {
    // 300 tiny lines fit the byte cap — the whole file loads regardless of
    // the 200-line preference (bytes are the real constraint).
    const content = Array.from({ length: 300 }, (_, i) => `l${i}`).join("\n");
    const out = capMemoryForPrompt(content, "mem.md");
    expect(out).toContain("l299");
    expect(out).toContain("l0");
  });
});
