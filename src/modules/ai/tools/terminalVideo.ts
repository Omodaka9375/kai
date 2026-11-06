import { tool } from "ai";
import { z } from "zod";
import { nativeForContext, type ToolContext } from "./context";
import { buildOsc1337 } from "./terminalImage";
import { checkReadable, checkWritable } from "../lib/security";

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

/** Chat-playback cap. The bytes travel as number[] JSON over IPC
 *  (fs_read_file_bytes) - the same transport cost the 8 MB remote-download
 *  cap below is sized against. Above this the chat card is skipped and the
 *  terminal poster frame remains the display. */
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

/**
 * Quote a value for the ffmpeg command line AND reject every shell metachar.
 * The command runs through the Rust oneshot runner (PowerShell -File on
 * Windows, `$SHELL -lc` elsewhere), so metachars are live in BOTH dialects:
 * `"` breaks out of quoting, `;` chains statements, `$(` + backtick interpolate
 * inside double quotes, `&` chains, backslash escapes. The reject-list is a
 * SINGLE character class — an earlier draft had `&` outside the class, which
 * accepted `x"; cmd; #` (statement injection).
 */
function shellQuote(s: string): string {
  if (/[$`;&"\\]|\r|\n/.test(s)) {
    throw new Error("unsupported characters in video path/URL");
  }
  return `"${s}"`;
}

/** Test seam — the gate itself, without building a command. */
export const shellQuoteForTest = shellQuote;
/** Test seam — the container→MIME hint used by the chat card. */
export const videoMimeForTest = videoMimeFor;

/**
 * Extract a poster frame (base64 PNG) from a local video file at `atSecs`.
 * 0.5s in avoids the all-black first frame many encoders produce.
 */
async function extractPosterFrame(
  source: string,
  atSecs: number,
): Promise<string> {
  const { native } = await import("../lib/native");
  // The frame file is derived by APPENDING to the source path, so it always
  // lands in the source's directory — the append cannot traverse. The WRITE
  // still goes through the same deny-lists as fs tools (shell-init files,
  // protected dirs) because ffmpeg performs it outside the fs module.
  const out = `${source}.kai-frame.png`;
  const writeGate = checkWritable(out);
  if (!writeGate.ok) throw new Error(writeGate.reason);
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
  const b64 = bytesToBase64(bytes);
  // Best-effort cleanup of the temp frame file; ignore failures.
  void native.deleteFile(out).catch(() => {});
  return b64;
}

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
        "Display a video to the user: an inline playable media card in the CHAT (like generate_video's), and — when a terminal tab is active — also an inline poster frame in the terminal (a single extracted frame, since terminals can't play video). " +
        "Pass `path` for a local file OR `url` for a remote video (HTTP(S) only — remote URLs are first downloaded to a temp file). " +
        "The chat card needs neither ffmpeg nor a terminal; the terminal poster frame additionally requires ffmpeg on PATH. " +
        "The original file always remains at its path.",
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

        // 1. ffmpeg gate — needed ONLY for the terminal poster frame. The
        //    chat card (below) works without it; without ffmpeg we simply
        //    skip the terminal decoration instead of failing the tool.
        const ffmpeg = await hasFfmpeg();
        if (!ffmpeg) {
          write("\x1b[33m[kai] display_video: no ffmpeg on PATH — skipping the terminal poster frame; the video is in the chat card.\x1b[0m\r\n");
        }

        // The name/label is interpolated into an OSC 1337 sequence — same
        // control-byte gate as display_image (BEL/ESC would terminate the
        // sequence early and inject trailing bytes as terminal input).
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
        // was dead code: its malformed temp path always threw in shellQuote.
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

        // 4. Extract the poster frame (base64 PNG via ffmpeg). Terminal-only
        //    decoration — a failure here must not kill the chat card below.
        let terminalDisplayed = false;
        if (ffmpeg) {
          try {
            const b64 = await extractPosterFrame(localPath, at_seconds ?? 0.5);
            const seq = buildOsc1337(b64, label, Math.ceil((b64.length * 3) / 4));
            const ok = write(seq);
            if (ok) {
              terminalDisplayed = true;
              // Status line so it's clear this is a video poster, not a photo.
              write(
                `\x1b[2m[kai] ▶ ${label} — poster frame at ${at_seconds ?? 0.5}s; full video: ${url ?? path}\x1b[0m\r\n`,
              );
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            write(`\x1b[31m[kai] ffmpeg frame extraction failed: ${msg}\x1b[0m\r\n`);
          }
        }

        // 5. CHAT MEDIA CARD (2026-11-06: "Videos should be displayed in
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

        if (!terminalDisplayed && !base64) {
          return {
            error:
              "could not display the video in chat (no readable bytes under the 8MB card cap) and no terminal tab is active. Open a terminal tab and retry, or point the user at the file path directly.",
          };
        }

        return {
          ok: true,
          ...(base64
            ? {
                type: "video" as const,
                provider: "file",
                mimeType: videoMimeFor(localPath),
                base64,
                url: "",
                durationSeconds: 0,
                prompt: label,
              }
            : {}),
          displayed_in: base64
            ? terminalDisplayed
              ? "chat media card + terminal poster frame"
              : "chat media card"
            : "active terminal (poster frame)",
          label,
          source: url ?? path,
        };
      },
    }),
  } as const;
}


