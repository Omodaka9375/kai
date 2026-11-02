import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  mergeDraftTranscript,
  routeVoiceTranscript,
} from "./voiceTranscript";

/**
 * Cross-project voice-paste routing (2026-11-02).
 *
 * User report: dictating with voice, switching projects while the UI said
 * "Transcribing…", and the finished transcript pasted into the OTHER
 * project's input bar. The composer is one app-level provider whose text
 * follows the GLOBAL active session, so a late transcript landed wherever
 * the user happened to be looking — and with hands-free auto-submit it
 * would have been SENT to that project's agent.
 *
 * The guard: snapshot the session at capture start; when the transcript
 * arrives, if the user has moved on, route it into the CAPTURED session's
 * persisted draft (visible when they switch back) and skip auto-submit.
 */
describe("routeVoiceTranscript", () => {
  it("same session (or missing snapshot) routes to the field as before", () => {
    expect(routeVoiceTranscript("s1", "s1")).toEqual({ route: "field" });
    expect(routeVoiceTranscript(null, "s1")).toEqual({ route: "field" });
    expect(routeVoiceTranscript(undefined, "s1")).toEqual({ route: "field" });
    expect(routeVoiceTranscript("s1", null)).toEqual({ route: "field" });
  });

  it("a session switch mid-transcription routes to the CAPTURED session's draft", () => {
    // The repro: capture started in s1, user switched to s2 while the STT
    // was still running.
    expect(routeVoiceTranscript("s1", "s2")).toEqual({
      route: "draft",
      sessionId: "s1",
    });
  });
});

describe("mergeDraftTranscript", () => {
  it("appends after pre-typed text with a space, matching the field paste", () => {
    expect(mergeDraftTranscript("hello", "world")).toBe("hello world");
    expect(mergeDraftTranscript("", "world")).toBe("world");
    expect(mergeDraftTranscript(null, "world")).toBe("world");
    expect(mergeDraftTranscript("  hello  ", "world")).toBe("hello world");
  });
});

describe("composer wiring pins (source)", () => {
  const composer = readFileSync(
    new URL("../components/composer.tsx", import.meta.url),
    "utf8",
  );
  const inputBar = readFileSync(
    new URL("../components/AiInputBar.tsx", import.meta.url),
    "utf8",
  );

  it("captures the session at voice start and routes the result", () => {
    // Snapshot on start (both entry points call the wrapper)...
    expect(composer).toContain("voiceCaptureSidRef.current = sessionId;");
    // ...and route on result: draft for a switched-away capture.
    expect(composer).toContain(
      "routeVoiceTranscript(\n        voiceCaptureSidRef.current,\n        sessionId,\n      )",
    );
    expect(composer).toContain('routing.route === "draft"');
    expect(composer).toContain("mergeDraftTranscript(prev, transcript)");
  });

  it("a switched-away capture never auto-submits to the visible project's agent", () => {
    // onAutoSubmit checks the SAME routing and bails on draft — sending the
    // user's words to the wrong project's agent is worse than a resend.
    expect(composer).toMatch(
      /onAutoSubmit[\s\S]*?routeVoiceTranscript[\s\S]*?routing\.route === "draft"\) return;/,
    );
  });

  it("both mic entry points start through the snapshotting wrapper", () => {
    // The composer's toggle listener...
    expect(composer).toMatch(
      /onVoiceToggle[\s\S]*?if \(voice\.error\) voice\.clearError\(\);\s*\n\s*startVoiceCapture\(\);/,
    );
    // ...and AiInputBar's mic button. No raw voice.start() start sites left.
    expect(inputBar).toContain("c.startVoiceCapture();");
    expect(composer).not.toMatch(/void voice\.start\(\)/);
    expect(inputBar).not.toMatch(/c\.voice\.start\(\)/);
  });

  it("the wrapper is exposed on the composer context for mic surfaces", () => {
    expect(composer).toContain("startVoiceCapture,");
  });
});
