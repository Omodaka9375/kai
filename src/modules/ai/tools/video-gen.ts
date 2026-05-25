import { tool } from "ai";
import { z } from "zod";
import { useChatStore } from "../store/chatStore";
import { generateKlingVideo } from "../lib/media/kling-video";
import { generateGoogleVideo } from "../lib/media/google-video";
import { generateSeedanceVideo } from "../lib/media/seedance-video";
import type { VideoResult } from "../lib/media/types";
import type { ToolContext } from "./context";

const PROVIDER_ENUM = ["auto", "kling", "google", "seedance"] as const;

export function buildVideoGenTools(_ctx: ToolContext) {
  return {
    generate_video: tool({
      description: `Generate a video from a text prompt using AI. Returns the video inline in the conversation.

Providers:
- kling: Kling 3.0 (best value, multi-shot, 4K, native audio)
- google: Veo 3.1 (audio-native cinematic, uses existing Google key)
- seedance: Seedance 2.0 (ByteDance, unified audio-video)
- auto: picks the first available provider (kling → google → seedance)

Video generation takes 1-5 minutes. Auto-executes — no approval needed.`,
      inputSchema: z.object({
        prompt: z
          .string()
          .describe(
            "Detailed description of the video to generate. Include scene, motion, camera work, and mood.",
          ),
        provider: z
          .enum(PROVIDER_ENUM)
          .optional()
          .default("auto")
          .describe("Which video provider to use. Defaults to auto."),
        duration: z
          .number()
          .optional()
          .describe("Video duration in seconds (5-30). Defaults to 5."),
        aspect_ratio: z
          .string()
          .optional()
          .describe("Aspect ratio (e.g. '16:9', '9:16', '1:1'). Defaults to 16:9."),
      }),
      execute: async ({ prompt, provider, duration, aspect_ratio }) => {
        const keys = useChatStore.getState().apiKeys;
        // Kling and Seedance keys are stored under their own IDs
        const allKeys = {
          ...keys,
          kling: await getMediaKey("kling"),
          seedance: await getMediaKey("seedance"),
        };

        const resolved = resolveProvider(provider ?? "auto", allKeys);
        if (!resolved) {
          return {
            error:
              "No video generation provider available. Add a Kling, Google, or Seedance API key in Settings → Models.",
          };
        }

        try {
          const result = await callProvider(resolved.provider, resolved.key, {
            prompt,
            duration,
            aspectRatio: aspect_ratio,
          });
          return {
            type: "video" as const,
            provider: result.provider,
            mimeType: result.mimeType,
            durationSeconds: result.durationSeconds,
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

/** Read a media provider key from the keyring. */
async function getMediaKey(provider: string): Promise<string | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const v = await invoke<string | null>("secrets_get", {
      service: "kai-media",
      account: provider,
    });
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

type ResolvedProvider = {
  provider: "kling" | "google" | "seedance";
  key: string;
};

function resolveProvider(
  preference: string,
  keys: Record<string, string | null>,
): ResolvedProvider | null {
  if (preference !== "auto") {
    const key = keys[preference];
    if (key) return { provider: preference as ResolvedProvider["provider"], key };
    return null;
  }
  // Auto: kling → google → seedance
  for (const id of ["kling", "google", "seedance"] as const) {
    const key = keys[id];
    if (key) return { provider: id, key };
  }
  return null;
}

async function callProvider(
  provider: "kling" | "google" | "seedance",
  key: string,
  opts: { prompt: string; duration?: number; aspectRatio?: string },
): Promise<VideoResult> {
  switch (provider) {
    case "kling":
      return generateKlingVideo(key, opts);
    case "google":
      return generateGoogleVideo(key, opts);
    case "seedance":
      return generateSeedanceVideo(key, opts);
  }
}
