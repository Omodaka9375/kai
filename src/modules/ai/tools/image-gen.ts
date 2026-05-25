import { tool } from "ai";
import { z } from "zod";
import { useChatStore } from "../store/chatStore";
import { generateOpenAIImage } from "../lib/media/openai-image";
import { generateGoogleImage } from "../lib/media/google-image";
import { generateXAIImage } from "../lib/media/xai-image";
import { generateComfyImage } from "../lib/media/comfyui";
import type { ImageResult } from "../lib/media/types";
import type { ToolContext } from "./context";

const PROVIDER_ENUM = ["auto", "openai", "google", "xai", "comfyui"] as const;

export function buildImageGenTools(_ctx: ToolContext) {
  return {
    generate_image: tool({
      description: `Generate an image from a text prompt using AI. Returns the image inline in the conversation.

Providers:
- openai: GPT Image 2 (best quality, supports editing)
- google: Nano Banana 2 (Gemini, fast, good quality)
- xai: Grok Imagine (good quality)
- comfyui: local ComfyUI instance (upload workflow JSON in Settings)
- auto: picks the first available provider (openai → google → xai)

Auto-executes — no approval needed.`,
      inputSchema: z.object({
        prompt: z
          .string()
          .describe(
            "Detailed description of the image to generate. Be specific about style, composition, lighting, and subject.",
          ),
        provider: z
          .enum(PROVIDER_ENUM)
          .optional()
          .default("auto")
          .describe("Which image provider to use. Defaults to auto."),
        size: z
          .string()
          .optional()
          .describe(
            "Image dimensions (e.g. '1024x1024', '1536x1024'). Defaults to 1024x1024.",
          ),
        quality: z
          .string()
          .optional()
          .describe("Quality level: 'low', 'medium', 'high', or 'auto'. Defaults to auto."),
      }),
      execute: async ({ prompt, provider, size, quality }) => {
        const keys = useChatStore.getState().apiKeys;

        // ComfyUI: no key needed, uses workflow from settings
        if (provider === "comfyui") {
          try {
            const prefs = await import("@/modules/settings/preferences").then(
              (m) => m.usePreferencesStore.getState(),
            );
            if (!prefs.comfyuiWorkflow) {
              return { error: "No ComfyUI workflow uploaded. Go to Settings → Models → ComfyUI and upload a workflow JSON." };
            }
            const workflow = JSON.parse(prefs.comfyuiWorkflow) as Record<string, unknown>;
            const result = await generateComfyImage(prefs.comfyuiBaseURL, workflow, prompt);
            return {
              type: "image" as const,
              provider: result.provider,
              mimeType: result.mimeType,
              width: result.width,
              height: result.height,
              base64: result.base64,
              url: result.url,
              prompt,
            };
          } catch (e) {
            return { error: String(e) };
          }
        }

        const resolved = resolveProvider(provider ?? "auto", keys);
        if (!resolved) {
          return {
            error:
              "No image generation provider available. Add an OpenAI, Google, or xAI API key in Settings → Models.",
          };
        }

        try {
          const result = await callProvider(resolved.provider, resolved.key, {
            prompt,
            size,
            quality,
          });
          return {
            type: "image" as const,
            provider: result.provider,
            mimeType: result.mimeType,
            width: result.width,
            height: result.height,
            base64: result.base64,
            url: result.url,
            prompt,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  } as const;
}

type ResolvedProvider = {
  provider: "openai" | "google" | "xai";
  key: string;
};

function resolveProvider(
  preference: string,
  keys: Record<string, string | null>,
): ResolvedProvider | null {
  if (preference !== "auto") {
    const key = keys[preference as keyof typeof keys];
    if (key) return { provider: preference as ResolvedProvider["provider"], key };
    return null;
  }
  // Auto: try openai → google → xai
  for (const id of ["openai", "google", "xai"] as const) {
    const key = keys[id];
    if (key) return { provider: id, key };
  }
  return null;
}

async function callProvider(
  provider: "openai" | "google" | "xai",
  key: string,
  opts: { prompt: string; size?: string; quality?: string },
): Promise<ImageResult> {
  switch (provider) {
    case "openai":
      return generateOpenAIImage(key, opts);
    case "google":
      return generateGoogleImage(key, opts);
    case "xai":
      return generateXAIImage(key, opts);
  }
}
