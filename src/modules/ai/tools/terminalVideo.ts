import { tool } from "ai";
import { z } from "zod";
import { nativeForContext, type ToolContext } from "./context";
import { checkReadable } from "../lib/security";

/**
 * Video display — CHAT-ONLY (2026-11-19). An inline playable media card in
 * the chat, exactly like generate_video's. The old second surface (extract a
 * poster frame with ffmpeg and push an OSC 1337 inline image into the
 * active terminal) is GONE: it wrote into the user's terminal where the
 * agent had no business putting output, and its write path had already
 * misfired into shell stdin on the image side (same design).
 *
 * There is no ffmpeg dependency anymore at all — the card plays the real
 * bytes, no frame extraction needed.
 */

/** Chat-playback cap. The bytes travel as number[] JSON over IPC
 *  (fs_read_file_bytes) - the same transport cost the 8 MB remote-download
 *  cap below is sized against. Above this the card is skipped and the tool
 *  returns the path so the user can open the file themselves. */
const CHAT_VIDEO_CAP_BYTES = 8 * 1024 * 1024;

/** Best-effort MIME from the extension - the <video> element only needs a
 *  container hint to pick a decoder. */
function videoMimeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  if (lower.endsWith(".avi")) return "video/x-msvideo";
  return "video/mp4";
}

/** Test seam — the container→MIME hint used by the chat card. */
export const videoMimeForTest = videoMimeFor;

/**
 * bytes → base64 in 8KB slices. `String.fromCharCode(...bytes)` overflows
 * the call stack at ~120k args (verified: throws at 300k) — a single 1080p
 * poster frame is 0.5–3 MB, so the spread version threw on EVERY real video.
 * Same chunking pattern as transcribeLocal in voiceTts.ts.
 */
function bytesToBase64(bytes: number[] | Uint8Array): string {
  let binary = "";
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i += 8192) {
    binary += String.fromCharCode(...u8.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export function buildTerminalVideoTools(ctx: ToolContext) {
  const native = nativeForContext(ctx);
  return {
    display_video: tool({
      description:
        "Display a video to the user: an inline playable media card in the CHAT (like generate_video's). " +
        "Pass `path` for a local file OR `url` for a remote video (HTTP(S) only — remote URLs are first downloaded to a temp file). " +
        "Local files over 8 MB are not embedded in chat — the tool returns the path instead; the user can open it. " +
        "The original file always remains at its path. Nothing is ever written into the user's terminal.",
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
      }),
      needsApproval: true,
      execute: async ({ path, url, name }) => {
        if (!path && !url) {
          return { error: "Provide `path` (local file) or `url` (remote video)." };
        }
        if (path && url) {
          return { error: "Provide only one of `path` or `url`." };
        }

        // The label rides the chat card only — no terminal interpolation
        // anymore — but keep the control-byte gate anyway: it also flows into
        // the result JSON the model sees.
        let label = name ?? (path ? path.split(/[\\/]/).pop()! : "video");
        if (/[\x00-\x1f\x7f]/.test(label)) {
          return { error: "name must not contain control bytes" };
        }

        let localPath = path ?? "";

        // 2. Local path gate — same deny-lists the fs tools apply.
        if (path) {
          const safety = checkReadable(path);
          if (!safety.ok) return { error: safety.reason };
        }

        // 3. Remote URL → download via the SSRF-hardened Rust proxy
        // (allowPrivateNetwork: false — model-callable fetchers never reach
        // loopback/private/metadata IPs), write through the fs module. The
        // previous curl-through-shell path both bypassed the proxy policy and
        // was dead code (its malformed temp path always threw at quote time).
        if (url) {
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            return { error: "Invalid URL." };
          }
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            return { error: "Only http(s) URLs are supported." };
          }
          const { proxyFetch } = await import("../lib/proxyFetch");
          const resp = await proxyFetch(url, { redirect: "error" });
          if (!resp.ok) {
            return { error: `Download failed: HTTP ${resp.status}` };
          }
          const buf = new Uint8Array(await resp.arrayBuffer());
          // 8 MB cap — the bytes travel to Rust as a JSON number[] via IPC
          // (fs_write_file_bytes), which is impractically slow/memory-heavy
          // beyond that. Bigger downloads should go through `path` (the user
          // downloads the file) — this tool's job is a poster frame, not a
          // transfer client.
          if (buf.byteLength > 8 * 1024 * 1024) {
            return {
              error:
                "Remote video over 8 MB — download it to a local file (curl/wget) and pass `path` instead.",
            };
          }
          const isWin = navigator.platform.startsWith("Win");
          const sep = isWin ? "\\" : "/";
          const tmpBase = isWin
            ? (globalThis as { process?: { env?: Record<string, string> } })
                .process?.env?.TEMP ?? "C:\\Windows\\Temp"
            : "/tmp";
          const tmp = `${tmpBase}${sep}kai-video-${Date.now()}.mp4`;
          await native.writeFileBytes(tmp, Array.from(buf));
          localPath = tmp;
          if (!name) label = url.split("/").pop()?.slice(0, 40) ?? "video";
        }

        // 4. CHAT MEDIA CARD (was 2026-11-06; now the ONLY surface, 2026-11-19).
        //    chat as well as images" — the tool previously erroled with
        //    "no active terminal tab to display into" when the user had no
        //    terminal open, even though the chat already renders generate_
        //    video output as a playable card). The bytes are read through
        //    the fs module and wrapped in a blob URL — MediaMessage's
        //    video card accepts { type: "video", base64, mimeType, ... }
        //    shape; base64 rides the same IPC transport as every other
        //    byte read. The CSP's media-src allows blob:.
        let base64: string | undefined;
        try {
          const bytes = await native.readFileBytes(localPath);
          if (bytes.length <= CHAT_VIDEO_CAP_BYTES) {
            base64 = bytesToBase64(bytes);
          }
        } catch {
          // Unreadable bytes: card is skipped; the terminal poster (if it
          // rendered) plus the path note still tell the user where the
          // video is.
        }

        if (!base64) {
          return {
            error:
              "could not embed the video in chat (no readable bytes under the 8MB card cap). Point the user at the file path directly.",
          };
        }

        return {
          ok: true,
          type: "video" as const,
          provider: "file",
          mimeType: videoMimeFor(localPath),
          base64,
          url: "",
          durationSeconds: 0,
          prompt: label,
          displayed_in: "chat media card",
          label,
          source: url ?? path,
        };
      },
    }),
  } as const;
}


