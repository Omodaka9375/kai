/**
 * Terminal Image Protocol — iTerm2-style inline image rendering.
 *
 * Handles OSC 1337 (iTerm2 inline image protocol) sequences from PTY output
 * and renders images as xterm decorations at the cursor position.
 *
 * Also provides a display_image tool for the AI agent to push images
 * directly into the active terminal.
 *
 * OSC 1337 format:
 *   ESC ] 1337 ; File=name=<base64name>;size=<bytes>;inline=1:<base64data> BEL
 */

import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";

/**
 * Parse an OSC 1337 inline image sequence.
 * Returns { name, data } or null if not a valid image sequence.
 */
export function parseOsc1337(oscParams: string): {
  name: string;
  base64Data: string;
} | null {
  // OSC 1337 params look like: File=name=<b64>;size=123;inline=1:<b64data>
  const match = oscParams.match(
    /^File=name=([^;]*);size=\d+;inline=1:(.+)$/,
  );
  if (!match) return null;
  return { name: match[1], base64Data: match[2] };
}

/**
 * Build an OSC 1337 escape sequence for embedding an image in terminal output.
 */
export function buildOsc1337(
  base64Data: string,
  name: string,
  sizeBytes: number,
): string {
  return `\x1b]1337;File=name=${name};size=${sizeBytes};inline=1:${base64Data}\x07`;
}

export function buildTerminalImageTools(ctx: ToolContext) {
  return {
    display_image: tool({
      description:
        "Display an image inline in the active terminal using the iTerm2 inline image protocol. Pass base64-encoded image data (without the data: URL prefix). The image renders at the current terminal cursor position. Use this to show plots, diagrams, screenshots, or AI-generated images directly in the terminal.",
      inputSchema: z.object({
        base64_data: z
          .string()
          .describe("Base64-encoded image data (PNG/JPEG/GIF). Do NOT include the data:image/...;base64, prefix."),
        name: z
          .string()
          .optional()
          .describe("Optional filename for the image."),
      }),
      execute: async ({ base64_data, name }) => {
        const imgName = name || "image.png";
        const sizeBytes = Math.ceil((base64_data.length * 3) / 4);
        const seq = buildOsc1337(base64_data, imgName, sizeBytes);
        const ok = ctx.injectIntoActivePty(seq);
        if (!ok) return { error: "no active terminal tab to display into" };
        return {
          ok: true,
          displayed_in: "active terminal",
          size_bytes: sizeBytes,
        };
      },
    }),
  } as const;
}