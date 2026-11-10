import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source pin: the MCP transport close() teardown order (2026-11-10 crash).
 *
 * Reported crash: toggling an MCP server off in Settings froze the app with
 * an uncaught "TypeError: Cannot read properties of undefined (reading
 * 'call')" pointing into the shared chunk (focusModality-*.js). The
 * crashing frame is Tauri's Channel class: it invokes the stored onmessage
 * handler with `handler.call(this, msg)` and NO null check, and rethrows any
 * throw via queueMicrotask — i.e. as an UNCAUGHT error, which WebView2
 * renders as the pane-wide crash overlay.
 *
 * Root cause: TauriStdioTransport.close() assigned
 * `channel.onmessage = undefined` while mcp_stdio_close was concurrently
 * killing the child process — Rust's reader threads were still emitting the
 * final stderr/exit burst through the channel. `undefined.call` = TypeError.
 *
 * The fix has two invariants this file pins:
 *   1. The handler is swapped to a NOOP *BEFORE* mcp_stdio_close runs
 *      (kill first would re-arm the race for the trailing-event window).
 *   2. NOTHING ever assigns `undefined`/`null` to a live Channel's
 *      onmessage anywhere in the codebase.
 */
const src = readFileSync(new URL("./mcpManager.ts", import.meta.url), "utf8");

describe("MCP stdio transport close() teardown safety", () => {
  it("never assigns undefined/null to a Channel onmessage handler", () => {
    // The exact crash line, byte-for-byte, must not come back.
    expect(src).not.toMatch(/onmessage\s*=\s*(undefined|null|void 0)/);
  });

  it("swaps the handler to a noop BEFORE invoking mcp_stdio_close", () => {
    const noopAt = src.indexOf("this.channel.onmessage = () => {}");
    const closeAt = src.indexOf('invoke("mcp_stdio_close"');
    expect(noopAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(-1);
    expect(noopAt).toBeLessThan(closeAt);
  });

  it("guards against double-close (closed flag short-circuits)", () => {
    expect(src).toMatch(/if \(this\.closed\) return;\s*this\.closed = true;/);
  });

  it("Rust teardown still runs exactly once per close", () => {
    const invokes = src.match(/invoke\("mcp_stdio_close"/g) ?? [];
    expect(invokes.length).toBe(1);
  });
});
