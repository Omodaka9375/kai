import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-contract pins for the Tool card (ai-elements/tool.tsx).
 *
 * The class this guards: a tool whose `input` carries large/streaming
 * content must never render the live-streamed input body — each streamed
 * token is a new input object, so the memo comparator fails per token,
 * React re-renders the whole body, and the browser re-lays-out a giant
 * text node per token. That froze the entire window until the run
 * finished (reported on run_subagent: its prompt embeds the full task
 * context, so the card was megabytes of text re-rendering per token).
 *
 * Fixes pinned here:
 *   1. run_subagent is in HEAVY_CONTENT_TOOLS — no live input body, no
 *      per-token re-render (the memo comparator uses the cheap summary).
 *   2. The bodies that DO render (prompt preview, final summary) are
 *      height-capped so one huge payload can't blow up layout.
 */

const src = readFileSync(new URL("./tool.tsx", import.meta.url), "utf8");

describe("Tool card streaming-input freeze guard", () => {
  it("run_subagent is in HEAVY_CONTENT_TOOLS (no per-token input re-render)", () => {
    // Extract the set literal so a stray mention elsewhere can't satisfy it.
    const m = src.match(/const HEAVY_CONTENT_TOOLS = new Set\(\[([\s\S]*?)\]\)/);
    expect(m).not.toBeNull();
    const setBody = m?.[1] ?? "";
    for (const name of ["write_file", "edit", "multi_edit", "todo_write", "run_subagent"]) {
      expect(setBody).toContain(`"${name}"`);
    }
  });

  it("the heavy-tools memo comparator never falls back to raw input compare", () => {
    // The comparator must short-circuit on summary for heavy tools BEFORE
    // any `a.input === b.input` fallback — otherwise streamed inputs leak
    // through when summaries coincide.
    const cmp = src.split("export const Tool = memo")[1] ?? "";
    expect(cmp).toContain("HEAVY_CONTENT_TOOLS.has(a.toolName)");
    expect(cmp).toMatch(/return deriveSummary[\s\S]*===[\s\S]*deriveSummary/);
  });

  it("rendered run_subagent bodies are height-capped", () => {
    const prompt = src.split('if (toolName === "run_subagent")')[1] ?? "";
    // Input preview: prompt div.
    expect(prompt).toMatch(
      /max-h-40 overflow-y-auto whitespace-pre-wrap/,
    );
    // Output renderer: summary div.
    const out = src.split("function renderToolOutput")[1] ?? "";
    expect(out).toMatch(
      /max-h-40 overflow-y-auto whitespace-pre-wrap/,
    );
  });
});