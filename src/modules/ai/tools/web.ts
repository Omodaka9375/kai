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
  // In the webview, remove hidden DOM subtrees rather than trying to match
  // balanced HTML with regexes (nested same-name elements defeat those).
  // Keep the tested static fallback below for Node/unit tests and unusual
  // non-DOM callers.
  if (typeof DOMParser !== "undefined") {
    return htmlToTextDom(html);
  }
  let hiddenDropped = 0;
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
  text = dropHiddenHtmlBlocks(text, () => {
    hiddenDropped++;
  });
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

/** Non-DOM fallback: scan tags with a depth counter instead of pairing open
 *  and close tags with regexes. Handles nested same-name elements and quoted
 *  `>` characters without backtracking. */
function dropHiddenHtmlBlocks(html: string, onDrop: () => void): string {
  type Tag = { name: string; start: number; end: number; closing: boolean; selfClosing: boolean; hidden: boolean };
  const tags: Tag[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) break;
    let quote = "";
    let end = start + 1;
    for (; end < html.length; end++) {
      const ch = html[end]!;
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
    }
    if (end >= html.length) break;
    const inside = html.slice(start + 1, end);
    const match = /^(\/?)\s*([a-zA-Z][\w:-]*)/.exec(inside);
    if (match) {
      const closing = match[1] === "/";
      const name = match[2]!.toLowerCase();
      const selfClosing = /\/\s*$/.test(inside) || name === "br" || name === "img" || name === "input" || name === "meta" || name === "link" || name === "hr";
      const attrs = inside.slice(match[0].length);
      const style = /(?:^|\s)style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
      const css = (style?.[1] ?? style?.[2] ?? style?.[3] ?? "").toLowerCase();
      const hidden =
        /(?:^|\s)hidden(?=\s|=|\/|$)/i.test(attrs) ||
        /display\s*:\s*none/i.test(css) ||
        /visibility\s*:\s*hidden/i.test(css) ||
        /opacity\s*:\s*(?:0(?:\.0+)?|\.0+)(?=\s|;|!|$)/i.test(css) ||
        /font-size\s*:\s*0(?:\.0+)?(?:px)?(?=\s|;|!|$)/i.test(css) ||
        (/position\s*:\s*(?:absolute|fixed)/i.test(css) && /(?:left|top)\s*:\s*-\d{3,}px/i.test(css)) ||
        /clip\s*:\s*rect\s*\(\s*0/i.test(css);
      tags.push({ name, start, end: end + 1, closing, selfClosing, hidden });
    }
    cursor = end + 1;
  }

  // Record excluded RANGES rather than reconstructing from the visible
  // parent stack. A hidden child inside a visible parent is removed without
  // suppressing the parent's other visible children.
  const excluded: Array<{ start: number; end: number }> = [];
  const stack: Array<{ name: string; start: number; hidden: boolean }> = [];
  for (const tag of tags) {
    if (!tag.closing) {
      if (!tag.selfClosing) {
        stack.push({ name: tag.name, start: tag.start, hidden: tag.hidden });
      } else if (tag.hidden) {
        excluded.push({ start: tag.start, end: tag.end });
        onDrop();
      }
      continue;
    }
    let openIndex = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]!.name === tag.name) {
        openIndex = i;
        break;
      }
    }
    if (openIndex < 0) continue;
    const removed = stack.splice(openIndex);
    if (removed.some((entry) => entry.hidden)) {
      excluded.push({ start: removed[0]!.start, end: tag.end });
      onDrop();
    }
  }
  if (stack.some((entry) => entry.hidden)) {
    excluded.push({ start: stack[0]!.start, end: html.length });
    onDrop();
  }
  // Inner hidden elements close before their outer parent, producing nested
  // ranges. Sort + merge first, or the outer range is skipped and its secrets
  // leak back into the visible reconstruction.
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of [...excluded].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  let out = "";
  let cursorOut = 0;
  for (const range of merged) {
    out += html.slice(cursorOut, range.start);
    cursorOut = range.end;
  }
  return out + html.slice(cursorOut);
}

/** DOM implementation for the browser: hidden elements are removed as whole
 *  subtrees, so a nested <div> cannot terminate the match early and leak the
 *  remainder of a hidden parent into model-visible text. */
function htmlToTextDom(html: string): { text: string; hiddenDropped: number } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let hiddenDropped = 0;
  for (const element of Array.from(doc.querySelectorAll("script, style, noscript"))) {
    element.remove();
  }
  const candidates = Array.from(
    doc.querySelectorAll<HTMLElement>("[hidden], [style]"),
  );
  for (const element of candidates) {
    const style = element.style;
    const css = element.getAttribute("style")?.toLowerCase() ?? "";
    const left = Number.parseInt(style.left, 10);
    const top = Number.parseInt(style.top, 10);
    const positioned = style.position === "absolute" || style.position === "fixed";
    const offscreen = positioned && ((left <= -100 || top <= -100) || /clip\s*:\s*rect\s*\(\s*0/i.test(css));
    const hidden =
      element.hasAttribute("hidden") ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number.parseFloat(style.opacity) === 0 ||
      Number.parseFloat(style.fontSize) === 0 ||
      offscreen;
    if (!hidden) continue;
    // An ancestor already removed takes its descendants with it.
    if (!element.isConnected) continue;
    element.remove();
    hiddenDropped++;
  }
  const text = (doc.body?.textContent ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .trim();
  return { text, hiddenDropped };
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
        let bingError: unknown = null;
        try {
          // Primary: Bing's RSS serializer (reliable, not bot-walled). Empty
          // results AND request/parser failures both fall through to DDG.
          try {
            const bing = await bingSearch(query);
            if (bing.length > 0) return { query, engine: "bing", results: bing };
          } catch (error) {
            bingError = error;
          }

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
          return {
            error: String(e),
            query,
            ...(bingError
              ? { note: `Bing RSS also failed: ${String(bingError)}` }
              : {}),
          };
        }
      },
    }),
  } as const;
}
