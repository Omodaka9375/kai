import { invoke } from "@tauri-apps/api/core";
import type { ImageGenerateOpts, ImageResult } from "./types";

const MODEL = "gemini-2.0-flash-exp";

/** Generate an image via Google Gemini (Nano Banana 2). */
export async function generateGoogleImage(
  apiKey: string,
  opts: ImageGenerateOpts,
): Promise<ImageResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  const body = JSON.stringify({
    contents: [
      {
        parts: [{ text: opts.prompt }],
      },
    ],
    generationConfig: {
      responseModalities: ["IMAGE", "TEXT"],
      responseMimeType: "image/png",
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
