import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Close-to-tray contract (2026-10-31).
 *
 * Product ask: closing the KAI window must MINIMIZE TO TRAY (process stays
 * alive so the assistant and long-running agents keep working); the ONLY
 * true quit is the tray menu's "Quit KAI". Implemented as:
 *
 *  - Rust modules/tray.rs: tray icon + menu (Show / Quit KAI), created
 *    ALWAYS in setup (a hidden process with no tray is unreachable), and an
 *    on_window_event CloseRequested backstop that hides the main window
 *    even when the webview can't answer (crash / dev-server down).
 *  - main.tsx: onCloseRequested → preventDefault + hide (the normal path).
 *  - tray.rs quit: app.exit(0) — bypasses CloseRequested, so it actually
 *    exits (window.close() would be intercepted by the guard and do nothing).
 *  - capabilities: core:window:allow-hide for the JS guard.
 *  - Linux: libayatana-appindicator build + runtime deps for the tray.
 *
 * These pins keep every half in lockstep — the tray module was verified
 * against the user-visible contract, so a rename that orphans a menu id or
 * a guard that silently quits must fail CI.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("frontend close guard (main.tsx)", () => {
  const main = read("../main.tsx");

  it("closing the window prevents the close and hides instead", () => {
    expect(main).toContain("onCloseRequested");
    expect(main).toContain("event.preventDefault()");
    expect(main).toMatch(/await w\.hide\(\)/);
  });

  it("the guard is installed unconditionally and never unlistened", () => {
    // The Rust backstop covers a crashed webview; the JS guard must not be
    // conditional on prefs or project state — close-to-tray is core.
    expect(main).not.toMatch(/if[^{]*\{\s*const unlisten = w\.onCloseRequested/);
    expect(main).toContain("// Never unlisten — the guard lives for the whole window lifetime.");
  });
});

describe("Rust tray + close backstop (modules/tray.rs)", () => {
  const tray = read("../../src-tauri/src/modules/tray.rs");

  it("the tray menu offers Show KAI and Quit KAI", () => {
    expect(tray).toContain('"Show KAI"');
    expect(tray).toContain('"Quit KAI"');
  });

  it("quit calls app.exit(0), NOT window.close (which the guard would swallow)", () => {
    expect(tray).toContain("app.exit(0)");
    // window.close() emits CloseRequested — the hide guard would intercept
    // it and Quit would silently do nothing. Only app.exit truly exits.
    expect(tray).not.toMatch(/\bwin\.close\(\)/);
    expect(tray).not.toMatch(/window\.close\(\)/);
  });

  it("show reopens, unminimizes, and focuses the main window", () => {
    expect(tray).toMatch(/"show" => \{[\s\S]*?win\.show\(\)/);
    expect(tray).toMatch(/"show" => \{[\s\S]*?win\.unminimize\(\)/);
    expect(tray).toMatch(/"show" => \{[\s\S]*?win\.set_focus\(\)/);
  });

  it("the close backstop only guards the main window (settings close for real)", () => {
    expect(tray).toContain('if label != "main"');
    expect(tray).toContain("api.prevent_close()");
    expect(tray).toMatch(/prevent_close\(\);[\s\S]*?win\.hide\(\)/);
  });

  it("first-hide notification is one-shot per process", () => {
    expect(tray).toContain("NOTIFIED_HIDE");
    expect(tray).toContain("swap(true");
  });
});

describe("wiring", () => {
  it("the backstop is installed on the builder (lib.rs)", () => {
    const lib = read("../../src-tauri/src/lib.rs");
    expect(lib).toContain("on_window_event");
    expect(lib).toMatch(/WindowEvent::CloseRequested \{ api, \.\. \}/);
    expect(lib).toContain("tray::on_window_close_requested");
    // Tray created ALWAYS — not preference-gated (a hidden process with no
    // tray icon is unreachable).
    expect(lib).toContain("tray::install(&app.handle().clone())");
  });

  it("the tray-icon feature is enabled and hide is permitted", () => {
    const cargo = read("../../src-tauri/Cargo.toml");
    expect(cargo).toContain('"tray-icon"');
    const caps = read("../../src-tauri/capabilities/default.json");
    expect(caps).toContain('"core:window:allow-hide"');
  });

  it("Linux tray deps are declared (build + runtime)", () => {
    const ci = read("../../.github/workflows/ci.yml");
    expect(ci).toContain("libayatana-appindicator3-dev");
    const release = read("../../.github/workflows/release.yml");
    expect(release).toContain("libayatana-appindicator3-dev");
    const conf = JSON.parse(
      read("../../src-tauri/tauri.conf.json") as unknown as string,
    ) as { bundle: { linux: { deb: { depends: string[] }; rpm: { depends: string[] } } } };
    expect(conf.bundle.linux.deb.depends).toContain(
      "libayatana-appindicator3-1",
    );
    expect(conf.bundle.linux.rpm.depends).toContain(
      "libayatana-appindicator3",
    );
  });
});
