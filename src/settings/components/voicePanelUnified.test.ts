import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * VOICE PANEL UNIFICATION (2026-11-01).
 *
 * User ask: "In the voice settings panel, testing for local or API voice
 * looks a lot different. We should unify it so all the panels look alike
 * because they are right now quite different. So testing local model versus
 * testing some or picking a voice for some API model."
 *
 * Contract:
 *  - ONE skeleton component (VoiceEnginePanel) renders EVERY engine card:
 *    STT api/assemblyai/local/browser and TTS api/assemblyai/local — same
 *    bordered card, same row structure, same test row, same key warning.
 *  - The test affordance is IDENTICAL across engines: the STT cards get a
 *    "Test mic" button (new — the STT panels had NO test at all) and the TTS
 *    cards keep "Test voice", both via the shared VoiceTestRow (same button
 *    variant, same caption position, same status/error lines).
 *  - The panel files must not re-grow bespoke card markup.
 */

const read = (p: string) =>
  readFileSync(new URL(p, import.meta.url), "utf8");

const section = read("../sections/VoiceSection.tsx");
const panel = read("./VoiceEnginePanel.tsx");
const micTest = read("./useVoiceMicTest.ts");

describe("one skeleton for every engine card", () => {
  it("all six engine cards render through VoiceEnginePanel — no bespoke card markup", () => {
    // STT: api, assemblyai, local, browser. TTS: api, assemblyai, local.
    const cards = section.match(/<VoiceEnginePanel label=/g)?.length ?? 0;
    expect(cards).toBe(7);
    // The old hand-rolled card div must not return in the section.
    expect(section).not.toMatch(
      /rounded-lg border border-border\/60 bg-card\/60 px-3 py-2\.5/,
    );
  });

  it("every row inside the cards uses the shared VoicePanelRow (no ad-hoc rows)", () => {
    expect(section).toContain("<VoicePanelRow");
    // The section no longer hand-rolls a "flex items-center justify-between"
    // row — that structure belongs to VoicePanelRow now.
    expect(section).not.toMatch(
      /flex flex-wrap items-center justify-between gap-2 text-\[12px\]/,
    );
  });
});

describe("identical test affordance on every engine", () => {
  it("the shared VoiceTestRow renders BOTH the mic test (STT) and the voice test (TTS)", () => {
    // STT cards test the INPUT: one micTestRow element shared by all STT cards.
    const micUses = section.match(/\{micTestRow\}/g)?.length ?? 0;
    expect(micUses).toBe(4); // api + assemblyai + local + browser
    // TTS cards test the OUTPUT: one testVoiceRow element shared by all TTS cards.
    const voiceUses = section.match(/\{testVoiceRow\}/g)?.length ?? 0;
    expect(voiceUses).toBe(3); // api + assemblyai + local
    // Both ride the SAME component.
    expect(section).toContain("<VoiceTestRow");
    expect(panel).toContain("export function VoiceTestRow");
  });

  it("the test row has ONE style: outline button, caption, status, error (from the component)", () => {
    expect(panel).toContain('variant="outline"');
    expect(panel).toContain("{busy ?? testLabel}");
    expect(panel).toContain("{statusText ? (");
    expect(panel).toContain("{error ? <span");
  });

  it("Test mic exists for STT (the panels had NO input test before)", () => {
    expect(section).toContain('"Test mic"');
    expect(section).toContain('"Stop & transcribe"');
    // The transcript line: Heard: “<transcript>” (curly quotes in the JSX).
    expect(section).toMatch(/Heard: .\$\{micTest\.transcript\}./);
  });

  it("Test voice keeps its explicit-button semantics (no auto-speak on select)", () => {
    expect(section).toContain('"Test voice"');
    expect(section).toContain("Test voice speaks a short sample.");
    expect(section).not.toContain("onPreviewAssemblyVoice");
    expect(section).not.toContain("onPreviewApiVoice");
  });
});

describe("useVoiceMicTest — the STT test twin of Test voice", () => {
  it("routes every STT mode: api / assemblyai / local / browser", () => {
    expect(micTest).toContain('modeRef.current === "browser"');
    expect(micTest).toContain('modeRef.current === "local"');
    expect(micTest).toContain('modeRef.current === "assemblyai"');
    expect(micTest).toContain("transcribeViaAssemblyAi(blob)");
    expect(micTest).toContain("transcribeLocal(wav)");
    expect(micTest).toContain("openai.transcription(");
  });

  it("is a trimmed twin of the composer hook — manual start/stop, no composer coupling", () => {
    // No silence detector, no auto-submit, no chatStore import.
    expect(micTest).not.toContain("SilenceDetector");
    expect(micTest).not.toContain("onAutoSubmit");
    expect(micTest).not.toContain("useChatStore");
    // Same getUserMedia timeout cap as the composer (unhangable test button).
    expect(micTest).toContain("GET_MEDIA_TIMEOUT_MS = 8_000");
  });

  it("returns state the shared test row renders (idle/recording/transcribing + transcript)", () => {
    expect(micTest).toContain('useState<MicState>("idle")');
    expect(micTest).toContain('type MicState = "idle" | "recording" | "transcribing"');
    expect(micTest).toContain("transcript,");
  });
});

describe("existing pins stay true (regression)", () => {
  it("mode cards + key warnings unchanged", () => {
    expect(section).toContain('active={sttMode === "assemblyai"}');
    expect(section).toContain('active={ttsMode === "assemblyai"}');
    expect(section).toContain("ASSEMBLY_VOICES");
    expect(section).toContain('hasOpenaiKey === false ? missingKeyWarning("OpenAI")');
    expect(section).toContain('hasAssemblyKey === false ? missingKeyWarning("AssemblyAI")');
    expect(section).toContain('openSettingsWindow("models")');
  });

  it("selecting a voice only saves the pref (onChange handlers intact)", () => {
    expect(section).toContain("onChange={(v) => void setVoiceTtsAssemblyVoice(v)}");
    expect(section).toContain("onChange={(v) => void setVoiceTtsApiVoice(v)}");
  });
});
