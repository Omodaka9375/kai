import { tool } from "ai";
import { z } from "zod";
import { getKey } from "../lib/keyring";
import { fingerprintBase64 } from "../lib/media/bytes";
import { generateGoogleVideo } from "../lib/media/google-video";
import { generateXAIVideo } from "../lib/media/xai-video";
import { persistGeneratedMedia } from "../lib/media/persist";
import type { VideoResult } from "../lib/media/types";
import { resolvePath } from "./context";
import { spawnMediaTask } from "../lib/media/task";
import { nativeForContext, type ToolContext } from "./context";

const DEFAULT_DURATION = 8;

/** Per-video budget in ms for the detached job's timeout: the synchronous
 *  render POST may legally take up to 600s (the Rust proxy's cap) and the
 *  Files-API activation poll another 5 min. The OLD code used one fixed
 *  10-minute timeout for up to THREE sequential renders — count>1 always
 *  outlived it and the card reported a bogus timeout while videos 2-3 were
 *  still rendering. */
const PER_VIDEO_BUDGET_MS = 15 * 60_000;

/** Run `gen` `n` times in sequence, stopping at the first failure (a partial
 *  set with no error reads as "the rest are still rendering"). */
async function generateVideos(
  n: number,
  gen: () => Promise<VideoResult>,
): Promise<VideoResult[]> {
  const out: VideoResult[] = [];
  for (let i = 0; i < n; i++) out.push(await gen());
  return out;
}

/**
 * Video generation — Google Gemini Omni Flash and xAI Grok Imagine Video.
 * Other generators (Kling, Seedance, …) live behind their official MCP
 * servers, installed in Settings → MCP.
 */
