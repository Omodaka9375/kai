import { tool } from "ai";
import { z } from "zod";
import { useChatStore } from "../store/chatStore";
import { generateOpenAIImage } from "../lib/media/openai-image";
import { generateGoogleImage } from "../lib/media/google-image";
import { generateXAIImage } from "../lib/media/xai-image";
import { spawnMediaTask } from "../lib/media/task";
import type { ImageResult } from "../lib/media/types";
import { resolvePath } from "./context";
import { native } from "../lib/native";
import type { ToolContext } from "./context";

const PROVIDER_ENUM = ["openai", "google", "xai"] as const;

export function buildImageGenTools(_ctx: ToolContext) {
  return {
    generate_image: tool({
      description: `Generate an image from a text prompt using AI. Returns the image inline in the conversation.

Providers:
- openai: GPT Image 2 (best quality)
- google: Nano Banana 2 (Gemini, fast, good quality, native image EDITING
  via imagePath — change style, add/remove objects, combine images)
- xai: Grok Imagine (good quality)

You MUST specify a provider. Ask the user which one to use if unclear.
Auto-executes — no approval needed.`,
      inputSchema: z.object({
        prompt: z
          .string()
          .describe(
            "Detailed description of the image to generate. Be specific about style, composition, lighting, and subject.",
          ),
        provider: z
          .enum(PROVIDER_ENUM)
          .describe("Which image provider to use. Ask the user if not specified."),
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
        imagePath: z
          .string()
          .optional()
          .describe(
            "Path to an existing image to EDIT (google provider only, Nano Banana 2). The image is sent to the model alongside the prompt: restyle, add/remove objects, composites. Optional - omit for pure text-to-image.",
          ),
      }),
      execute: async ({ prompt, provider, size, quality, imagePath }, options) => {
        const keys = useChatStore.getState().apiKeys;
        const signal = options?.abortSignal;

        const key = keys[provider as keyof typeof keys];
        // Editing: read the reference image and thread it to the provider.
        // Google (Nano Banana 2) consumes it natively; other providers get
        // an explicit refusal rather than silently ignoring the input.
        let referenceImage: string | undefined;
        if (imagePath) {
          if (provider !== "google") {
            return {
              error: `imagePath editing is google-only (Nano Banana 2). Use provider: "google" to edit an existing image.`,
            };
          }
          try {
            const cwd = _ctx.getCwd();
            const abs = resolvePath(imagePath, cwd);
            const bytes = await native.readFileBytes(abs);
            // Chunked btoa — large images would blow the call stack.
            let bin = "";
            const CHUNK = 8192;
            const u8 = new Uint8Array(bytes);
            for (let i = 0; i < u8.length; i += CHUNK) {
              bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
            }
            referenceImage = btoa(bin);
          } catch (e) {
            return { error: `could not read image at "${imagePath}" (${String(e).slice(0, 160)})` };
          }
        }

        if (!key) {
          return {
            error: `No API key configured for ${provider}. Tell the user: add a ${provider === "google" ? "Google" : provider} key in Settings → Models, or use that engine's official MCP server (Settings → MCP). Keep it short.`,
          };
        }

        spawnMediaTask(_ctx.getSessionId(), options.toolCallId, signal, () =>
          callProvider(provider as "openai" | "google" | "xai", key, {
            prompt,
            size,
            quality,
            referenceImage,
            signal,
          }).then((result) => ({
            type: "image" as const,
            provider: result.provider,
            mimeType: result.mimeType,
            width: result.width,
            height: result.height,
            base64: result.base64,
            url: result.url,
            prompt,
          })),
        );

        return {
          status: "generating",
          kind: "image",
          provider: provider as "openai" | "google" | "xai",
          prompt,
        };
      },
    }),
  } as const;
}

async function callProvider(
  provider: "openai" | "google" | "xai",
  key: string,
  opts: { prompt: string; size?: string; quality?: string; referenceImage?: string; signal?: AbortSignal },
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
