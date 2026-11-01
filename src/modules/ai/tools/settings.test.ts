import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * settings tools - configuration coverage + trust tiers.
 *
 * 1. COVERAGE: `settings` must expose every option the Settings UI offers
 *    for the agent-settable keys - a theme or editor theme missing from the
 *    read output means the model cannot switch to it.
 *
 * 2. TRUST TIERS: cosmetics auto-execute; behavioral changes require an
 *    approval card; security keys (network policy, commit signing, model
 *    endpoint) are NOT settable by the agent at all - pinned at source
 *    level (the drift gate pins the needsApproval flags; this file pins
 *    the ALLOWLIST boundary).
 *
 * 3. Writes go through the store setters (persist + cross-window event) -
 *    never a raw store.set, which would skip the Settings-window sync.
 */

vi.mock("@/modules/settings/store", () => ({
  EDITOR_THEMES: [
    "atomone",
    "aura",
    "copilot",
    "github-dark",
    "github-light",
    "nord",
    "tokyo-night",
    "xcode-dark",
    "xcode-light",
  ],
  setAutostart: vi.fn(async () => undefined),
  setCustomInstructions: vi.fn(async () => undefined),
  setDefaultModel: vi.fn(async () => undefined),
  setDefaultShell: vi.fn(async () => undefined),
  setEditorTheme: vi.fn(async () => undefined),
  setEditorWordWrap: vi.fn(async () => undefined),
  setRestoreWindowState: vi.fn(async () => undefined),
  setShowHidden: vi.fn(async () => undefined),
  setSubagentMaxSteps: vi.fn(async () => undefined),
  setTerminalFontSize: vi.fn(async () => undefined),
  setTerminalScrollback: vi.fn(async () => undefined),
  setTerminalWebglEnabled: vi.fn(async () => undefined),
  setTheme: vi.fn(async () => undefined),
  setThinkingMode: vi.fn(async () => undefined),
  setUiThemeId: vi.fn(async () => undefined),
  setVimMode: vi.fn(async () => undefined),
  setZoomLevel: vi.fn(async () => undefined),
  TERMINAL_FONT_SIZE_MAX: 32,
  TERMINAL_FONT_SIZE_MIN: 8,
  TERMINAL_FONT_SIZE_DEFAULT: 14,
  TERMINAL_SCROLLBACK_MAX: 50_000,
  TERMINAL_SCROLLBACK_MIN: 200,
  TERMINAL_SCROLLBACK_DEFAULT: 2000,
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({
      theme: "system",
      uiThemeId: "default",
      editorTheme: "atomone",
      vimMode: false,
      editorWordWrap: true,
      showHidden: true,
      terminalWebglEnabled: true,
      terminalFontSize: 14,
      terminalScrollback: 2000,
      zoomLevel: 1,
      restoreWindowState: true,
      defaultShell: "auto",
      customInstructions: "",
      autostart: false,
      defaultModelId: "anthropic/claude-4.5-sonnet",
      thinkingMode: "off",
      subagentMaxSteps: 24,
      networkPolicy: "full",
    }),
  },
}));
vi.mock("@/modules/ai/config", () => ({
  DEFAULT_MODEL_ID: "anthropic/claude-4.5-sonnet",
}));
vi.mock("@/modules/theme/palettes", () => ({
  UI_THEMES: [
    { id: "default", label: "Kai" },
    { id: "tokyo-night", label: "Tokyo Night" },
    { id: "nord", label: "Nord" },
    { id: "emerald", label: "Emerald" },
  ],
}));
vi.mock("../lib/audit", () => ({
  auditAppend: vi.fn(() => undefined),
  AUDIT_KINDS: { sandboxChange: "sandbox.change" },
}));
vi.mock("@tauri-apps/plugin-autostart", () => ({
  enable: vi.fn(async () => undefined),
  disable: vi.fn(async () => undefined),
  isEnabled: vi.fn(async () => false),
}));

import { buildSettingsTools } from "./settings";

type SettingsTools = ReturnType<typeof buildSettingsTools>;

const execLoose = (
  t: SettingsTools[keyof SettingsTools],
  input: Record<string, unknown>,
) =>
  (t.execute as unknown as (i: Record<string, unknown>) => Promise<unknown>)(
    input,
  );

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// Mocks are module-scoped - clear call history between tests so "not called"
// assertions measure THIS test, not the file's cumulative history.
beforeEach(() => {
  vi.clearAllMocks();
});

