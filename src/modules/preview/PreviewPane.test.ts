import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source-level regression test for the preview iframe's security attributes.
 * Rendering this component for real requires jsdom + a working
 * useImperativeHandle stub; for a focused security check we just verify the
 * static JSX still carries the sandbox/referrerPolicy attributes — if a
 * future change silently removes them, this test fails.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "PreviewPane.tsx"), "utf8");
const iframeMatch = src.match(/<iframe[\s\S]*?\/>/);
// Strip JSX comments (`// …` inside `{…}` and `{/* … */}` blocks) so the
// assertions only see actual attribute syntax — the source explains in a
// comment why `allow-top-navigation` is intentionally omitted, which we
// don't want to match.
const iframeJsx = (iframeMatch?.[0] ?? "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

describe("PreviewPane iframe sandbox", () => {
  it("declares an iframe in the source", () => {
    expect(iframeJsx).not.toBe("");
  });

  it("includes a sandbox attribute", () => {
    expect(iframeJsx).toMatch(/sandbox="[^"]*"/);
  });

  it("grants allow-scripts and allow-same-origin", () => {
    // These two are what makes a dev preview useful — strip either and dev
    // servers stop working.
    expect(iframeJsx).toMatch(/sandbox="[^"]*allow-scripts/);
    expect(iframeJsx).toMatch(/sandbox="[^"]*allow-same-origin/);
  });

  it("does NOT include allow-top-navigation* tokens", () => {
    // The whole point of sandboxing here: forbid the iframe from navigating
    // the parent Tauri webview to an attacker origin (which would expose
    // window.__TAURI__). Top-nav permissions must never be added.
    expect(iframeJsx).not.toMatch(/allow-top-navigation/);
  });

  it("does NOT include allow-popups-without-allow-popups-to-escape-sandbox combo", () => {
    // If popups are allowed, they MUST escape the sandbox cleanly — otherwise
    // a popup window inherits sandbox flags and we get hard-to-debug behavior.
    if (/allow-popups\b/.test(iframeJsx)) {
      expect(iframeJsx).toMatch(/allow-popups-to-escape-sandbox/);
    }
  });

  it("sets referrerPolicy to no-referrer", () => {
    expect(iframeJsx).toMatch(/referrerPolicy="no-referrer"/);
  });
});

describe("dev-server readiness gate (the connection-refused race)", () => {
  // Opening a preview right after starting a dev server raced the server's
  // boot: the iframe mounted instantly, got connection-refused, and the user
  // refreshed manually. The gate: local URLs POLL until the server answers,
  // showing a waiting state, then mount. Pins:
  const pane = src;

  it("probes with a no-cors fetch (rejects = refused, resolves = listening)", () => {
    expect(pane).toContain('await fetch(url, { mode: "no-cors", cache: "no-store" });');
  });

  it("gates ONLY pollable local hosts (localhost / 127.0.0.1 - CSP allows probing)", () => {
    expect(pane).toMatch(/u\.hostname === "localhost" \|\| u\.hostname === "127\.0\.0\.1"/);
  });

  it("waits, then times out with an actionable state", () => {
    expect(pane).toContain("WAIT_POLL_MS = 500");
    expect(pane).toContain("WAIT_MAX_ATTEMPTS = 90");
    expect(pane).toContain("ServerNeverCameUp");
  });

  it("manual reload skips the gate (explicit user intent)", () => {
    const reload = pane.split("useImperativeHandle")[1]?.split("}, [url],)")[0] ?? "";
    expect(reload).toContain('setPhase({ kind: "mount" })');
  });

  it("remote URLs and empty URLs mount directly (behavior unchanged)", () => {
    const gate = pane.split("// Readiness gate")[1]?.split("useImperativeHandle")[0] ?? "";
    expect(gate).toContain('if (!isPollableLocalHost(url))');
    expect(gate).toContain('setPhase({ kind: "mount" });');
  });
});
