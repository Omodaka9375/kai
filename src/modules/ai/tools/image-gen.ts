import { tool } from "ai";
import { z } from "zod";
import { fingerprintBase64 } from "../lib/media/bytes";
import { useChatStore } from "../store/chatStore";
import { generateOpenAIImage } from "../lib/media/openai-image";
import { generateGoogleImage } from "../lib/media/google-image";
import { generateXAIImage } from "../lib/media/xai-image";
import {
  IMAGE_PROVIDERS,
  pickImageProvider,
  type ImageProvider,
} from "../lib/media/providerChoice";
import { spawnMediaTask } from "../lib/media/task";
import { persistGeneratedMedia } from "../lib/media/persist";
import type { ImageResult } from "../lib/media/types";
import { resolvePath } from "./context";
import { nativeForContext, type ToolContext } from "./context";

const PROVIDER_LABEL: Record<ImageProvider, string> = {
  openai: "OpenAI GPT Image 2.6 Flare",
  google: "Google Nano Banana 2.1",
  xai: "xAI Grok Imagine",
};

export function buildImageGenTools(ctx: ToolContext) {
  const native = nativeForContext(ctx);
  return {
    generate_image: tool({
      needsApproval: false,
      description: `Generate an image from a text prompt using AI. Returns the image inline in the conversation.

Providers:
- google: Nano Banana 2.1 (Gemini, fast, native image editing via imagePath)
- openai: GPT Image 2.6 Flare (fast generation and native image editing)
- xai: Grok Imagine Image 2.0 (generation and native image editing)

imagePath lets each provider change style or add/remove objects in the supplied
reference image. The provider is optional and key selection is automatic.

The provider is OPTIONAL. Omit it and KAI uses whichever engine the user
has a key for (Google first, then OpenAI, then xAI). Only pass a provider
when the user explicitly names one — never ask, and never assume OpenAI.

ONE GENERATION PER REQUEST. Generate exactly count images (default 1) in a
single call. Do NOT call this tool again for the same prompt to "retry", and
do NOT call it repeatedly to produce several images: set count instead.
Only call it again if the user asks for a NEW, different picture.`,
      inputSchema: z.object({
        prompt: z
          .string()
          .describe(
            "Detailed description of the image to generate. Be specific about style, composition, lighting, and subject.",
          ),
        provider: z
          .enum(IMAGE_PROVIDERS)
          .optional()
          .describe(
            "Provider to force. Omit this unless the user explicitly named an engine; KAI picks from the configured API keys otherwise.",
          ),
        size: z
          .string()
          .optional()
          .describe(
            "Image dimensions (e.g. '1024x1024', '1536x1024'). Defaults to 1024x1024.",
          ),
        quality: z
          .string()
          .optional()
          .describe("Quality: 'low', 'medium', 'high', or 'auto'. Defaults to auto. Google uses 1K (auto/low/medium) or 2K (high); xAI maps high to its supported medium tier."),
        count: z
          .number()
          .int()
          .min(1)
          .max(4)
          .optional()
          .describe(
            "How many images to produce. Default 1 — the overwhelmingly common case. Only set above 1 when the USER explicitly asked for several variations ('two versions', '4 options').",
          ),
        imagePath: z
          .string()
          .optional()
          .describe(
            "Path to an existing image to EDIT. Google Nano Banana 2.1, OpenAI GPT Image 2.6 Flare, and xAI Grok Imagine Image 2.0 accept it alongside the prompt. Optional - omit for pure text-to-image.",
          ),
      }),
      execute: async ({ prompt, provider, size, quality, count, imagePath }, options) => {
        const keys = useChatStore.getState().apiKeys;
        // Exactly one unless the user asked for more. Clamped so a model
        // hallucinating count: 20 cannot run up a bill.
        const wanted = Math.min(4, Math.max(1, Math.round(count ?? 1)));

        // Read the reference image once. Every current provider supports
        // editing; its own module selects the documented edit endpoint.
        let referenceImage: string | undefined;
        if (imagePath) {
          try {
            const cwd = ctx.getCwd();
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

        // Decide the ENGINE from the keys, not from what the model guessed.
        // A model naming "openai" with only a Google key configured used to
        // fail outright ("No API key configured for openai").
        const picked = pickImageProvider(keys, provider, {
          needsEditing: referenceImage !== undefined,
        });
        if (!picked.ok) return { error: picked.error };
        const engine = picked.provider;
        const key = keys[engine];
        if (!key) {
          // Unreachable (pickImageProvider only returns providers with a
          // key) — kept as a type narrowing guard.
          return { error: `No API key configured for ${engine}.` };
        }

        // Same engine + same prompt + same options = the same picture. A
        // retry (the model re-calling because it read "generating" as a
        // failure) attaches to the in-flight job instead of paying for and
        // displaying a second generation.
        const dedupeKey = `image:${engine}:${wanted}:${size ?? ""}:${quality ?? ""}:${referenceImage ? fingerprintBase64(referenceImage) : "new"}:${prompt}`;

        spawnMediaTask(
          ctx.getSessionId(),
          options.toolCallId,
          () =>
            // Sequential, not parallel: image endpoints rate-limit hard and a
            // burst of 4 concurrent requests is what produces spurious 429s.
            generateMany(wanted, () =>
              callProvider(engine, key, { prompt, size, quality, referenceImage }),
            ).then(async (results) => {
              // Persist to ~/.kai/media/ — follow-up tools (edit / animate)
              // need a PATH, and the model-bound summary references this
              // file instead of replaying megabytes of base64.
              const savedPaths = await Promise.all(
                results.map((r, i) =>
                  persistGeneratedMedia(native, {
                    kind: "image",
                    prompt,
                    mimeType: r.mimeType,
                    base64: r.base64 ?? "",
                    index: i,
                  })),
              );
              return {
                type: "image" as const,
                provider: results[0]!.provider,
                mimeType: results[0]!.mimeType,
                width: results[0]!.width,
                height: results[0]!.height,
                base64: results[0]!.base64,
                url: results[0]!.url,
                savedPath: savedPaths[0],
                // Only present for multi-image requests; MediaMessage renders
                // every entry and falls back to the single fields above.
                images: results.map((r, i) => ({
                  base64: r.base64,
                  url: r.url,
                  mimeType: r.mimeType,
                  width: r.width,
                  height: r.height,
                  savedPath: savedPaths[i],
                })),
                prompt,
              };
            }),
          wanted * 3 * 60_000,
          dedupeKey,
        );

        return {
          status: "generating",
          kind: "image",
          provider: engine,
          providerLabel: PROVIDER_LABEL[engine],
          count: wanted,
          // Tell the model (and the user) when its request was redirected, so
          // it can narrate "using Google" instead of claiming OpenAI.
          ...(picked.substituted && provider
            ? { note: `${provider} has no API key, so ${engine} was used instead.` }
            : {}),
          // The image lands in this card when the job finishes. Models read
          // the bare placeholder as a failure and call the tool again, which
          // produced duplicate/looping generations.
          next: `The ${wanted === 1 ? "image" : `${wanted} images`} will appear in this card when ready, usually 10-60 seconds. Do NOT call generate_image again for this prompt: wait for the card to update. Only retry if the card reports an error.`,
          prompt,
        };
      },
    }),
  } as const;
}

/** Run `gen` `n` times in sequence, stopping at the first failure. Partial
 *  success is deliberately NOT returned: a half-populated grid with no error
 *  reads as "the missing ones are still coming". */
async function generateMany(
  n: number,
  gen: () => Promise<ImageResult>,
): Promise<ImageResult[]> {
  const out: ImageResult[] = [];
  for (let i = 0; i < n; i++) out.push(await gen());
  return out;
}

async function callProvider(
  provider: ImageProvider,
  key: string,
  opts: {
    prompt: string;
    size?: string;
    quality?: string;
    referenceImage?: string;
  },
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
