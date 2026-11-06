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
import { sniffImageMime } from "../extraction";

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
      needsApproval: false,
      description:
        "Display an image to the user: inline in the CHAT as an image card, and — when a terminal tab is active — also at the terminal cursor via the iTerm2 inline image protocol. " +
        "Pass base64-encoded image data (without the data: URL prefix). Use this to show plots, diagrams, screenshots, or AI-generated images.",
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
        // The name is interpolated straight into an OSC 1337 sequence and written
        // into the live PTY. A name containing `BEL` (`\x07`) or `ESC` (`\x1b`) would
        // terminate the sequence early and inject arbitrary control bytes. Base64
        // alphabet is `[A-Za-z0-9+/=]`; reject anything else so a payload can't
        // smuggle a terminator past the length check.
        if (/[\x00-\x1f\x7f]/.test(imgName)) {
          return { error: "image name must not contain control bytes" };
        }
        if (!/^[A-Za-z0-9+/=]*$/.test(base64_data)) {
          return { error: "base64_data must contain only base64 characters" };
        }
        const sizeBytes = Math.ceil((base64_data.length * 3) / 4);

        // CHAT CARD (2026-11-06, same surface-independence fix as display_
        // video): the base64 is already in hand, so the chat always gets
        // the image — no terminal, no error. MediaMessage's image card
        // accepts { type: "image", base64, mimeType, ... }; dimensions are
        // unknown server-side, the card does not need them to render.
        // Persisted copies elide the input base64 (elideBulkyToolInputs)
        // and the compact stripper drops the output copy on later turns,
        // so this adds no dead context weight.
        const card = {
          type: "image" as const,
          base64: base64_data,
          mimeType: sniffImageMime(base64_data),
          url: "",
          width: 0,
          height: 0,
          provider: "display",
          prompt: imgName,
        };

        // Terminal decoration — best-effort second surface, never a gate.
        let terminalDisplayed = false;
        const seq = buildOsc1337(base64_data, imgName, sizeBytes);
        // DISPLAY write, not shell stdin: the OSC 1337 sequence must reach the
        // xterm parser (which renders it as an inline decoration), never the
        // shell's input stream — typing megabytes of base64 into a live prompt
        // would execute garbage or wedge the shell.
        terminalDisplayed = ctx.writeToActiveTerminalDisplay
          ? ctx.writeToActiveTerminalDisplay(seq)
          : ctx.injectIntoActivePty?.(seq) ?? false; // legacy contexts (tests) fallback
        return {
          ok: true,
          ...card,
          displayed_in: terminalDisplayed
            ? "chat image card + active terminal"
            : "chat image card",
          size_bytes: sizeBytes,
        };
      },
    }),
  } as const;
}