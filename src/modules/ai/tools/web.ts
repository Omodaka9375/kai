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
  // ── Canonicalize the style surface BEFORE the drop regexes so legal HTML
  // variants don't evade them: 'style  =  "..."' (whitespace around = is
  // legal), unquoted values (style=display:none), and 'display: NONE' casing.
  // One pass over each tag's style attribute: squeeze the =, quote an
  // unquoted value, lowercase the declaration text. Best-effort (regex, not a
  // CSS engine) — but it closes the trivial one-character evasions that each
  // drop regex below would otherwise miss.
  text = text.replace(
    /(<[a-z][^>]*?\sstyle)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)(?=[\s>])/gi,
    (_m: string, pre: string, css: string) => {
      const quoted = /^["']/.test(css) ? css : `"${css}"`;
      return `${pre}=${quoted.toLowerCase()}`;
    },
  );
  // Lookahead (not a consumed [\s>]) for the `hidden` attribute boundary:
  // `<div hidden>` ends its tag at the `>` itself, and a consuming class
  // would eat it — the old regex then demanded a second `>` that never came,
  // so bare `hidden` blocks LEAKED their text into the extraction.
  // `hidden=""` / `hidden=anything` hides the same way in HTML.
  text = drop(text, /<([a-z][^\s>]*)[^>]*\shidden(?=[\s=>])[^>]*>[\s\S]*?<\/\1>/gi);
  text = drop(
    text,
    /<([a-z][^\s>]*)[^>]*style=["'][^>"']*display\s*:\s*none[^>"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
  );
  text = drop(
    text,
    /<([a-z][^\s>]*)[^>]*style=["'][^>"']*visibility\s*:\s*hidden[^>"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
  );
  // `opacity:0` in any legal spelling: `0.0`, `.0`, trailing `!important`,
  // or followed by another declaration — the old `\s*(?:;|["'])` demanded
  // the value end immediately and missed `opacity:0 !important`. The
  // lookahead `(?=[\s;"'])` is the boundary: `opacity:0.95` is VISIBLE and
  // must NOT match (a bare `0` followed by a fraction). Same for font-size.
  text = drop(
    text,
    /<([a-z][^\s>]*)[^>]*style=["'][^>"']*opacity\s*:\s*(?:0(?:\.0+)?|\.0+)(?=[\s;"'])[^>]*>[\s\S]*?<\/\1>/gi,
  );
  text = drop(
    text,
    /<([a-z][^\s>]*)[^>]*style=["'][^>"']*font-size\s*:\s*0(?:\.0+)?(?:px)?(?=[\s;"'])[^>"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
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

// ── Web search engines: Bing RSS (primary) + DuckDuckGo (fallback) ─────────
//
// DuckDuckGo's scrapable endpoints (lite + html) now answer anonymous
// programmatic requests with an HTTP 202 "anomaly" interstitial — zero result
// links in the body — so scraping harder cannot help; the ENGINE must change.
// Bing exposes a stable RSS serializer (`&format=rss`) that returns real
// machine-readable <item> entries to a plain GET, no JS, no bot-wall;
// `&setlang=en` keeps results locale-stable. DDG stays as the fallback in case
// Bing's RSS shape ever changes (the web_search tool tries Bing, then DDG).

/** XML entity decoder for RSS text (named + numeric entities). */
export function decodeXml(s: string): string {
  // XML has only 5 predefined entities, but Bing/RSS titles carry the common
  // HTML typographic ones too — an undecoded `&mdash;` shows up verbatim.
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    lsquo: "‘",
    rsquo: "’",
    ldquo: "“",
    rdquo: "”",
    middot: "·",
    bull: "•",
    times: "×",
    deg: "°",
    laquo: "«",
    raquo: "»",
    euro: "€",
    pound: "£",
    copy: "©",
    reg: "®",
    trade: "™",
  };
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, e: string) => named[e] ?? m);
}

/** CDATA / tag / whitespace cleanup for one RSS field. */
function rssField(inner: string): string {
  return decodeXml(inner.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, ""))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type WebSearchResult = { title: string; url: string; snippet?: string };

/** Parse Bing's `search?...&format=rss` XML into results (pure, unit-tested).
 *  Items without an absolute http(s) link are dropped (nav/ad stubs). */
export function parseBingRss(xml: string): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const field = (tag: string): string => {
      const mm = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
      return mm ? rssField(mm[1]) : "";
    };
    const title = field("title");
    const link = field("link");
    const snippet = field("description");
    if (title && /^https?:\/\//i.test(link))
      out.push({ title, url: link, ...(snippet ? { snippet } : {}) });
  }
  return out.slice(0, 10);
}

/** Bing RSS search through the SSRF-hardened proxy GET. An empty array on a
 *  non-200 / item-less body signals "fall back to DDG" to the caller. */
async function bingSearch(query: string): Promise<WebSearchResult[]> {
  const url =
    "https://www.bing.com/search?q=" +
    encodeURIComponent(query) +
    "&format=rss&count=10&setlang=en";
  const { status, body } = await httpFetch(url);
  if (status !== 200 || !body || !body.includes("<item>")) return [];
  return parseBingRss(body);
}

export function buildWebTools(_ctx: ToolContext) {
  return {
    web_browse: tool({
      description:
        "Fetch a web page over HTTP and return its readable text (HTML tags stripped). No JavaScript execution or browser rendering — client-side-rendered / SPA pages may come back empty or partial, and bot-protected endpoints can refuse the request. Best for static pages: documentation, articles, READMEs. Auto-executes (read-only).",
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
        "Search the web and return the top results with titles, URLs, and snippets (backed by Bing, with a DuckDuckGo fallback). Useful for finding documentation, answers, or current information. Auto-executes (read-only).",
      inputSchema: z.object({
        query: z.string().describe("The search query."),
      }),
      execute: async ({ query }) => {
        try {
          // Primary: Bing's RSS serializer (reliable, not bot-walled). If it
          // yields nothing (shape change / block / non-200), fall through to
          // the legacy DDG scraper below.
          const bing = await bingSearch(query);
          if (bing.length > 0) return { query, engine: "bing", results: bing };

          // ── Fallback: DDG lite endpoint with POST. The Accept-Encoding is
          // handled by Rust reqwest (gzip/deflate enabled in Cargo.toml).
          // NOTE: DDG currently returns a 202 "anomaly" interstitial to
          // anonymous programmatic requests, so this path usually yields 0 —
          // kept only in case Bing also degrades.
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
              // The query text is user content the user chose to search for —
              // but the DESTINATION is still the public internet. Under the
              // LAN-only network policy, web_search must not exfiltrate the
              // query off-box any more than web_browse may fetch a page.
              // web_browse passes requireLanOnly too; this was the
              // one model-callable fetch that forgot it.
              requireLanOnly: requireLanOnly(),
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
          return {
            query,
            engine: "duckduckgo",
            results: results.slice(0, 10),
            ...(results.length === 0
              ? {
                  note:
                    "Both search engines returned no results — Bing RSS was " +
                    "empty and DuckDuckGo is currently bot-walled. Try " +
                    "rephrasing the query, or web_browse a URL directly.",
                }
              : {}),
          };
        } catch (e) {
          return { error: String(e), query };
        }
      },
    }),
  } as const;
}
