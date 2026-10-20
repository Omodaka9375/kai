import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * voice_settings tool — catalog contract + wiring + pref round-trip.
 *
 * Design pins (see voice.ts header):
 *  - NAMED voices only: no gender INPUT; gender lives in the catalog notes.
 *  - Core toolset (main agent + Telegram assistant), NOT subagents.
 *  - Auto-executes (low-risk preference write, same class as save_memory).
 */

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: async () => null,
    set: async () => {},
    save: async () => {},
  })),
}));
vi.mock("@tauri-apps/api/event", () => ({
  // writePref emits PREFS_CHANGED_EVENT; the preferences store subscribes
  // via onPreferencesChange and syncs. In the test environment there is no
  // Tauri event loop — wire the mock so a pref write lands in the store.
  emit: async (_event: string, payload: Record<string, unknown>) => {
    const { usePreferencesStore } = await import("@/modules/settings/preferences");
    usePreferencesStore.setState({
      [payload.key as string]: payload.value,
    } as Partial<Record<string, unknown>>);
  },
  listen: async () => () => {},
}));
vi.mock("@/modules/ai/lib/audit", () => ({
  auditAppend: vi.fn(),
  AUDIT_KINDS: { sandboxChange: "sandbox.change" },
}));

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("voice_settings source contracts", () => {
  const src = read("./voice.ts");

  it("has no gender INPUT — gender lives in the catalog notes", () => {
    // The input schema (between 'inputSchema:' and the closing of execute's
    // z.object) must not contain a gender field; the catalog may.
    const schemaStart = src.indexOf("inputSchema: z.object({");
    const schemaEnd = src.indexOf("}),\n      execute:");
    expect(schemaStart).toBeGreaterThan(-1);
    expect(schemaEnd).toBeGreaterThan(schemaStart);
    const schema = src.slice(schemaStart, schemaEnd);
    expect(schema).not.toMatch(/gender/);
    // The catalog carries gender notes for natural-language resolution.
    expect(src).toMatch(/gender:\s*"(male|female|neutral)"/);
  });

  it("is wired into the CORE toolset (main agent + assistant), not extended", () => {
    const toolsSrc = read("./tools.ts");
    expect(toolsSrc).toContain("...buildVoiceTools(ctx),");
    const coreIdx = toolsSrc.indexOf("export function buildCoreTools");
    const extIdx = toolsSrc.indexOf("export function buildExtendedTools");
    const wireIdx = toolsSrc.indexOf("...buildVoiceTools(ctx),");
    expect(wireIdx).toBeGreaterThan(coreIdx);
    expect(wireIdx).toBeLessThan(extIdx);
  });

  it("is excluded from subagent toolsets", () => {
    const subagentSrc = read("./subagent.ts");
    expect(subagentSrc).not.toContain("voice");
  });

  it("policy classifier rates it low-risk, no approval", async () => {
    const { getToolActionInfo } = await import("../lib/policy");
    const info = getToolActionInfo("voice_settings");
    expect(info.riskLevel).toBe("low");
    expect(info.requiresApproval).toBe(false);
  });

  it("audits every actual change", () => {
    expect(src).toMatch(
      /auditAppend\(\s*AUDIT_KINDS\.sandboxChange,\s*"voice"/,
    );
  });
});

describe("voice_settings behavior", () => {
  // Each test must see default prefs — a prior test's writes land in the
  // (test-global) preferences store and leak across tests.
  beforeEach(async () => {
    const { DEFAULT_PREFERENCES } = await import("@/modules/settings/store");
    const { usePreferencesStore } = await import(
      "@/modules/settings/preferences"
    );
    usePreferencesStore.setState({ ...DEFAULT_PREFERENCES });
  });

  const exec = async (args: Record<string, unknown>) => {
    const { buildVoiceTools } = await import("./voice");
    const tools = (await buildVoiceTools({} as never)) as unknown as Record<
      string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { execute: (a: any, o?: any) => Promise<any> }
    >;
    return (await tools.voice_settings.execute(args, {
      toolCallId: "test",
    })) as Record<string, unknown>;
  };

  it("returns current settings + catalogs with no input", async () => {
    const r = await exec({});
    expect(r.changed).toBeNull();
    expect(r.settings).toMatchObject({ mode: "off", apiVoice: "alloy" });
    const voices = r.openaiVoices as Array<Record<string, string>>;
    expect(Array.isArray(voices)).toBe(true);
    const genders = new Set(voices.map((v) => v.gender));
    // Gender resolution needs both notes present.
    expect(genders.has("male")).toBe(true);
    expect(genders.has("female")).toBe(true);
    expect(voices.some((v) => v.name === "nova" && v.gender === "female")).toBe(
      true,
    );
  });

  it("changes mode + voice and reports the effective settings (round-trip)", async () => {
    const r = await exec({ mode: "api", voice: "nova" });
    expect(r.changed).toEqual(["mode=api", "apiVoice=nova"]);
    expect(r.settings).toMatchObject({ mode: "api", apiVoice: "nova" });
    const { usePreferencesStore } = await import(
      "@/modules/settings/preferences"
    );
    expect(usePreferencesStore.getState().voiceTtsMode).toBe("api");
    expect(usePreferencesStore.getState().voiceTtsApiVoice).toBe("nova");
  });

  it("does not audit or change anything when values already match", async () => {
    const { auditAppend } = await import("@/modules/ai/lib/audit");
    vi.mocked(auditAppend).mockClear();
    // Default prefs: mode=off, apiVoice=alloy — re-setting the same values.
    const r = await exec({ mode: "off", voice: "alloy" });
    expect(r.changed).toBeNull();
    expect(auditAppend).not.toHaveBeenCalled();
  });
});