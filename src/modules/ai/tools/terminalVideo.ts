import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import { buildOsc1337 } from "./terminalImage";
import { checkReadable } from "../lib/security";

/**
 * Terminal video display — a poster-frame variant of the inline-image path.
 *
 * WHY a poster frame, not real playback: OSC 1337 (iTerm2 inline images) is
 * image-only by protocol design and xterm has no video surface. The honest
 * "display video in the terminal" is: extract a frame via local ffmpeg,
 * render it inline through the same decoration pipeline as display_image,
 * and annotate it so the user knows it's a video and where the real thing is.
 *
 * ffmpeg is OPTIONAL — not every KAI machine has it. Fail-soft: without it
 * the tool returns a readable notice instead of erroring the agent's turn.
 */

/** Cached ffmpeg probe — spawning a process per call is not free. */
let ffmpegAvailable: boolean | null = null;
async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    const { native } = await import("../lib/native");
    const r = await native.runCommand("ffmpeg -version", null, 8);
    ffmpegAvailable = r.exit_code === 0;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

/** Minimal arg-escape for a Windows/Unix ffmpeg spawn (no shell metachars). */
function shellQuote(s: string): string {
  // This command runs through the Rust oneshot runner (PowerShell on Windows,
  // /bin/sh elsewhere). Inside double quotes PS would interpolate `$(`, `$env`,
  // and backticks; sh would interpolate `$( )` and backticks too. Reject any
  // of these outright rather than trying to escape dialect-specifically.
  if (/[$`";]&|\\|\r|\n/.test(s)) {
    throw new Error("unsupported characters in video path/URL");
  }
  return `"${s}"`;
}

/**
 * Extract a poster frame (base64 PNG) from a local video file at `atSecs`.
 * 0.5s in avoids the all-black first frame many encoders produce.
 */
async function extractPosterFrame(
  source: string,
  atSecs: number,
): Promise<string> {
  const { native } = await import("../lib/native");
  const out = `${source}.kai-frame.png`;
  const cmd =
    `ffmpeg -y -loglevel error -ss ${atSecs} -i ${shellQuote(source)} ` +
    `-frames:v 1 ${shellQuote(out)}`;
  const r = await native.runCommand(cmd, null, 30);
  if (r.exit_code !== 0) {
    throw new Error(
      r.stderr?.trim().slice(0, 300) || `ffmpeg exited with ${r.exit_code}`,
    );
  }
  // Read the frame bytes via the fs module (NOT shell) and encode to base64.
  const bytes = await native.readFileBytes(out);
  const bin = String.fromCharCode(...bytes);
  const b64 = btoa(bin);
  // Best-effort cleanup of the temp frame file; ignore failures.
  void native.deleteFile(out).catch(() => {});
  return b64;
}

export function buildTerminalVideoTools(ctx: ToolContext) {
  return {
    display_video: tool({
      description:
        "Display a video in the active terminal as an inline poster frame (a single extracted frame, since terminals can't play video). " +
        "Pass `path` for a local file OR `url` for a remote video (HTTP(S) only — remote URLs are first downloaded to a temp file). " +
        "Requires ffmpeg on PATH; without it the tool explains how to proceed instead of erroring. " +
        "The full video remains viewable in the chat media card (generate_video) or at its path.",
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe("Local path of the video to display."),
        url: z
          .string()
          .optional()
          .describe("HTTP(S) URL of the video to display."),
        name: z.string().optional().describe("Optional display filename."),
        at_seconds: z
          .number()
          .min(0)
          .max(600)
          .optional()
          .describe("Frame timestamp (default 0.5s in — avoids black first frames)."),
      }),
      needsApproval: true,
      execute: async ({ path, url, name, at_seconds }) => {
        if (!path && !url) {
          return { error: "Provide `path` (local file) or `url` (remote video)." };
        }
        if (path && url) {
          return { error: "Provide only one of `path` or `url`." };
        }

        const display = ctx.writeToActiveTerminalDisplay ?? ctx.injectIntoActivePty;
        const write = (s: string) => display.call(ctx, s);

        // 1. ffmpeg gate — fail-soft with an actionable notice.
        if (!(await hasFfmpeg())) {
          write("\x1b[33m[kai] display_video needs ffmpeg on PATH — install it to render video frames inline.\x1b[0m\r\n");
          return {
            ok: false,
            note: "ffmpeg not found on PATH. Install ffmpeg, or read the video via read_file/ffprobe instead.",
          };
        }

        let localPath = path ?? "";
        let label = name ?? (path ? path.split(/[\\/]/).pop()! : "video");

        // 2. Remote URL → download to a temp file first (ffmpeg reads files).
        if (url) {
          if (!/^https:\/\//i.test(url)) {
            return { error: "Only https:// URLs are supported." };
          }
          const { native } = await import("../lib/native");
          const tmp = `${navigator.platform.startsWith("Win") ? "C:" + "\\Windows\\Temp" : "/tmp"}\\kai-video-${Date.now()}.mp4`;
          const dl = await native.runCommand(
            `curl -L -s -o ${shellQuote(tmp)} ${shellQuote(url)}`,
            null,
            120,
          );
          if (dl.exit_code !== 0) {
            return { error: `Download failed: ${dl.stderr?.slice(0, 200) || dl.exit_code}` };
          }
          localPath = tmp;
          if (!name) label = url.split("/").pop()?.slice(0, 40) ?? "video";
        }

        // 3. Local path — safety gate + existence is implied by ffmpeg's error.
        if (path) {
          const safety = checkReadable(path);
          if (!safety.ok) return { error: safety.reason };
        }

        // 4. Extract the poster frame (base64 PNG via ffmpeg).
        let b64: string;
        try {
          b64 = await extractPosterFrame(localPath, at_seconds ?? 0.5);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          write(`\x1b[31m[kai] ffmpeg frame extraction failed: ${msg}\x1b[0m\r\n`);
          return { error: `Frame extraction failed: ${msg}` };
        }

        // 5. Render through the same decoration pipeline as display_image.
        const seq = buildOsc1337(b64, label, Math.ceil((b64.length * 3) / 4));
        const ok = write(seq);
        if (!ok) return { error: "no active terminal tab to display into" };

        // 6. Status line so it's clear this is a video poster, not a photo.
        write(
          `\x1b[2m[kai] ▶ ${label} — poster frame at ${at_seconds ?? 0.5}s; full video: ${url ?? path}\x1b[0m\r\n`,
        );
        return {
          ok: true,
          displayed_in: "active terminal (poster frame)",
          label,
          source: url ?? path,
        };
      },
    }),
  } as const;
}


