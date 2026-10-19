import { tool } from "ai";
import { z } from "zod";
import { getKey } from "../lib/keyring";
import { generateGoogleVideo } from "../lib/media/google-video";
import { spawnMediaTask } from "../lib/media/task";
import type { ToolContext } from "./context";

const DEFAULT_DURATION = 8;

/**
 * Video generation — Google Veo only, by design. Other generators (Kling,
 * Seedance, …) live behind their official MCP servers: users who need them
 * install the MCP in Settings → MCP and the tools appear automatically.
 * Native integrations were removed because both required bespoke auth
 * (Kling's JWT ak/sk, Volcengine Ark onboarding) we couldn't maintain.
 */
export function buildVideoGenTools(_ctx: ToolContext) {
  return {
    generate_video: tool({
      description: `Generate a video from a text prompt using Google Veo 3.1 (audio-native). Uses the configured Google API key — no provider choice needed. Returns the video inline in the conversation.

Video generation takes 1-5 minutes. Auto-executes — no approval needed.
If the user asks for a different video engine (Kling, Seedance, …), tell them to install that vendor's MCP server in Settings → MCP.`,
      inputSchema: z.object({
        prompt: z
          .string()
          .describe(
            "Detailed description of the video to generate. Include scene, motion, camera work, and mood.",
          ),
        duration: z
          .number()
          .optional()
          .describe("Video duration in seconds (4-8). Defaults to 8."),
        aspect_ratio: z
          .string()
          .optional()
          .describe("Aspect ratio (e.g. '16:9', '9:16', '1:1'). Defaults to 16:9."),
      }),
      execute: async ({ prompt, duration, aspect_ratio }, options) => {
        const effectiveDuration = duration ?? DEFAULT_DURATION;
        const signal = options?.abortSignal;

        const key = await getKey("google");
        if (!key) {
          return {
            error:
              "No Google API key configured. Tell the user: add a Google key in Settings → Models, or use another engine's official MCP server (Settings → MCP). Keep it short.",
          };
        }

        spawnMediaTask(_ctx.getSessionId(), options.toolCallId, signal, () =>
          generateGoogleVideo(key, {
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
            base64: result.base64,
            prompt,
          })),
        );

        return {
          status: "generating",
          kind: "video",
          provider: "google",
          prompt,
        };
      },
    }),
  } as const;
}
