import { tool } from "ai";
import { z } from "zod";
import { useChatStore } from "../store/chatStore";
import { generateKlingVideo } from "../lib/media/kling-video";
import { generateGoogleVideo } from "../lib/media/google-video";
import { generateSeedanceVideo } from "../lib/media/seedance-video";
import { generateComfyVideo } from "../lib/media/comfyui";
import { spawnMediaTask } from "../lib/media/task";
import type { VideoResult } from "../lib/media/types";
import type { ToolContext } from "./context";

const PROVIDER_ENUM = ["kling", "google", "seedance", "comfyui"] as const;
const DEFAULT_DURATION = 5;

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
      execute: async ({ prompt, provider, duration, aspect_ratio }, options) => {
        const effectiveDuration = duration ?? DEFAULT_DURATION;
        const signal = options?.abortSignal;

        // ComfyUI: no key needed, uses workflow from settings. Generation is
        // slow (and can be minutes long), so it runs in the background and
        // patches its result into this tool-call part when done.
        if (provider === "comfyui") {
          const prefs = await import("@/modules/settings/preferences").then(
            (m) => m.usePreferencesStore.getState(),
          );
          if (!prefs.comfyuiWorkflow) {
            return { error: "No ComfyUI workflow uploaded. Go to Settings → Models → ComfyUI and upload a workflow JSON." };
          }
          let workflow: Record<string, unknown>;
          try {
            workflow = JSON.parse(prefs.comfyuiWorkflow) as Record<string, unknown>;
          } catch {
            return { error: "ComfyUI workflow is not valid JSON. Re-export it using 'Save (API Format)'." };
          }

          spawnMediaTask(_ctx.getSessionId(), options.toolCallId, signal, () =>
            generateComfyVideo(prefs.comfyuiBaseURL, workflow, prompt, {
              duration: effectiveDuration,
              signal,
            }).then((result) => ({
              type: "video" as const,
              provider: result.provider,
              mimeType: result.mimeType,
              durationSeconds: result.durationSeconds,
              url: result.url,
              prompt,
            })),
          );

          return {
            status: "generating",
            kind: "video",
            provider: "comfyui",
            prompt,
          };
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

        spawnMediaTask(_ctx.getSessionId(), options.toolCallId, signal, () =>
          callProvider(provider as "kling" | "google" | "seedance", key, {
            prompt,
            duration: effectiveDuration,
            aspectRatio: aspect_ratio,
            signal,
          }).then((result) => ({
            type: "video" as const,
            provider: result.provider,
            mimeType: result.mimeType,
            durationSeconds: result.durationSeconds,
            url: result.url,
            prompt,
          })),
        );

        return {
          status: "generating",
          kind: "video",
          provider: provider as "kling" | "google" | "seedance",
          prompt,
        };
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
  opts: { prompt: string; duration?: number; aspectRatio?: string; signal?: AbortSignal },
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
