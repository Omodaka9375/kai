import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * voice_settings tool - engine-coverage contract.
 *
 * The tool is how a user switches voices/engines BY VOICE or chat ("use the
 * female voice", "switch to AssemblyAI"). It must expose EVERY TTS engine
 * the settings UI offers - a mode missing here means the agent cannot
 * switch to it and the user is stuck doing a Settings round-trip (exactly
 * what the tool exists to prevent).
 *
 * Engines (Settings > Voice mirrors this): off | api (OpenAI) |
 * assemblyai (AssemblyAI-TTS-1) | local (Piper).
 */

vi.mock("@/modules/settings/store", () => ({
  setVoiceTtsMode: vi.fn(async () => undefined),
  setVoiceTtsApiModel: vi.fn(async () => undefined),
  setVoiceTtsApiVoice: vi.fn(async () => undefined),
  setVoiceTtsAssemblyVoice: vi.fn(async () => undefined),
  setVoiceTtsLocalVoice: vi.fn(async () => undefined),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({
      voiceTtsMode: "api",
      voiceTtsApiVoice: "alloy",
      voiceTtsApiModel: "gpt-4o-mini-tts",
      voiceTtsAssemblyVoice: "",
      voiceTtsLocalVoice: "en_US-lessac-medium",
    }),
  },
}));
vi.mock("../lib/audit", () => ({
  auditAppend: vi.fn(() => undefined),
  AUDIT_KINDS: { sandboxChange: "sandbox.change" },
}));
vi.mock("../lib/assemblyai", () => ({
  ASSEMBLY_VOICES: [
    { id: "aai-jane", label: "Jane", note: "default" },
    { id: "aai-audrey", label: "Audrey", note: "even intonation" },
  ],
}));

import { buildVoiceTools } from "./voice";

/** The tool's execute is SDK-typed; tests call it loosely like other
 *  tool-contract tests do (input shape is pinned by the source pins). */
const executeLoose = (
  tool: ReturnType<typeof buildVoiceTools>["voice_settings"],
  input: Record<string, unknown>,
) =>
  (tool.execute as unknown as (i: Record<string, unknown>) => Promise<unknown>)(
    input,
  );

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("voice_settings engine coverage", () => {
  it("mode enum covers every settings-UI engine including assemblyai", async () => {
    const tools = buildVoiceTools({} as never);
    const out = (await executeLoose(tools.voice_settings, {})) as Record<string, unknown>;
    // List output includes the AssemblyAI catalog.
    expect(out.assemblyVoices).toBeDefined();
    const settings = out.settings as {
      mode: string;
      assemblyVoice?: string;
    };
    expect(settings.assemblyVoice).toBe("aai-jane");
  });

  it("switching to assemblyai mode + voice writes both prefs", async () => {
    const store = await import("@/modules/settings/store");
    const setMode = vi.mocked(store.setVoiceTtsMode);
    const setAssembly = vi.mocked(store.setVoiceTtsAssemblyVoice);
    const tools = buildVoiceTools({} as never);
    const out = (await executeLoose(tools.voice_settings, {
      mode: "assemblyai",
      assemblyVoice: "aai-audrey",
    })) as { changed: string[] | null };
    expect(setMode).toHaveBeenCalledWith("assemblyai");
    expect(setAssembly).toHaveBeenCalledWith("aai-audrey");
    expect(out.changed).toContain("mode=assemblyai");
    expect(out.changed).toContain("assemblyVoice=aai-audrey");
  });
});

describe("source pins", () => {
  const src = read("./voice.ts");

  it("the schema teaches the model all four modes", () => {
    expect(src).toContain('.enum(["off", "api", "assemblyai", "local"])');
    expect(src).toContain("'assemblyai' = AssemblyAI-TTS-1");
  });

  it("the description names the assemblyVoice parameter and slugs", () => {
    expect(src).toContain("assemblyVoice (an AssemblyAI voice like aai-jane");
    expect(src).toContain("aai-audrey) - pick from the listed catalog");
  });

  it("persona participants still cannot touch global voice (excluded)", () => {
    const persona = read("../lib/personaWorkspace.ts");
    expect(persona).toContain('"voice_settings",');
  });

  it("the Telegram assistant catalog still offers it (write tier, auto-run)", () => {
    const catalog = read("../../assistant/toolCatalog.ts");
    expect(catalog).toContain(
      '{ name: "voice_settings", tier: "write", blurb: "Change the reply voice / TTS." }',
    );
  });
});