export function buildVideoGenTools(ctx: ToolContext) {
  const native = nativeForContext(ctx);
  return {
    generate_video: tool({
      needsApproval: false,
      description: `Generate a video from a text prompt using Google Gemini Omni Flash or xAI Grok Imagine Video (audio-native video) — or ANIMATE an existing image (imagePath becomes the opening frame; the prompt describes motion). Uses the configured Google or xAI key. Returns the video inline in the conversation.

Providers: google = Gemini Omni 1.2 Flash; xai = Grok Imagine Video 1.5 Lite. Optional: Google is preferred, then xAI. Only name one when the user explicitly asks for it.

Video generation takes 1-5 minutes. Auto-executes — no approval needed.
If the user asks for a different video engine (Kling, Seedance, …), tell them to install that vendor's MCP server in Settings → MCP.

ONE GENERATION PER REQUEST. Produce exactly count videos (default 1) in a
single call. Do NOT call this tool again for the same prompt to "retry", and
do NOT call it repeatedly to produce several videos: set count instead.
Only call it again if the user asks for a NEW, different video.`,
      inputSchema: z.object({
        provider: z.enum(["google", "xai"]).optional().describe("Engine only when the user explicitly names it. Google preferred, xAI fallback."),
        prompt: z
          .string()
          .describe(
            "Detailed description of the video to generate. Include scene, motion, camera work, and mood.",
          ),
        duration: z
          .number()
          .min(3)
          .max(15)
          .optional()
          .describe("Video duration in seconds (3-15). Defaults to 8."),
        aspect_ratio: z
          .string()
          .optional()
          .describe("Aspect ratio: '16:9' (default) or '9:16' (portrait). Other values are coerced to 16:9."),
        imagePath: z
          .string()
          .optional()
          .describe(
            "Path to an existing image to ANIMATE - the selected provider uses it as the opening frame and the prompt describes the motion. Optional - omit for pure text-to-video.",
          ),
        count: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .describe(
            "How many videos to produce. Default 1. Only set above 1 when the USER explicitly asked for several variations. Each video is a separate multi-minute render.",
          ),
      }),
      execute: async ({ provider, prompt, duration, aspect_ratio, imagePath, count }, options) => {
        const effectiveDuration = duration ?? DEFAULT_DURATION;
        // Exactly one unless the user asked for more (clamped: every extra
        // render is minutes of GPU time and real money).
        const wanted = Math.min(3, Math.max(1, Math.round(count ?? 1)));

        const [googleKey, xaiKey] = await Promise.all([getKey("google"), getKey("xai")]);
        const engine = provider === "xai" && xaiKey
          ? "xai" as const
          : provider === "google" && googleKey
            ? "google" as const
            : googleKey
              ? "google" as const
              : xaiKey
                ? "xai" as const
                : undefined;
        const key = engine === "google" ? googleKey : xaiKey;
        if (!engine || !key) {
          return {
            error: provider === "google" || provider === "xai"
              ? `No ${provider === "google" ? "Google" : "xAI"} API key configured for the requested video engine. Add it in Settings → Models, or omit provider to use a configured key.`
              : "No usable video API key configured. Tell the user: add a Google or xAI key in Settings → Models, or use another engine's official MCP server (Settings → MCP). Keep it short.",
          };
        }
        const substituted = provider !== undefined && provider !== engine;

        // Image-to-video: read the image and thread it to the selected
        // provider (Google Interactions or xAI Imagine).
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

        // NOTE: no run AbortSignal is threaded into the detached job. The
        // agent run's signal is aborted the moment a new run supersedes it
        // (registerRunController), which would kill a 1-5 minute Omni render
        // seconds after it started. The job dies only on its own timeout or
        // an explicit session-level cancel.
        // Same prompt/options = same video: a retry attaches to the in-flight
        // job rather than paying for a second multi-minute render.
        const dedupeKey = `video:${engine}:${wanted}:${effectiveDuration}:${aspect_ratio ?? ""}:${referenceImage ? fingerprintBase64(referenceImage) : "new"}:${prompt}`;

        spawnMediaTask(
          ctx.getSessionId(),
          options.toolCallId,
          () =>
            // Sequential: each render already takes minutes.
            generateVideos(wanted, () =>
              (engine === "xai" ? generateXAIVideo : generateGoogleVideo)(key, {
                prompt,
                duration: effectiveDuration,
                aspectRatio: aspect_ratio,
                referenceImage,
              }),
            ).then(async (results) => {
            const first = results[0]!;
            // Persist to ~/.kai/media/ — follow-up tools need a PATH, and the
            // model-bound summary references this file instead of replaying
            // megabytes of base64 on every later request.
            const savedPaths = await Promise.all(
              results.map((r, i) =>
                persistGeneratedMedia(native, {
                  kind: "video",
                  prompt,
                  mimeType: r.mimeType,
                  base64: r.base64 ?? "",
                  index: i,
                })),
            );
            return {
              type: "video" as const,
              provider: first.provider,
              mimeType: first.mimeType,
              durationSeconds: first.durationSeconds,
              url: first.url,
              base64: first.base64,
              savedPath: savedPaths[0],
              videos: results.map((r, i) => ({
                url: r.url,
                base64: r.base64,
                mimeType: r.mimeType,
                durationSeconds: r.durationSeconds,
                thumbnailBase64: r.thumbnailBase64,
                savedPath: savedPaths[i],
              })),
              prompt,
            };
          }),
          // count videos render SEQUENTIALLY inside one job — the budget
          // must scale with the count or the timer kills renders 2+ midway.
          wanted * PER_VIDEO_BUDGET_MS,
          dedupeKey,
        );

        return {
          status: "generating",
          kind: "video",
          provider: engine,
          providerLabel: engine === "xai" ? "Grok Imagine Video 1.5 Lite" : "Gemini Omni Flash",
          ...(substituted ? { note: `${provider} has no usable video key, so ${engine} was used instead.` } : {}),
          count: wanted,
          // Video renders take minutes. Models read the bare placeholder as
          // a failure and retry, which stacked duplicate renders.
          next: `The ${wanted === 1 ? "video" : `${wanted} videos`} will appear in this card when ready, usually 1-5 minutes. Do NOT call generate_video again for this prompt: wait for the card to update. Only retry if the card reports an error.`,
          prompt,
        };
      },
    }),
  } as const;
}
