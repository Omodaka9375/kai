import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-contract tests for the Assistant model picker wiring (the project's
 * established pattern for UI surfaces — no jsdom/testing-library in the
 * tree). Three links must hold for the feature to work end-to-end:
 *
 *   1. The Assistant panel passes prefs.modelId to the picker and persists
 *      the selection (including null = follow default).
 *   2. The picker offers a null escape ("Follow default") and disables
 *      keyless providers — never renders an unreachable selection dead end.
 *   3. runAssistantTurn actually consumes the override and falls back to
 *      DEFAULT_MODEL_ID when null.
 */

const panel = readFileSync(
  new URL("../sections/ExternalSection.tsx", import.meta.url),
  "utf8",
);
const picker = readFileSync(new URL("./SearchableModelPicker.tsx", import.meta.url), "utf8");
const assistant = readFileSync(
  new URL("../../modules/assistant/index.ts", import.meta.url),
  "utf8",
);

describe("Assistant panel ↔ picker wiring", () => {
  it("passes prefs.modelId to the SearchableModelPicker", () => {
    expect(panel).toContain("SearchableModelPicker");
    expect(panel).toMatch(/value=\{prefs\.modelId\}/);
  });

  it("persists the selection through patch — null must round-trip (follow default)", () => {
    expect(panel).toMatch(/patch\(\{ modelId: id \}\)/);
  });

  it("renders the picker inside a SettingRow titled Model", () => {
    expect(panel).toMatch(/title="Model"/);
  });
});

describe("SearchableModelPicker contract", () => {
  it("offers a null escape hatch (Follow default)", () => {
    expect(picker).toMatch(/onChange\(null\)/);
    expect(picker).toMatch(/value == null/);
  });

  it("disables models whose provider has no key (same gating as Models section)", () => {
    expect(picker).toContain("providerNeedsKey");
    expect(picker).toContain("disabled={!available}");
    expect(picker).toContain("no key");
  });

  it("reads key availability from the keyring, refreshed on open", () => {
    expect(picker).toContain("getAllKeys");
  });

  it("labels a registry miss with the raw id instead of crashing", () => {
    expect(picker).toMatch(/MODELS\.find\(\(x\) => x\.id === value\)/);
    expect(picker).toContain("Unknown");
  });
});

describe("Assistant panel load-cost contract (the ~1min open bug)", () => {
  it("never statically imports the heavy assistant barrel", () => {
    // The barrel (@/modules/assistant → index.ts) drags in the ENTIRE AI
    // runtime (agent stack, @ai-sdk providers, buildTools, mcpManager,
    // voiceTts) — hundreds of unbundled ESM round-trips in dev, which made
    // the Assistant panel take ~a minute to open. The panel statically
    // imports ONLY the light prefs module; bridge functions are dynamic.
    expect(panel).not.toMatch(/from\s+"@\/modules\/assistant"/);
    expect(panel).not.toMatch(/from\s+"@\/modules\/assistant\/index"/);
  });

  it("imports the light prefs surface statically", () => {
    expect(panel).toMatch(/from "@\/modules\/assistant\/prefs"/);
  });

  it("loads the bridge functions dynamically at call time", () => {
    expect(panel).toMatch(/await import\("@\/modules\/assistant"\)/);
  });

  it("prefs.ts imports no AI runtime (tauri core + config registry only)", () => {
    const prefs = readFileSync(
      new URL("../../modules/assistant/prefs.ts", import.meta.url),
      "utf8",
    );
    // Only import statements count — the header comment legitimately NAMES
    // the modules this file avoids (don't substring-match the whole file).
    const imports = prefs.match(/^import .*$/gm)?.join("\n") ?? "";
    expect(imports).not.toMatch(/@ai-sdk\//);
    expect(imports).not.toMatch(/buildTools|mcpManager|voiceTts|generateText|lib\/agent/);
    expect(imports).toContain("@tauri-apps/api/core");
  });
});

describe("assistant runtime honors the override", () => {
  it("null follows the USER'S default model, not the hardcoded constant", () => {
    // The picker's "Follow default" entry promises Settings → Models →
    // Default model. The runtime must read the live preferences store
    // (kept current cross-window by Kai://prefs-changed), not the registry
    // constant — otherwise the label lies for anyone whose default ≠
    // DEFAULT_MODEL_ID.
    expect(assistant).toMatch(
      /const modelId = \(prefs\.modelId as ModelId \| null\) \?\?/,
    );
    expect(assistant).toContain("usePreferencesStore.getState().defaultModelId");
    // And must NOT silently fall back to the hardcoded constant.
    expect(assistant).not.toContain("?? DEFAULT_MODEL_ID");
  });
});
