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
    for (const name of ["write_file", "edit", "batch_edit", "todo_write", "run_subagent"]) {
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

describe("foreground command cancellation", () => {
  it("offers a direct Stop action only while bash_run is executing", () => {
    expect(src).toContain('toolName === "bash_run" && state === "input-available"');
    expect(src).toContain("title=\"Stop this command\"");
    expect(src).toContain("stopCommand(sessionId)");
    expect(src).toContain("Stopping…");
    // The action must not be nested inside CollapsibleTrigger, or clicking
    // Stop would also expand/collapse the command output.
    const triggerEnd = src.indexOf("</CollapsibleTrigger>");
    const stop = src.indexOf('title="Stop this command"');
    expect(stop).toBeGreaterThan(triggerEnd);
  });
});

/**
 * Big-text readability (the web_browse "one giant \n-escaped line" class).
 *
 * The default object renderer used to be JSON.stringify(output, null, 2).
 * That pretty-prints the OUTER object but keeps every string VALUE a JSON
 * literal, so a tool returning a large multi-line text field (web_browse's
 * `content`, any MCP tool's `text`/`stdout`) rendered as a single kilobyte
 * line of \n escapes — unreadable. The fix routes those through
 * formatToolOutput, which splits big text fields out to print verbatim.
 * These pins fail if someone reverts a generic branch to a raw stringify.
 */
describe("tool output big-text readability", () => {
  it("formatToolOutput hoists any newline-bearing / long string field", () => {
    const fn = src.split("function formatToolOutput")[1] ?? "";
    // A field qualifies as "big text" by containing a newline OR exceeding
    // a length threshold; both conditions must gate the split.
    expect(fn).toMatch(/includes\("\\n"\)/);
    expect(fn).toMatch(/BIG_TEXT_MIN/);
    // When no big text exists it must fall back to the original pretty JSON
    // (so small {ok,path,size} outputs are unchanged).
    expect(fn).toContain("JSON.stringify(o, null, 2)");
  });

  it("every generic output branch routes through formatToolOutput (no raw dump)", () => {
    // The body renderer (string-parsed + object) and the MCP structured/text
    // branches all call the helper; none may call JSON.stringify(x, null, 2)
    // directly on a tool result again.
    const renderer =
      src.split("function ToolOutput(")[1]?.split(
        "function formatToolOutput",
      )[0] ?? "";
    const mcp =
      src.split("function renderToolOutput")[1]?.split(
        'toolName === "run_subagent"',
      )[0] ?? "";
    // 4 call sites: object output, parsed-string, MCP structured, MCP text.
    const calls = [...(renderer + mcp).matchAll(/formatToolOutput\(/g)].length;
    expect(calls).toBeGreaterThanOrEqual(4);
    // And the raw dump is gone from these generic paths.
    expect(renderer).not.toMatch(/JSON\.stringify\(\s*output\s*,\s*null\s*,\s*2\s*\)/);
    expect(mcp).not.toMatch(/JSON\.stringify\(\s*structured\s*,\s*null\s*,\s*2/);
  });
});