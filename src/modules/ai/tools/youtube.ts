import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";

const YT_URL_PATTERNS = [
  /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
];

function extractVideoId(url: string): string | null {
  for (const re of YT_URL_PATTERNS) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

async function httpGet(url: string): Promise<string> {
  const resp = await invoke<{
    status: number;
    headers: Record<string, string>;
    body: number[];
  }>("ai_http_request", {
    url,
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
    allowPrivateNetwork: false,
  });
  return new TextDecoder().decode(new Uint8Array(resp.body));
}

/** Extract caption track URLs from YouTube's player response embedded in the page. */
function extractCaptionTracks(
  html: string,
): { url: string; lang: string; name: string }[] {
  // YouTube embeds a JSON blob with caption info in the page HTML.
  const match = html.match(/"captionTracks"\s*:\s*(\[[\s\S]*?\])/);
  if (!match) return [];
  try {
    const raw = match[1]
      .replace(/\\u0026/g, "&")
      .replace(/\\"/g, '"');
    const tracks = JSON.parse(raw) as {
      baseUrl: string;
      languageCode: string;
      name?: { simpleText?: string };
    }[];
    return tracks.map((t) => ({
      url: t.baseUrl,
      lang: t.languageCode,
      name: t.name?.simpleText ?? t.languageCode,
    }));
  } catch {
    return [];
  }
}

/** Parse YouTube's timedtext XML into plain text with timestamps. */
function parseTimedText(xml: string): string {
  const lines: string[] = [];
  const re = /<text\s+start="([^"]*)"[^>]*>([\s\S]*?)<\/text>/g;
  for (const m of xml.matchAll(re)) {
    const start = parseFloat(m[1]);
    const text = m[2]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!text) continue;
    const mins = Math.floor(start / 60);
    const secs = Math.floor(start % 60);
    const ts = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    lines.push(`[${ts}] ${text}`);
  }
  return lines.join("\n");
}

/** Extract video title from the page HTML. */
function extractTitle(html: string): string | null {
  const m = html.match(/<title>(.*?)<\/title>/);
  if (!m) return null;
  return m[1]
    .replace(/ - YouTube$/, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

export function buildYouTubeTools(_ctx: ToolContext) {
  return {
    youtube_transcript: tool({
      description:
        "Fetch the transcript (captions) of a YouTube video. Returns timestamped text that can be used to summarize the video's content. Works with any YouTube URL format. Auto-executes (read-only).",
      inputSchema: z.object({
        url: z
          .string()
          .describe(
            "YouTube video URL (youtube.com/watch?v=, youtu.be/, etc.)",
          ),
      }),
      execute: async ({ url }) => {
        const videoId = extractVideoId(url);
        if (!videoId) {
          return { error: "Could not extract video ID from URL", url };
        }

        try {
          const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
          const html = await httpGet(pageUrl);
          const title = extractTitle(html) ?? videoId;
          const tracks = extractCaptionTracks(html);

          if (tracks.length === 0) {
            return {
              error:
                "No captions available for this video. The video may not have subtitles enabled.",
              videoId,
              title,
            };
          }

          // Prefer English, fall back to first available track.
          const enTrack =
            tracks.find((t) => t.lang.startsWith("en")) ?? tracks[0];

          // Fetch the caption XML. Append &fmt=srv3 for the XML format.
          const captionUrl = enTrack.url.includes("fmt=")
            ? enTrack.url
            : `${enTrack.url}&fmt=srv3`;
          const xml = await httpGet(captionUrl);
          const transcript = parseTimedText(xml);

          if (!transcript) {
            return {
              error: "Captions were found but could not be parsed.",
              videoId,
              title,
              language: enTrack.lang,
            };
          }

          const MAX = 30_000;
          return {
            videoId,
            title,
            language: enTrack.lang,
            availableLanguages: tracks.map((t) => t.lang),
            transcript:
              transcript.length > MAX
                ? transcript.slice(0, MAX) + "\n[...truncated]"
                : transcript,
            length: transcript.length,
          };
        } catch (e) {
          return { error: String(e), videoId };
        }
      },
    }),
  } as const;
}
