import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * PANEL REACHABILITY CONTRACT — every registered Settings panel must be
 * reachable from the UI. Regression: the Security panel shipped fully wired
 * (TABS entry, Rust key allowlist, window title) but with NO menu item and
 * no other openSettingsWindow("security") call site — unreachable except by
 * hand-typing settings.html?tab=security.
 *
 * Two rules pinned here:
 *   1. The hamburger menu (Header.tsx) carries an entry for every tab in
 *      the canonical SettingsTab union. The menu is the app's only global
 *      navigation surface; a panel missing from it is invisible.
 *   2. The Rust window-state denylist covers every settings-* window label
 *      (panels are transient, always-centered — restoring saved geometry
 *      breaks that) — extracted from the same source of truth.
 */

const header = readFileSync(
  new URL("../modules/header/Header.tsx", import.meta.url),
  "utf8",
);
const tabsUnion = readFileSync(
  new URL("../modules/settings/openSettingsWindow.ts", import.meta.url),
  "utf8",
);
const libRs = readFileSync(
  new URL("../../src-tauri/src/lib.rs", import.meta.url),
  "utf8",
);

/** Every id in the SettingsTab union, extracted from the type source. */
const panelIds = Array.from(
  tabsUnion.matchAll(/\|\s*"([a-z]+)"/g),
  (m) => m[1]!,
).filter((id) => id !== "external"); // legacy alias, not a real panel

describe("settings panel reachability", () => {
  it("extracts the canonical panel set from the SettingsTab union", () => {
    expect(panelIds).toEqual(
      expect.arrayContaining([
        "general",
        "sandbox",
        "security",
        "models",
        "voice",
        "assistant",
        "about",
      ]),
    );
  });

  it("hamburger menu opens every registered panel", () => {
    for (const id of panelIds) {
      expect(
        header,
        `Header.tsx has no openSettingsWindow("${id}") — panel unreachable`,
      ).toContain(`openSettingsWindow("${id}")`);
    }
  });
});

describe("Rust settings-window plumbing", () => {
  it("window-state denylist covers every panel window label", () => {
    for (const id of panelIds) {
      expect(
        libRs,
        `lib.rs denylist is missing "settings-${id}"`,
      ).toContain(`"settings-${id}"`);
    }
  });

  it("panel key allowlist + title map cover every panel", () => {
    // Regression (2026-11-23): the Vault panel shipped with a TABS entry,
    // a SettingsTab union member, a menu item and a denylist line, but
    // settings_panel_key() did not list "vault" in its canonical matches!()
    // — every openSettingsWindow("vault") fell through to "general" and the
    // GENERAL window opened instead. Iterate every panel id against the
    // Rust allowlist and title map so a missing panel can never slip in
    // again (the old test pinned only sandbox/security literally).
    const allowList =
      libRs.match(/matches!\(\s*key\.as_str\(\),\s*((?:"[a-z]+"(?:\s*\|\s*)?)+)/)?.[1] ?? "";
    const allowEntries = Array.from(allowList.matchAll(/"([a-z]+)"/g), (m) => m[1]!);
    for (const id of panelIds) {
      expect(
        allowEntries,
        `lib.rs settings_panel_key allowlist is missing "${id}" — openSettingsWindow("${id}") would open General`,
      ).toContain(id);
      expect(
        libRs,
        `lib.rs settings_panel_title is missing "${id}"`,
      ).toMatch(new RegExp(`"${id}" => "`));
    }
  });
});

describe("capability permissions for panel features", () => {
  // Regression: the Security panel's "open audit folder" button shipped
  // dead — SecuritySection calls opener.openPath(), but the capability
  // only granted opener:default (URLs/reveal), so every click threw
  // "opener.open_path not allowed" into unhandledrejection.
  const securitySection = readFileSync(
    new URL("../settings/sections/SecuritySection.tsx", import.meta.url),
    "utf8",
  );
  const capabilities = readFileSync(
    new URL("../../src-tauri/capabilities/default.json", import.meta.url),
    "utf8",
  );

  it("openPath users are covered by the opener:allow-open-path permission", () => {
    const usesOpenPath =
      readFileSync(
        new URL("../modules/explorer/lib/contextActions.ts", import.meta.url),
        "utf8",
      ).includes("revealItemInDir") || securitySection.includes("openPath");
    if (usesOpenPath) {
      expect(capabilities).toContain("opener:allow-open-path");
    }
  });
});