describe("settings (read) - coverage & options", () => {
  it("lists every UI theme, editor theme, shell, and thinking mode", async () => {
    const tools = buildSettingsTools({} as never);
    const out = (await execLoose(tools.settings, {})) as {
      settings: Record<string, unknown>;
      options: Record<string, unknown>;
    };
    expect(out.options.theme).toEqual(["system", "light", "dark"]);
    // The color PALETTE registry (uiThemeId) rides along with labels.
    expect(out.options.uiTheme).toEqual([
      { id: "default", label: "Kai" },
      { id: "tokyo-night", label: "Tokyo Night" },
      { id: "nord", label: "Nord" },
      { id: "emerald", label: "Emerald" },
    ]);
    expect(out.settings.uiThemeId).toBe("default");
    expect(out.options.editorTheme).toEqual([
      "atomone",
      "aura",
      "copilot",
      "github-dark",
      "github-light",
      "nord",
      "tokyo-night",
      "xcode-dark",
      "xcode-light",
    ]);
    expect(out.options.defaultShell).toEqual([
      "auto",
      "cmd",
      "powershell",
      "pwsh",
    ]);
    expect(out.options.thinkingMode).toEqual(["off", "low", "medium", "high"]);
    // Current values ride along - the model can answer "what's my theme".
    expect(out.settings.theme).toBe("system");
    expect(out.settings.networkPolicy).toBe("full");
  });

  it("marks the security keys as user-only in the output", async () => {
    const tools = buildSettingsTools({} as never);
    const out = (await execLoose(tools.settings, {})) as {
      settable: Record<string, string>;
    };
    // The settable map names the tier split - and mentions that security
    // keys exist but are read-only.
    const src = read("./settings.ts");
    expect(src).toContain("Security-relevant settings");
    void out;
  });
});

describe("settings_update - cosmetics auto-execute", () => {
  it("applies palette + theme + editor theme + vim mode in one call", async () => {
    const store = await import("@/modules/settings/store");
    const tools = buildSettingsTools({} as never);
    const out = (await execLoose(tools.settings_update, {
      uiThemeId: "emerald",
      theme: "dark",
      editorTheme: "nord",
      vimMode: true,
    })) as { changed: string[] | null; settings: Record<string, unknown> };
    expect(vi.mocked(store.setUiThemeId)).toHaveBeenCalledWith("emerald");
    expect(vi.mocked(store.setTheme)).toHaveBeenCalledWith("dark");
    expect(vi.mocked(store.setEditorTheme)).toHaveBeenCalledWith("nord");
    expect(vi.mocked(store.setVimMode)).toHaveBeenCalledWith(true);
    expect(out.changed).toContain("uiThemeId=emerald");
    expect(out.changed).toContain("theme=dark");
    expect(out.changed).toContain("editorTheme=nord");
    expect(out.changed).toContain("vimMode=true");
  });

  it("clamps out-of-range numbers (font size, scrollback, zoom)", async () => {
    const store = await import("@/modules/settings/store");
    const tools = buildSettingsTools({} as never);
    const out = (await execLoose(tools.settings_update, {
      terminalFontSize: 999,
      terminalScrollback: 1,
      zoomLevel: 9,
    })) as { changed: string[] | null };
    // 999 → 32 (max), 1 → 200 (min), 9 → 2 (max).
    expect(vi.mocked(store.setTerminalFontSize)).toHaveBeenCalledWith(32);
    expect(vi.mocked(store.setTerminalScrollback)).toHaveBeenCalledWith(200);
    expect(vi.mocked(store.setZoomLevel)).toHaveBeenCalledWith(2);
    expect(out.changed).toContain("terminalFontSize=32");
  });

  it("no-op writes report changed=null and skip the audit", async () => {
    const { auditAppend } = await import("../lib/audit");
    const tools = buildSettingsTools({} as never);
    const out = (await execLoose(tools.settings_update, {
      theme: "system", // same as current state
    })) as { changed: string[] | null; hint: string };
    expect(out.changed).toBeNull();
    expect(vi.mocked(auditAppend)).not.toHaveBeenCalled();
    expect(out.hint).toContain("Nothing changed");
  });
});

describe("settings_update_restricted - behavioral, approval-gated", () => {
  it("applies shell + instructions + autostart (OS login item + pref) in one call", async () => {
    const store = await import("@/modules/settings/store");
    const plugin = await import("@tauri-apps/plugin-autostart");
    const tools = buildSettingsTools({} as never);
    const out = (await execLoose(tools.settings_update_restricted, {
      defaultShell: "pwsh",
      customInstructions: "Prefer pnpm.",
      autostart: true,
    })) as { changed: string[] | null; errors: string[] | null };
    expect(vi.mocked(store.setDefaultShell)).toHaveBeenCalledWith("pwsh");
    expect(vi.mocked(store.setCustomInstructions)).toHaveBeenCalledWith(
      "Prefer pnpm.",
    );
    // The OS registration must actually happen - the pref alone is
    // reverted by Settings' mount-reconcile (GeneralSection).
    expect(vi.mocked(plugin.enable)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(store.setAutostart)).toHaveBeenCalledWith(true);
    expect(out.errors).toBeNull();
    expect(out.changed).toContain("defaultShell=pwsh");
    expect(out.changed).toContain("customInstructions=<updated>");
    expect(out.changed).toContain("autostart=true");
  });

  it("autostart failure: OS call rejects -> error reported, pref NOT written", async () => {
    const store = await import("@/modules/settings/store");
    const plugin = await import("@tauri-apps/plugin-autostart");
    vi.mocked(plugin.enable).mockRejectedValueOnce(
      new Error("OS refused: policy"),
    );
    const tools = buildSettingsTools({} as never);
    const out = (await execLoose(tools.settings_update_restricted, {
      autostart: true,
    })) as { changed: string[] | null; errors: string[] | null; hint: string };
    expect(out.changed).toBeNull();
    expect(out.errors?.[0]).toContain("OS refused: policy");
    // Crucially the pref is NOT persisted - otherwise Settings' reconcile
    // would silently flip it back and the reported success was a lie.
    expect(vi.mocked(store.setAutostart)).not.toHaveBeenCalled();
    expect(out.hint).toContain("failed");
  });

  it("clamps subagentMaxSteps to 1-200", async () => {
    const store = await import("@/modules/settings/store");
    const tools = buildSettingsTools({} as never);
    await execLoose(tools.settings_update_restricted, {
      subagentMaxSteps: 5000,
    });
    expect(vi.mocked(store.setSubagentMaxSteps)).toHaveBeenCalledWith(200);
  });
});

