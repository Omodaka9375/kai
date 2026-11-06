import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * SOURCE PINS for the 2026-11-06 report: "project actively working and
 * lagging made my clicks delayed... causing me to click twice on a
 * hamburger menu option... then after a second I get Unhandled rejection:
 * a webview with label `settings-models` already exists".
 *
 * Mechanism pinned here: open_settings_window (Rust) had a TOCTOU between
 * get_webview_window(label) and WebviewWindowBuilder::build - two rapid
 * clicks both saw "no window" and the second build crashed with the
 * duplicate-label error, which surfaced as an unhandled promise rejection
 * (every call site is `void openSettingsWindow(...)`).
 *
 * Behavior is Rust-side (not unit-testable from vitest); these pins hold
 * both halves of the fix: the Rust lock serialization and the frontend
 * wrapper's never-reject contract.
 */
describe("settings window open race (source pins)", () => {
  const wrapper = readFileSync(
    new URL("./openSettingsWindow.ts", import.meta.url),
    "utf8",
  );
  const lib = readFileSync(
    new URL("../../../src-tauri/src/lib.rs", import.meta.url),
    "utf8",
  );

  it("Rust serializes opens: check-and-build under one lock", () => {
    // The lock exists and is held before the get_webview_window check.
    expect(lib).toContain("static OPEN_SETTINGS_LOCK: Mutex<()> = Mutex::new(());");
    expect(lib).toContain("let _open_guard = mutex_lock(&OPEN_SETTINGS_LOCK);");
    // The guard is taken BEFORE the existing-window check, not after.
    const guardIdx = lib.indexOf("let _open_guard = mutex_lock(&OPEN_SETTINGS_LOCK);");
    const checkIdx = lib.indexOf("if let Some(window) = app.get_webview_window(&label) {");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(guardIdx);
  });

  it("Rust logs failed window builds (the only diagnosable trail now)", () => {
    expect(lib).toContain("log::warn!(\"settings window '{label}' build failed: {e}\");");
  });

  it("the frontend wrapper NEVER rejects (no unhandled rejection can escape)", () => {
    expect(wrapper).toContain('invoke("open_settings_window", { tab: tab ?? null }).catch((e)');
    expect(wrapper).toContain("failed to open settings window:");
  });
});
