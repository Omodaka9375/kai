import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * AssemblyAI voice engine - contract pins.
 *
 * Scope (by design): a VOICE provider only - STT for the composer mic via
 * the Sync API, TTS for agent replies via the HTTP API. No chat models.
 *
 * Endpoint correctness matters here (misspelled endpoints fail only at
 * runtime, from the user's mic): the Sync STT is sync.assemblyai.com
 * (NOT api.assemblyai.com, which is the async job API), requires the
 * X-AAI-Model header, and takes multipart audio. TTS is
 * tts.us.assemblyai.com/v1/speech with a JSON body and returns WAV.
 *
 * Both calls must ride the SSRF-hardened Rust proxy (proxyFetch) and read
 * the key from the OS keyring - never the chat store (the settings window
 * is a separate webview whose chatStore never hydrates apiKeys).
 */

const getKeyMock = vi.hoisted(() =>
  vi.fn(async (provider: string) =>
    provider === "assemblyai" ? "test-key" : null,
  ),
);

vi.mock("./keyring", () => ({
  getKey: getKeyMock,
}));

const proxyFetchMock = vi.hoisted(() => vi.fn(async () => new Response()));

vi.mock("./proxyFetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./proxyFetch")>();
  return {
    ...actual,
    proxyFetch: proxyFetchMock,
  };
});

import { transcribeViaAssemblyAi, speakViaAssemblyAi } from "./assemblyai";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("transcribeViaAssemblyAi (Sync STT)", () => {
  it("posts multipart audio to the SYNC endpoint with the required model header", async () => {
    proxyFetchMock.mockClear();
    proxyFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "hello world" }), { status: 200 }),
    );
    const blob = new Blob(["audio-bytes"], { type: "audio/webm" });
    const text = await transcribeViaAssemblyAi(blob);
    expect(text).toBe("hello world");
    const [url, init] = proxyFetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sync.assemblyai.com/v1/transcribe");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    // Bare key (no Bearer - AssemblyAI's scheme) + the REQUIRED model header.
    expect(headers.Authorization).toBe("test-key");
    expect(headers["X-AAI-Model"]).toBe("universal-3-5-pro");
    // Multipart body, audio part named "audio".
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.has("audio")).toBe(true);
  });

  it("surfaces problem-details errors with status and title", async () => {
    proxyFetchMock.mockClear();
    proxyFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ title: "Audio Too Large", detail: "over the cap" }),
        { status: 422 },
      ),
    );
    const blob = new Blob(["x"], { type: "audio/webm" });
    await expect(transcribeViaAssemblyAi(blob)).rejects.toThrow(
      /AssemblyAI STT failed \(422\): Audio Too Large: over the cap/,
    );
  });

  it("throws an actionable missing-key error before any network call", async () => {
    getKeyMock.mockResolvedValueOnce(null);
    proxyFetchMock.mockClear();
    await expect(
      transcribeViaAssemblyAi(new Blob(["x"])),
    ).rejects.toThrow(/Settings > Models/);
    expect(proxyFetchMock).not.toHaveBeenCalled();
    getKeyMock.mockResolvedValueOnce("test-key");
  });
});

describe("speakViaAssemblyAi (HTTP TTS)", () => {
  it("posts JSON to /v1/speech with voice slug + wav container, returns bytes", async () => {
    proxyFetchMock.mockClear();
    const wav = new Uint8Array([1, 2, 3]);
    proxyFetchMock.mockResolvedValueOnce(new Response(wav, { status: 200 }));
    const bytes = await speakViaAssemblyAi("hello there", "aai-audrey");
    expect(new Uint8Array(bytes)).toEqual(wav);
    const [url, init] = proxyFetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://tts.us.assemblyai.com/v1/speech");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("test-key");
    const body = JSON.parse(String(init.body)) as {
      text: string;
      voice_id: string;
      container: string;
    };
    expect(body.voice_id).toBe("aai-audrey");
    expect(body.container).toBe("wav");
  });

  it("defaults the voice to aai-jane when empty", async () => {
    proxyFetchMock.mockClear();
    proxyFetchMock.mockResolvedValueOnce(new Response(new Uint8Array(0)));
    await speakViaAssemblyAi("hi", "");
    const [, init] = proxyFetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { voice_id: string };
    expect(body.voice_id).toBe("aai-jane");
  });

  it("caps the per-request text at 2000 chars (speakText chunks anyway; belt+suspenders)", async () => {
    proxyFetchMock.mockClear();
    proxyFetchMock.mockResolvedValueOnce(new Response(new Uint8Array(0)));
    await speakViaAssemblyAi("x".repeat(3000), "aai-jane");
    const [, init] = proxyFetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { text: string };
    expect(body.text.length).toBe(2000);
  });
});

describe("voice picker catalog", () => {
  it("only ships built-in aai- voices (always loaded, no first-session wait)", () => {
    const src = read("./assemblyai.ts");
    const ids = [...src.matchAll(/id: "(aai-[a-z]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    for (const id of ids) {
      expect(id).toMatch(/^aai-[a-z]+$/);
    }
    expect(ids).toContain("aai-jane");
    expect(ids).toContain("aai-audrey");
  });
});

describe("source pins - wiring", () => {
  it("speakText routes the assemblyai mode with the assembly voice pref", () => {
    const tts = read("./voiceTts.ts");
    expect(tts).toContain('mode === "assemblyai"');
    expect(tts).toContain("prefs.voiceTtsAssemblyVoice");
  });

  it("the mic hook routes assemblyai with the MediaRecorder path (silence auto-end works)", () => {
    const hook = read("../hooks/useWhisperRecording.ts");
    expect(hook).toContain('sttMode === "assemblyai" && !!assemblyAiKey');
    expect(hook).toContain("transcribeViaAssemblyAi(blob)");
    // Detector tap attached - auto end mode applies exactly like OpenAI API.
    expect(hook).toContain("detachTapRef.current = attachDetectorTap(stream);");
  });

  it("Voice settings expose both mode cards + the voice picker", () => {
    const section = read("../../../settings/sections/VoiceSection.tsx");
    expect(section).toContain('active={sttMode === "assemblyai"}');
    expect(section).toContain('active={ttsMode === "assemblyai"}');
    expect(section).toContain("ASSEMBLY_VOICES");
    expect(section).toContain("onPreviewAssemblyVoice");
  });

  it("the mode unions + pref plumbing exist end-to-end", () => {
    const store = read("../../settings/store.ts");
    expect(store).toContain('"api" | "assemblyai" | "local" | "browser"');
    expect(store).toContain('"off" | "api" | "assemblyai" | "local"');
    expect(store).toContain("voiceTtsAssemblyVoice");
    expect(store).toContain("KEY_VOICE_TTS_ASSEMBLY_VOICE");
    // Cross-window apply map: settings-window changes reach the main window.
    expect(store).toContain(
      '[KEY_VOICE_TTS_ASSEMBLY_VOICE]: "voiceTtsAssemblyVoice"',
    );
  });

  it("still voice-only: no assemblyai chat models registered", () => {
    const models = read("../config/models.ts");
    expect(models).not.toContain('provider: "assemblyai"');
  });
});