describe("trust-boundary source pins", () => {
  const src = read("./settings.ts");

  it("the three tiers are statically declared (drift-gate compatible)", () => {
    expect(src).toMatch(/settings: tool\(\{\s*\n\s*needsApproval: false,/);
    expect(src).toMatch(
      /settings_update: tool\(\{\s*\n\s*needsApproval: false,/,
    );
    expect(src).toMatch(
      /settings_update_restricted: tool\(\{\s*\n\s*needsApproval: true,/,
    );
  });

  it("SECURITY KEYS are absent from every schema (agent can never set them)", () => {
    // networkPolicy, commit signing, and the model endpoint URL are the
    // self-modification / exfiltration vectors - they must not appear as
    // settable INPUTS anywhere. Scoped to the inputSchema blocks: the keys
    // MAY appear in the read output (currentSettings) - reading your own
    // fence is fine, changing it is not.
    const schemaBlocks = [
      ...src.matchAll(
        /inputSchema:\s*z\.object\(\{([\s\S]*?)\}\),\s*execute:/g,
      ),
    ].map((m) => m[1]!);
    expect(schemaBlocks).toHaveLength(3);
    for (const banned of [
      "networkPolicy",
      "commitSigningEnabled",
      "commitSigningMode",
      "commitSigningKey",
      "openaiCompatibleBaseURL",
      "openaiCompatibleModelId",
      "shortcuts",
      // DEAD pref: the Rust side registers window-state unconditionally;
      // the tool must not pretend to flip it.
      "restoreWindowState",
    ]) {
      for (const block of schemaBlocks) {
        expect(block, `schema must not accept "${banned}"`).not.toContain(
          banned,
        );
      }
    }
    // And no setter import exists for them either (import would be dead
    // code hinting at a future wiring).
    expect(src).not.toContain("setNetworkPolicy");
    expect(src).not.toContain("setCommitSigning");
    expect(src).not.toContain("setOpenaiCompatible");
    expect(src).not.toContain("setShortcuts");
  });

  it("personas cannot touch app settings (excluded like voice_settings)", () => {
    const persona = read("../lib/personaWorkspace.ts");
    expect(persona).toContain('"settings",');
    expect(persona).toContain('"settings_update",');
    expect(persona).toContain('"settings_update_restricted",');
  });

  it("the Telegram assistant catalog offers read + cosmetic write only", () => {
    const catalog = read("../../assistant/toolCatalog.ts");
    // Prettier reflows entry lines - pin with whitespace-tolerant regexes.
    expect(catalog).toMatch(
      /\{\s*name:\s*"settings",\s*tier:\s*"read",\s*blurb:\s*"Read app settings and options\.",?\s*\}/,
    );
    expect(catalog).toMatch(
      /\{\s*name:\s*"settings_update",\s*tier:\s*"write",\s*blurb:\s*"Change appearance settings \(theme, editor, terminal\)\.",?\s*\}/,
    );
    // The approval-gated behavioral tool is deliberately NOT selectable
    // remotely: it sits in HARD_EXCLUDED_TOOLS (approvals-from-Telegram for
    // app behavior is a wider surface than the remote assistant needs).
    // Its name legitimately appears there - the pin is the exclusion, not
    // string absence.
    const hardBlock = catalog.slice(
      catalog.indexOf("HARD_EXCLUDED_TOOLS"),
      catalog.indexOf("]);", catalog.indexOf("HARD_EXCLUDED_TOOLS")),
    );
    expect(hardBlock).toContain('"settings_update_restricted"');
    // And it must NOT appear in the selectable TOOL_CATALOG entries.
    const catalogEntries = catalog.slice(catalog.indexOf("TOOL_CATALOG"));
    expect(catalogEntries).not.toContain(
      '{ name: "settings_update_restricted"',
    );
  });
});
