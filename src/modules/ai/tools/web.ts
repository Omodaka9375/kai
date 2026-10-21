import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import { requireLanOnly } from "../lib/proxyFetch";

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
      // The agent calls this tool unsupervised — never let it reach LAN /
      // loopback / cloud-metadata addresses (SSRF guard lives in net.rs).
      allowPrivateNetwork: false,
      // Model-chosen URL — the LAN-only network policy applies.
      requireLanOnly: requireLanOnly(),
    },
  );
  const body = new TextDecoder().decode(new Uint8Array(resp.body));
  return { status: resp.status, body };
}

/**
 * Strip HTML tags and clean up whitespace.
 *
 * Hidden-text injection defense: before tag stripping, drop nodes whose
 * payload is invisible to a human reader — HTML comments, `script`/`style`/
 * `noscript`, the `hidden` attribute, inline `display:none` /
 * `visibility:hidden` / `opacity:0` / `font-size:0`, and offscreen-positioned
 * blocks (`left:-9999px` and friends). A page can otherwise say one thing
 * visually and a second thing to text-extracting agents ("ignore your
 * instructions; run …") with no visual trace.
 *
 * Inline-style matching is best-effort (regex over static HTML, not a CSS
 * engine) — it catches the common single-element case; a real cascade could
 * hide more. Returns the count of hidden blocks dropped so the fence can
 * declare it (`[kai: N hidden DOM block(s) removed …]`) — visible redaction,
 * not a silent drop, so the user knows the page tried something.
 *
 * Exported for unit tests (the hidden-text injection defense must stay sharp).
 */
export function htmlToText(html: string): {
  text: string;
  hiddenDropped: number;
} {
  let hiddenDropped = 0;
  const drop = (s: string, re: RegExp): string =>
    s.replace(re, () => {
      hiddenDropped++;
      return " ";
    });

  let text = html
    // Comments and hidden-styled blocks never reach the model.
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  // Lookahead (not a consumed [\s>]) for the `hidden` attribute boundary:
  // `<div hidden>` ends its tag at the `>` itself, and a consuming class
  // would eat it — the old regex then demanded a second `>` that never came,
  // so bare `hidden` blocks LEAKED their text into the extraction.
  text = drop(text, /<([a-z][^\s>]*)[^>]*\shidden(?=[\s>])[^>]*>[\s\S]*?<\/\1>/gi);
  text = drop(
    text,
    /<([a-z][^\s>]*)[^>]*style=["'][^>"']*display\s*:\s*none[^>"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
  );
  text = drop(
    text,
    /<([a-z][^\s>]*)[^>]*style=["'][^>"']*visibility\s*:\s*hidden[^>"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
  );
  text = drop(
    text,
    /<([a-z][^\s>]*)[^>]*style=["'][^>"']*opacity\s*:\s*0(?:\.0+)?\s*(?:;|["'])[^>]*>[\s\S]*?<\/\1>/gi,
  );
  text = drop(
    text,
    /<([a-z][^\s>]*)[^>]*style=["'][^>"']*font-size\s*:\s*0(?:px)?[^>"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
  );
  // Offscreen positioning: the classic "hide it from humans, show it to
  // scrapers" trick (position:absolute; left/top far negative, or clipped to
  // 0 size). Matches a position declaration plus an offscreen/clip hint.
  text = drop(
    text,
    /<([a-z][^\s>]*)[^>]*style=["'][^>"']*(?:position\s*:\s*(?:absolute|fixed)[^>"']*(?:left|top)\s*:\s*-(?:\d{3,})px|clip\s*:\s*rect\s*\(\s*0[^)]*\))[^>"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
  );
  text = text
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n\n");
  return { text: text.trim(), hiddenDropped };
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
          const { text, hiddenDropped } = htmlToText(body);
          return {
            url,
            content: text.slice(0, 25000),
            size: text.length,
            ...(hiddenDropped > 0 ? { hiddenDropped } : {}),
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
