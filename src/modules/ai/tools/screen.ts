/**
 * Screen access — `look_at_screen` lets the agent visually inspect the
 * user's displays when they ask ("look at my screen", "what's on my left
 * monitor").
 *
 * Flow: screen_capture (Rust, xcap) → JPEG in temp →
 *   - vision-capable model: the image rides the tool result back to the
 *     model via `toModelOutput` (AI SDK v6 multi-content tool results), so
 *     the MODEL itself analyzes the screenshot. No second model needed —
 *     Moondream-class local vision via LM Studio is detected by the
 *     existing vision resolution (registry tags / name heuristic / manual
 *     Vision override).
 *   - text-only model: the generic extractImagesForTextOnly pass in the
 *     transport picks up the file part and OCRs it.
 * The transcript card renders the screenshot thumbnail so the user sees
 * exactly what the agent saw.
 *
 * needsApproval: true always — capturing the user's screen reads everything
 * visible, passwords included. The approval card is the privacy boundary.
 */

import { tool } from "ai";
import { z } from "zod";
import { attachmentFallbackText, extractAttachmentText } from "../extraction";
import { native } from "../lib/native";
import type { ToolContext } from "./context";

async function readJpegAsDataUrl(path: string): Promise<string> {
  const raw = await native.readFileBytes(path);
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

export function buildScreenTools(ctx: ToolContext) {
  return {
    look_at_screen: tool({
      description:
        "Capture a screenshot of the user's screen/monitor and see what's on it. " +
        "Use when the user asks you to look at their screen, check what's visible on " +
        "a display, describe their desktop, or read UI text on screen. Displays are " +
        'ordered left-to-right: display "0"/"left" is the leftmost monitor, "1"/' +
        '"right" the rightmost on a 2-monitor setup. With one monitor, omit display. ' +
        "Returns the monitor list when unsure which display to capture — call once " +
        "without arguments to discover, then again with the selector.",
      inputSchema: z.object({
        display: z
          .string()
          .optional()
          .describe(
            'Which display: "left", "right", "primary", a numeric index ("0", "1"), ' +
              "or a monitor-name substring. Omit for the primary display.",
          ),
        focus: z
          .string()
          .optional()
          .describe(
            "What to look for in the screenshot (e.g. 'the error dialog', 'the " +
              "terminal output'). Guides your own analysis of the image.",
          ),
      }),
      needsApproval: true,
      execute: async ({ display, focus }) => {
        // Discovery mode: no selector → list monitors so the model can pick.
        if (display == null) {
          const monitors = await native.screenListMonitors();
          if (monitors.length === 1) {
            // Single display: skip the extra round-trip, capture directly.
            return capture(monitors[0].id, focus);
          }
          return {
            monitors: monitors.map((m) => ({
              id: m.id,
              name: m.name,
              primary: m.isPrimary,
              position: m.x === Math.min(...monitors.map((o) => o.x)) ? "leftmost" : m.x === Math.max(...monitors.map((o) => o.x)) ? "rightmost" : "middle",
              resolution: `${m.width}x${m.height}`,
            })),
            hint: "Multiple displays found. Call again with display: the id (leftmost is left).",
          };
        }
        return capture(display, focus);
      },
      // Vision models receive the screenshot as a tool-result image part.
      // The openai-compatible family (DeepSeek, Mistral, OpenRouter, z.ai,
      // Groq, xAI, Cerebras, LM Studio, custom endpoints) cannot: their
      // converters stringify tool-result content parts, so an image part
      // would become megabytes of unreadable base64 text. There we fall back
      // to OCR text (same path as text-only model attachments).
      toModelOutput: async ({ output }) => {
        const o = output as { image?: { dataUrl?: string } } | undefined;
        const dataUrl = o?.image?.dataUrl;
        if (!dataUrl) return { type: "content", value: [] };
        const [meta, b64] = dataUrl.split(",");
        const mediaType = /data:([^;]+)/.exec(meta)?.[1] ?? "image/jpeg";
        if (ctx.supportsToolResultImages?.()) {
          return {
            type: "content",
            value: [
              { type: "text", text: "Screenshot captured. Analyze it to answer the user." },
              {
                // image-data, NOT file-data. file-data is the DOCUMENT part:
                // Anthropic accepts only application/pdf there and silently
                // drops images (warning + filtered), OpenAI maps it to
                // input_file. image-data is the image part for tool results —
                // Anthropic renders a base64 image block inside tool_result
                // (the computer-use pattern), OpenAI input_image, Google
                // inlineData.
                type: "image-data",
                data: b64,
                mediaType,
              } as never,
            ],
          };
        }
        return { type: "text", value: await ocrText(dataUrl) };
      },
    }),
  } as const;
}

async function capture(display: string, focus?: string) {
  const shot = await native.screenCapture(display);
  const dataUrl = await readJpegAsDataUrl(shot.path);
  // Delete the temp file — the data URL is the only copy from here on.
  try {
    await native.deleteFile(shot.path);
  } catch {
    // Harmless: swept at next startup.
  }
  return {
    monitor: {
      id: shot.monitor.id,
      name: shot.monitor.name,
      primary: shot.monitor.isPrimary,
      resolution: `${shot.width}x${shot.height}`,
      position: `x=${shot.monitor.x}`,
    },
    sizeBytes: shot.sizeBytes,
    image: {
      // dataUrl never enters the model context (toModelOutput strips it to
      // the raw part), but it IS returned in the UI tool result so the card
      // renders the thumbnail. Compaction elides it from re-sends.
      dataUrl,
    },
    ...(focus ? { focus } : {}),
  };
}

/** OCR text for providers that cannot receive tool-result images. */
async function ocrText(dataUrl: string): Promise<string> {
  try {
    const text = await extractAttachmentText({
      url: dataUrl,
      mediaType: "image/jpeg",
    });
    if (text) return `[screenshot — OCR text, provider cannot receive images]\n${text}`;
  } catch (e) {
    console.warn("[kai] screenshot OCR failed:", e);
  }
  return attachmentFallbackText("screenshot");
}
