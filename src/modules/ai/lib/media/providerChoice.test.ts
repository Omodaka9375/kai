import { describe, expect, it } from "vitest";
import { pickImageProvider } from "./providerChoice";

/**
 * Regression cover for the reported bug: a user with ONLY a Google key got
 * "No API key configured for openai" because the model named OpenAI on the
 * tool call and the tool trusted it blindly.
 */
describe("pickImageProvider", () => {
  const googleOnly = { google: "g", openai: null, xai: null };
  const allKeys = { google: "g", openai: "o", xai: "x" };

  it("uses the only configured key even when the model asked for another", () => {
    const r = pickImageProvider(googleOnly, "openai");
    expect(r).toEqual({ ok: true, provider: "google", substituted: true });
  });

  it("defaults to Google when no provider is named", () => {
    // Google is the fast default; every current provider supports editing.
    expect(pickImageProvider(allKeys, undefined)).toEqual({
      ok: true,
      provider: "google",
      substituted: false,
    });
  });

  it("honors an explicit provider whose key exists", () => {
    expect(pickImageProvider(allKeys, "openai")).toEqual({
      ok: true,
      provider: "openai",
      substituted: false,
    });
    expect(pickImageProvider(allKeys, "xai")).toEqual({
      ok: true,
      provider: "xai",
      substituted: false,
    });
  });

  it("falls back in preference order when the named key is missing", () => {
    expect(pickImageProvider({ openai: "o" }, "google")).toEqual({
      ok: true,
      provider: "openai",
      substituted: true,
    });
    expect(pickImageProvider({ xai: "x" }, "openai")).toEqual({
      ok: true,
      provider: "xai",
      substituted: true,
    });
  });

  it("reports a clear error when no image key exists at all", () => {
    const r = pickImageProvider({ anthropic: "a", brave: "b" }, "google");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("No image-generation API key");
      // Names the three engines that CAN run, so the user has a next step.
      expect(r.error).toMatch(/Google|OpenAI|xAI/);
    }
  });

  it("honors any configured provider for imagePath editing", () => {
    expect(
      pickImageProvider(allKeys, "openai", { needsEditing: true }),
    ).toEqual({ ok: true, provider: "openai", substituted: false });
    expect(
      pickImageProvider({ openai: "o" }, "openai", { needsEditing: true }),
    ).toEqual({ ok: true, provider: "openai", substituted: false });
    expect(
      pickImageProvider({ xai: "x" }, "google", { needsEditing: true }),
    ).toEqual({ ok: true, provider: "xai", substituted: true });
  });

  it("treats an empty-string key as absent", () => {
    expect(pickImageProvider({ google: "", openai: "o" }, "google")).toEqual({
      ok: true,
      provider: "openai",
      substituted: true,
    });
  });
});
