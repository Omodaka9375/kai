import { invoke } from "@tauri-apps/api/core";
import type { ImageGenerateOpts, ImageResult } from "./types";

// Nano Banana 2 (Gemini 3.1 Flash Image). The 2024 `gemini-2.0-flash-exp`
// id was long dead; this is the current image-gen workhorse.
const MODEL = "gemini-3.1-flash-image";

/** Generate an image via Google Gemini (Nano Banana 2). */
export async function generateGoogleImage(
  apiKey: string,
  opts: ImageGenerateOpts,
): Promise<ImageResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  if (opts.signal?.aborted) throw new Error("Generation cancelled.");

  const body = JSON.stringify({
    contents: [
      {
        parts: [{ text: opts.prompt }],
      },
    ],
    // Gemini image generation: ONLY responseModalities. responseMimeType
    // accepts text/JSON types (never image/*) — sending it 400s the request
    // ("allowed mimetypes are text/plain, application/json, ...").
    generationConfig: {
      responseModalities: ["IMAGE", "TEXT"],
    },
  });

  const resp = await invoke<{
    status: number;
    headers: Record<string, string>;
    body: number[];
  }>("ai_http_request", {
    url,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: Array.from(new TextEncoder().encode(body)),
  });

  const text = new TextDecoder().decode(new Uint8Array(resp.body));
  if (resp.status !== 200) {
    throw new Error(`Google image generation failed (${resp.status}): ${text.slice(0, 300)}`);
  }

  const json = JSON.parse(text) as {
    candidates?: {
      content?: {
        parts?: { inlineData?: { mimeType: string; data: string } }[];
      };
    }[];
  };

  const parts = json.candidates?.[0]?.content?.parts;
  const imagePart = parts?.find((p) => p.inlineData?.data);
  if (!imagePart?.inlineData) {
    throw new Error("Google returned no image data");
  }

  return {
    base64: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || "image/png",
    width: 1024,
    height: 1024,
    provider: "google",
  };
}
