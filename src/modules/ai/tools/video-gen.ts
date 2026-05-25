import { tool } from "ai";
import { z } from "zod";
import { useChatStore } from "../store/chatStore";
import { generateKlingVideo } from "../lib/media/kling-video";
import { generateGoogleVideo } from "../lib/media/google-video";
import { generateSeedanceVideo } from "../lib/media/seedance-video";
import { generateComfyVideo } from "../lib/media/comfyui";
import type { VideoResult } from "../lib/media/types";
import type { ToolContext } from "./context";

const PROVIDER_ENUM = ["kling", "google", "seedance", "comfyui"] as const;

export function buildVideoGenTools(_ctx: ToolContext) {
  return {
    generate_video: tool({
      description: `Generate a video from a text prompt using AI. Returns the video inline in the conversation.

Providers:
- kling: Kling 3.0 (best value, multi-shot, 4K, native audio)
- google: Veo 3.1 (audio-native cinematic, uses existing Google key)
- seedance: Seedance 2.0 (ByteDance, unified audio-video)
- comfyui: local ComfyUI instance (upload workflow JSON in Settings)

You MUST specify a provider. Ask the user which one to use if unclear.
Video generation takes 1-5 minutes. Auto-executes — no approval needed.`,
      inputSchema: z.object({
        prompt: z
          .string()
          .describe(
            "Detailed description of the video to generate. Include scene, motion, camera work, and mood.",
          ),
        provider: z
          .enum(PROVIDER_ENUM)
          .describe("Which video provider to use. Ask the user if not specified."),
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
            const result = await generateComfyVideo(prefs.comfyuiBaseURL, workflow, prompt);
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
        }

        const keys = useChatStore.getState().apiKeys;
        const allKeys = {
          ...keys,
          kling: await getMediaKey("kling"),
          seedance: await getMediaKey("seedance"),
        };

        const key = allKeys[provider as keyof typeof allKeys];
        if (!key) {
          return {
            error: `No API key configured for ${provider}. Add one in Settings → Models.`,
          };
        }

        try {
          const result = await callProvider(provider as "kling" | "google" | "seedance", key, {
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
