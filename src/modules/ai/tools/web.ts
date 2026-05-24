import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";

/**
 * Fetch a URL via the Rust HTTP proxy (bypasses CORS, no Python needed).
 */
async function httpFetch(url: string): Promise<{ status: number; body: string }> {
  const resp = await invoke<{ status: number; headers: Record<string, string>; body: number[] }>(
    "ai_http_request",
    {
      url,
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      allowPrivateNetwork: true,
    },
  );
  const body = new TextDecoder().decode(new Uint8Array(resp.body));
  return { status: resp.status, body };
}

/** Strip HTML tags and clean up whitespace. */
function htmlToText(html: string): string {
  let text = html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n\n");
  return text.trim();
}

export function buildWebTools(_ctx: ToolContext) {
  return {
    web_browse: tool({
      description:
        "Fetch and render a web page, returning its text content. Uses Camoufox (anti-detect browser) if installed, falls back to HTTP fetch. Useful for reading documentation, articles, READMEs, or any public URL. Auto-executes (read-only).",
      inputSchema: z.object({
        url: z.string().url().describe("The URL to browse."),
      }),
      execute: async ({ url }) => {
        try {
          const { body } = await httpFetch(url);
          const text = htmlToText(body);
          return {
            url,
            content: text.slice(0, 25000),
            size: text.length,
            ...(text.length > 25000 ? { truncated: true } : {}),
          };
        } catch (e) {
          return { error: String(e), url };
        }
      },
    }),

    web_search: tool({
      description:
        "Search the web using DuckDuckGo and return the top results with titles, URLs, and snippets. Useful for finding documentation, answers, or current information. Auto-executes (read-only).",
      inputSchema: z.object({
        query: z.string().describe("The search query."),
      }),
      execute: async ({ query }) => {
        try {
          const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
          const { body } = await httpFetch(searchUrl);
          // Parse DuckDuckGo HTML results.
          const results: { title: string; url: string; snippet?: string }[] = [];
          const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs;
          for (const m of body.matchAll(linkRe)) {
            const link = m[1];
            const title = m[2].replace(/<[^>]+>/g, "").trim();
            if (title && link) results.push({ title, url: link });
          }
          const snippetRe = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;
          let i = 0;
          for (const m of body.matchAll(snippetRe)) {
            if (i < results.length) {
              results[i].snippet = m[1].replace(/<[^>]+>/g, "").trim();
            }
            i++;
          }
          return { query, results: results.slice(0, 10) };
        } catch (e) {
          return { error: String(e), query };
        }
      },
    }),
  } as const;
}
