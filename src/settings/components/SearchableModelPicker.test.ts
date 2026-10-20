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
