import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Start-hidden at login (2026-11-02): the autostart registration carries
 * `--hidden`; a login launch stays in the tray (process fully alive —
 * agents/assistant/PTYs keep working; tray "Show KAI" restores the window),
 * while a manual launch never passes the flag and shows normally.
 *
 * Source pins because the behavior spans process argv → plugin config →
 * first-paint gating, none of which is unit-testable without booting the
 * real window lifecycle.
 */

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");
const rust = read("../../src-tauri/src/lib.rs");
const entry = read("../main.tsx");

describe("start-hidden-at-login wiring (source pins)", () => {
  it("the autostart registration carries --hidden on every platform", () => {
    // The flag rides the registration verbatim: HKCU Run value on Windows,
    // LaunchAgent ProgramArguments on macOS, XDG Exec on Linux.
    expect(rust).toMatch(
      /tauri_plugin_autostart::Builder::new\(\)\s*\n\s*\.arg\("--hidden"\)/,
    );
  });

  it("launched_hidden is a registered command reading the process argv", () => {
    expect(rust).toMatch(
      /fn launched_hidden\(\) -> bool \{\s*\n\s*std::env::args\(\)\.any\(\|a\| a == "--hidden"\)/,
    );
    expect(rust).toMatch(/invoke_handler\(tauri::generate_handler!\[\s*\n\s*launched_hidden,/);
  });

  it("the first-paint show is gated on the probe, and a probe failure SHOWS (never strands the app invisible)", () => {
    // Gate: hidden ⇒ no showWindow timers; not hidden ⇒ both timers arm.
    expect(entry).toMatch(/invoke<boolean>\("launched_hidden"\)/);
    expect(entry).toMatch(/if \(!hidden\) \{/);
    // Fail-safe: a wedged IPC defaults to SHOWING.
    expect(entry).toMatch(/probe failed — showing window/);
    expect(entry).toMatch(/login launch: starting hidden in the tray/);
  });

  it("parse_launch_dir_from skips '-' args, so --hidden can never masquerade as a launch directory", () => {
    expect(rust).toMatch(/if arg\.starts_with\('-'\) \{\s*\n\s*continue;/);
  });
});
