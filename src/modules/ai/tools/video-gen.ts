import { tool } from "ai";
import { z } from "zod";
import { getKey } from "../lib/keyring";
import { generateGoogleVideo } from "../lib/media/google-video";
import { resolvePath } from "./context";
import { spawnMediaTask } from "../lib/media/task";
import { nativeForContext, type ToolContext } from "./context";

const DEFAULT_DURATION = 8;

/**
 * Video generation — Google Veo only, by design. Other generators (Kling,
 * Seedance, …) live behind their official MCP servers: users who need them
 * install the MCP in Settings → MCP and the tools appear automatically.
 * Native integrations were removed because both required bespoke auth
 * (Kling's JWT ak/sk, Volcengine Ark onboarding) we couldn't maintain.
 */
export function buildVideoGenTools(ctx: ToolContext) {
  const native = nativeForContext(ctx);
  return {
    generate_video: tool({
      description: `Generate a video from a text prompt using Google Veo 3.1 (audio-native) — or ANIMATE an existing image (imagePath: Veo animates it as the opening frame; the prompt then describes motion). Uses the configured Google API key — no provider choice needed. Returns the video inline in the conversation.

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
        imagePath: z
          .string()
          .optional()
          .describe(
            "Path to an existing image to ANIMATE - Veo uses it as the opening frame and the prompt describes the motion. Optional - omit for pure text-to-video.",
          ),
      }),
      execute: async ({ prompt, duration, aspect_ratio, imagePath }, options) => {
        const effectiveDuration = duration ?? DEFAULT_DURATION;
        const signal = options?.abortSignal;

        const key = await getKey("google");
        if (!key) {
          return {
            error:
              "No Google API key configured. Tell the user: add a Google key in Settings → Models, or use another engine's official MCP server (Settings → MCP). Keep it short.",
          };
        }

        // Image-to-video: read the image and thread it to Veo (see
        // google-video.ts for the wire format).
        let referenceImage: string | undefined;
        if (imagePath) {
          try {
            const cwd = ctx.getCwd();
            const abs = resolvePath(imagePath, cwd);
            const bytes = await native.readFileBytes(abs);
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

        spawnMediaTask(ctx.getSessionId(), options.toolCallId, signal, () =>
          generateGoogleVideo(key, {
            prompt,
            duration: effectiveDuration,
            aspectRatio: aspect_ratio,
            referenceImage,
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
