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

/** Extract the real URL from DDG's redirect wrapper. */
function extractDdgUrl(raw: string): string {
  try {
    // DDG wraps results as //duckduckgo.com/l/?uddg=<encoded>&rut=<hash>
    if (raw.includes("uddg=")) {
      const u = new URL(raw, "https://duckduckgo.com");
      return decodeURIComponent(u.searchParams.get("uddg") ?? raw);
    }
    // Direct URL — just clean up protocol.
    if (raw.startsWith("//")) return `https:${raw}`;
    return raw;
  } catch {
    return raw;
  }
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
          // Use DDG lite endpoint with POST. The Accept-Encoding is handled
          // by Rust reqwest (gzip/deflate enabled in Cargo.toml).
          const resp = await invoke<{ status: number; headers: Record<string, string>; body: number[] }>(
            "ai_http_request",
            {
              url: "https://lite.duckduckgo.com/lite/",
              method: "POST",
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: Array.from(new TextEncoder().encode(`q=${encodeURIComponent(query)}`)),
              allowPrivateNetwork: false,
            },
          );
          const body = new TextDecoder().decode(new Uint8Array(resp.body));

          // DDG Lite uses a simple HTML table layout. Parse results from
          // both the lite format and the standard html format for resilience.
          const results: { title: string; url: string; snippet?: string }[] = [];

          // ── Strategy 1: DDG Lite table rows ──
          // Lite wraps each result in <tr> with class "result-link" or
          // a link inside a <td class="result-title">. The snippet is in
          // the next <td class="result-snippet">.
          // Links in lite are plain: <a href="https://example.com">Title</a>
          const liteRowRe = /<a[^>]+href="(https?:\/\/[^"]*)"[^>]*class="[^"]*result-link[^"]*"[^>]*>(.*?)<\/a>/gs;
          for (const m of body.matchAll(liteRowRe)) {
            const title = m[2].replace(/<[^>]+>/g, "").trim();
            if (title) results.push({ title, url: extractDdgUrl(m[1]) });
          }
          // Alt: href before class
          if (results.length === 0) {
            const liteRowRe2 = /<a[^>]+class="[^"]*result-link[^"]*"[^>]+href="(https?:\/\/[^"]*)"[^>]*>(.*?)<\/a>/gs;
            for (const m of body.matchAll(liteRowRe2)) {
              const title = m[2].replace(/<[^>]+>/g, "").trim();
              if (title) results.push({ title, url: extractDdgUrl(m[1]) });
            }
          }

          // ── Strategy 2: Standard DDG HTML (class="result__a") ──
          if (results.length === 0) {
            const aTagRe = /<a\s([^>]*class="result__a"[^>]*)>(.*?)<\/a>/gs;
            for (const m of body.matchAll(aTagRe)) {
              const attrs = m[1];
              const inner = m[2];
              const hrefMatch = /href="([^"]*)"/.exec(attrs);
              if (!hrefMatch) continue;
              const title = inner.replace(/<[^>]+>/g, "").trim();
              const realUrl = extractDdgUrl(hrefMatch[1]);
              if (title && realUrl) results.push({ title, url: realUrl });
            }
          }

          // ── Strategy 3: Grab all external links from result-like containers ──
          if (results.length === 0) {
            const anyLink = /<a[^>]+href="(https?:\/\/(?!duckduckgo\.com)[^"]*)"[^>]*>(.*?)<\/a>/gi;
            for (const m of body.matchAll(anyLink)) {
              const title = m[2].replace(/<[^>]+>/g, "").trim();
              if (title && title.length > 5 && !m[1].includes("duckduckgo.com")) {
                results.push({ title, url: m[1] });
              }
              if (results.length >= 10) break;
            }
          }

          // Extract snippets.
          const snippetRe = /<(?:a|td)[^>]*class="[^"]*(?:result__snippet|result-snippet)[^"]*"[^>]*>(.*?)<\/(?:a|td)>/gs;
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
