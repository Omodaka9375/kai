/**
 * Which image provider to actually call.
 *
 * The model supplies `provider` on the tool call, but it has no idea which
 * API keys the user has configured — and models reliably name OpenAI (it
 * reads as "best quality"). A user who only holds a Google key therefore got
 * `{ error: "No API key configured for openai" }` on every attempt, which is
 * the "it only briefly mentions API" failure. Selection is now decided by
 * KEY AVAILABILITY, with the caller's request honored only when that
 * provider can actually run.
 */

export const IMAGE_PROVIDERS = ["openai", "google", "xai"] as const;
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number];

/**
 * Fallback order when the caller named no provider, or named one whose key is
 * missing. Google is first because it is the only engine that ALSO performs
 * image editing (`imagePath`), so one default keeps both paths working.
 */
const PREFERENCE: readonly ImageProvider[] = ["google", "openai", "xai"];

export type PickImageProviderResult =
  | { ok: true; provider: ImageProvider; substituted: boolean }
  | { ok: false; error: string };

const NO_KEY_HINT =
  "Tell the user: add a Google (Gemini), OpenAI, or xAI key in Settings → Models. Keep it short.";

/** Resolve the image provider to call.
 *
 *  `needsEditing` pins the choice to Google: Nano Banana 2 is the only engine
 *  that consumes a reference image here. */
export function pickImageProvider(
  keys: Record<string, string | null | undefined>,
  requested: ImageProvider | undefined,
  opts?: { needsEditing?: boolean },
): PickImageProviderResult {
  const available = PREFERENCE.filter((p) => !!keys[p]);

  if (available.length === 0) {
    return { ok: false, error: `No image-generation API key is configured. ${NO_KEY_HINT}` };
  }

  if (opts?.needsEditing) {
    if (available.includes("google")) {
      return { ok: true, provider: "google", substituted: requested !== "google" };
    }
    return {
      ok: false,
      error:
        "imagePath editing needs a Google API key (Nano Banana 2). Tell the user: add a Google key in Settings → Models, or retry without imagePath. Keep it short.",
    };
  }

  if (requested && keys[requested]) {
    return { ok: true, provider: requested, substituted: false };
  }
  // Requested provider has no key (or none was requested): use what exists.
  return { ok: true, provider: available[0]!, substituted: requested !== undefined };
}
