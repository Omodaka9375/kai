import { tool } from "ai";
import { z } from "zod";
import { htmlToText } from "./web";
import { webGet, webGetJson } from "../lib/webFetch";
import type { ToolContext } from "./context";

/**
 * Platform reach — KAI's NATIVE implementation of the Agent-Reach approach
 * (https://github.com/Panniantong/Agent-Reach): give the agent reach into
 * platforms that generic web search handles poorly, via per-platform
 * channel adapters with a uniform result shape. No external CLI, no PATH
 * trust, no extra binaries: every fetch goes through the SSRF-hardened
 * Rust proxy like web_browse does.
 *
 * Only platforms with CLEAN PUBLIC HTTP interfaces are here — that is the
 * deliberate scope. Login-walled platforms (Xiaohongshu, LinkedIn, BOSS,
 * logged-in X/Twitter) are NOT here: they need a managed browser session
 * (Agent Reach's opencli/CloakBrowser machinery), which KAI deliberately
 * does not embed. X search is covered by the separate social_read tool.
 *
 * Channel table + per-action fetchers, one result shape:
 *   { channel, action, items: [{title, url, author?, date?, text}], note? }
 */

export type ReachItem = {
  title: string;
  url: string;
  author?: string;
  date?: string;
  text?: string;
};

export type ReachResult = {
  channel: string;
  action: string;
  items: ReachItem[];
  note?: string;
};

const MAX_ITEMS = 10;
const MAX_TEXT = 4000;

// ── GitHub (public REST API — no key, no login) ─────────────────────────

function ghRepoFromUrl(url: string): { owner: string; repo: string } | null {
  const m = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
    url,
  );
  return m ? { owner: m[1], repo: m[2] } : null;
}

function ghIssueRef(url: string): { kind: "issues" | "pull"; owner: string; repo: string; num: number } | null {
  const m =
    /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)\/?$/i.exec(
      url,
    );
  if (!m) return null;
  return {
    kind: m[3].toLowerCase() === "pull" ? "pull" : "issues",
    owner: m[1],
    repo: m[2],
    num: Number(m[4]),
  };
}

type GhComment = { user?: { login?: string }; body?: string; created_at?: string };

async function ghSearch(q: string): Promise<ReachResult> {
  const data = await webGetJson<{
    total_count?: number;
    items?: Array<{
      full_name?: string;
      html_url?: string;
      description?: string;
      stargazers_count?: number;
      language?: string;
      pushed_at?: string;
    }>;
  }>(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=${MAX_ITEMS}`);
  const items: ReachItem[] = (data?.items ?? []).map((r) => ({
    title: r.full_name ?? "",
    url: r.html_url ?? "",
    author: r.language ?? undefined,
    date: r.pushed_at,
    text: [
      r.description ?? "",
      r.stargazers_count != null ? `★ ${r.stargazers_count}` : "",
    ]
      .filter(Boolean)
      .join(" — "),
  }));
  return { channel: "github", action: "search", items };
}

async function ghRead(url: string): Promise<ReachResult> {
  // Issue / PR with comments
  const ref = ghIssueRef(url);
  if (ref) {
    const apiBase = `https://api.github.com/repos/${ref.owner}/${ref.repo}`;
    const isPull = ref.kind === "pull";
    const main = await webGetJson<Record<string, unknown>>(
      `${apiBase}/${isPull ? "pulls" : "issues"}/${ref.num}`,
    );
    if (!main) return { channel: "github", action: "read", items: [], note: "not found or rate-limited" };
    const comments = await webGetJson<GhComment[]>(
      `${apiBase}/issues/${ref.num}/comments?per_page=30`,
    );
    const body = String(main.body ?? "");
    const parts: string[] = [
      `# ${String(main.title ?? "")} (${isPull ? "PR" : "issue"} #${ref.num}, state: ${String(main.state ?? "")})`,
      body.length > MAX_TEXT ? `${body.slice(0, MAX_TEXT)}…` : body,
    ];
    for (const c of comments ?? []) {
      const t = String(c.body ?? "").slice(0, 800);
      parts.push(`— ${c.user?.login ?? "unknown"} (${c.created_at ?? ""}): ${t}`);
    }
    return {
      channel: "github",
      action: "read",
      items: [
        {
          title: String(main.title ?? ""),
          url,
          author: (main.user as { login?: string } | undefined)?.login,
          date: String(main.created_at ?? main.updated_at ?? ""),
          text: parts.join("\n\n").slice(0, 20000),
        },
      ],
    };
  }
  // Repository (with README)
  const repo = ghRepoFromUrl(url);
  if (repo) {
    const apiBase = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
    const meta = await webGetJson<Record<string, unknown>>(apiBase);
    if (!meta) return { channel: "github", action: "read", items: [], note: "not found or rate-limited" };
    const readme = await webGetJson<{ content?: string; encoding?: string }>(
      `${apiBase}/readme`,
    );
    let readmeText = "";
    if (readme?.content) {
      try {
        const b64 = readme.content.replace(/\n/g, "");
        const bin = atob(b64);
        readmeText = bin.length > 12000 ? `${bin.slice(0, 12000)}…` : bin;
      } catch {
        readmeText = "";
      }
    }
    return {
      channel: "github",
      action: "read",
      items: [
        {
          title: String(meta.full_name ?? ""),
          url,
          author: String(meta.language ?? ""),
          date: String(meta.pushed_at ?? ""),
          text: [
            String(meta.description ?? ""),
            `★ ${String(meta.stargazers_count ?? "?")} · issues ${String(meta.open_issues_count ?? "?")} · license ${(meta.license as { spdx_id?: string } | null)?.spdx_id ?? "none"}`,
            readmeText ? `\n## README\n${readmeText}` : "",
          ]
            .filter(Boolean)
            .join("\n")
            .slice(0, 20000),
        },
      ],
    };
  }
  return { channel: "github", action: "read", items: [], note: "unsupported GitHub URL shape" };
}

// ── V2EX (public API) ───────────────────────────────────────────────────

async function v2exHot(): Promise<ReachResult> {
  const data = await webGetJson<
    Array<{ id?: number; title?: string; url?: string; member?: { username?: string }; last_touched?: number }>
  >("https://www.v2ex.com/api/topics/hot.json");
  const items: ReachItem[] = (data ?? []).slice(0, MAX_ITEMS).map((t) => ({
    title: t.title ?? "",
    url: t.url ?? (t.id != null ? `https://www.v2ex.com/t/${t.id}` : ""),
    author: t.member?.username,
    date: t.last_touched ? new Date(t.last_touched * 1000).toISOString() : undefined,
    text: "",
  }));
  return { channel: "v2ex", action: "hot", items };
}

async function v2exRead(url: string): Promise<ReachResult> {
  const m = /v2ex\.com\/t\/(\d+)/i.exec(url);
  if (!m) return { channel: "v2ex", action: "read", items: [], note: "expected a /t/<id> topic URL" };
  const topic = await webGetJson<
    Array<{
      title?: string;
      content?: string;
      member?: { username?: string };
      created?: number;
    }>
  >(`https://www.v2ex.com/api/topics/show.json?id=${m[1]}`);
  const replies = await webGetJson<
    Array<{ content?: string; member?: { username?: string }; created?: number }>
  >(`https://www.v2ex.com/api/replies/show.json?topic_id=${m[1]}&page_size=${MAX_ITEMS}`);
  const t = topic?.[0];
  const parts = [
    `# ${t?.title ?? ""}`,
    t?.content ?? "",
    ...(replies ?? []).map(
      (r) =>
        `— ${r.member?.username ?? "unknown"}: ${String(r.content ?? "").replace(/<[^>]+>/g, "").slice(0, 600)}`,
    ),
  ];
  return {
    channel: "v2ex",
    action: "read",
    items: [
      {
        title: t?.title ?? "",
        url,
        author: t?.member?.username,
        date: t?.created ? new Date(t.created * 1000).toISOString() : undefined,
        text: parts.join("\n\n").slice(0, 20000),
      },
    ],
  };
}

// ── Reddit (public JSON endpoints — logged out) ─────────────────────────
// Reddit intermittently 403s anonymous requests to *.json with an HTML
// block page (verified 2026-10-31: both www and old. return 403 from this
// network). The adapter degrades honestly: on a 403/HTML response it
// returns a structured note with the working alternatives instead of
// pretending. When reddit's wall is down (or from a network it permits),
// the JSON path returns the full structured data.

function redditBlockedNote(action: string): ReachResult {
  return {
    channel: "reddit",
    action,
    items: [],
    note: "Reddit is refusing anonymous API requests from this network right now (HTTP 403 block page). Alternatives: web_search with site:reddit.com, or ask the user to install the Agent Reach CLI (agent-reach add reddit) which uses a real browser session.",
  };
}

async function redditSearch(q: string): Promise<ReachResult> {
  const r = await webGet(
    `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&limit=${MAX_ITEMS}`,
    { headers: { Accept: "application/json" } },
  );
  if (r.status === 403 || !r.body.trim().startsWith("{")) {
    return redditBlockedNote("search");
  }
  const data = JSON.parse(r.body) as {
    data?: { children?: Array<{ data?: Record<string, unknown> }> };
  };
  const items: ReachItem[] = (data.data?.children ?? []).map((c) => {
    const d = c.data ?? {};
    return {
      title: String(d.title ?? ""),
      url: `https://www.reddit.com${String(d.permalink ?? "")}`,
      author: String(d.author ?? ""),
      date: d.created_utc ? new Date(Number(d.created_utc) * 1000).toISOString() : undefined,
      text: `${String(d.ups ?? 0)} upvotes · ${String(d.num_comments ?? 0)} comments · r/${String(d.subreddit ?? "")}\n${String(d.selftext ?? "").slice(0, 1200)}`,
    };
  });
  return { channel: "reddit", action: "search", items };
}

async function redditRead(url: string): Promise<ReachResult> {
  const m = /reddit\.com\/r\/([\w-]+)\/comments\/([\w-]+)/i.exec(url);
  if (!m) return { channel: "reddit", action: "read", items: [], note: "expected a post comments URL" };
  const r = await webGet(`${url.replace(/\/?$/, "")}.json?limit=30`, {
    headers: { Accept: "application/json" },
  });
  if (r.status === 403 || !r.body.trim().startsWith("{")) {
    return redditBlockedNote("read");
  }
  const pages = JSON.parse(r.body) as Array<{
    data?: { children?: Array<{ data?: Record<string, unknown> }> };
  }>;
  const post = pages?.[0]?.data?.children?.[0]?.data;
  if (!post) return { channel: "reddit", action: "read", items: [], note: "not found" };
  const comments = (pages?.[1]?.data?.children ?? []) as Array<{ data?: Record<string, unknown> }>;
  const flat: string[] = [];
  const walk = (node: { data?: Record<string, unknown> }, depth: number) => {
    if (!node.data || depth > 3) return;
    const body = String(node.data.body ?? "").replace(/\s+/g, " ").trim();
    if (body) {
      flat.push(`${"  ".repeat(depth)}— ${String(node.data.author ?? "?")} (${String(node.data.ups ?? 0)}): ${body.slice(0, 500)}`);
    }
    const replies = node.data.replies as
      | { data?: { children?: Array<{ data?: Record<string, unknown>; kind?: string }> } }
      | string
      | undefined;
    if (replies && typeof replies !== "string") {
      for (const child of replies.data?.children ?? []) {
        if (child.kind === "t1") walk(child as never, depth + 1);
      }
    }
  };
  for (const c of comments) walk(c as never, 0);
  return {
    channel: "reddit",
    action: "read",
    items: [
      {
        title: String(post.title ?? ""),
        url,
        author: String(post.author ?? ""),
        date: post.created_utc
          ? new Date(Number(post.created_utc) * 1000).toISOString()
          : undefined,
        text: `${String(post.ups ?? 0)} upvotes · ${String(post.num_comments ?? 0)} comments · r/${String(post.subreddit ?? "")}\n\n${String(post.selftext ?? "").slice(0, 2000)}\n\n${flat.join("\n").slice(0, 15000)}`,
      },
    ],
  };
}

// ── Hacker News (Algolia public API — bonus channel, same pattern) ───────

async function hnSearch(q: string): Promise<ReachResult> {
  const data = await webGetJson<{
    hits?: Array<{
      title?: string;
      url?: string;
      objectID?: string;
      author?: string;
      created_at?: string;
      points?: number;
      num_comments?: number;
      story_text?: string;
    }>;
  }>(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&hitsPerPage=${MAX_ITEMS}`);
  const items: ReachItem[] = (data?.hits ?? []).map((h) => ({
    title: h.title ?? "",
    url: h.url ?? (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : ""),
    author: h.author,
    date: h.created_at,
    text: `${h.points ?? 0} points · ${h.num_comments ?? 0} comments\n${String(h.story_text ?? "").slice(0, 600)}`,
  }));
  return { channel: "hackernews", action: "search", items };
}

// ── Stack Exchange (public API) ─────────────────────────────────────────

async function stackSearch(q: string): Promise<ReachResult> {
  const data = await webGetJson<{
    items?: Array<{
      title?: string;
      link?: string;
      owner?: { display_name?: string };
      creation_date?: number;
      score?: number;
      answer_count?: number;
      is_answered?: boolean;
      tags?: string[];
    }>;
  }>(
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(q)}&site=stackoverflow&pagesize=${MAX_ITEMS}`,
  );
  const items: ReachItem[] = (data?.items ?? []).map((s) => ({
    title: String(s.title ?? "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"),
    url: s.link ?? "",
    author: s.owner?.display_name,
    date: s.creation_date ? new Date(s.creation_date * 1000).toISOString() : undefined,
    text: `score ${s.score ?? 0} · ${s.answer_count ?? 0} answers${s.is_answered ? " · answered" : ""}${s.tags?.length ? ` · ${s.tags.join(", ")}` : ""}`,
  }));
  return { channel: "stackoverflow", action: "search", items };
}

// ── YouTube (public oEmbed for info; no key needed for metadata) ─────────

async function youtubeInfo(url: string): Promise<ReachResult> {
  const id = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{6,})/i.exec(url);
  if (!id) return { channel: "youtube", action: "read", items: [], note: "unrecognized YouTube URL" };
  const data = await webGetJson<{
    title?: string;
    author_name?: string;
    thumbnail_url?: string;
  }>(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id[1]}`)}&format=json`);
  return {
    channel: "youtube",
    action: "read",
    items: [
      {
        title: data?.title ?? "",
        url: `https://www.youtube.com/watch?v=${id[1]}`,
        author: data?.author_name,
        text: data
          ? `Video by ${data.author_name}. Description/subtitles require a data API key or a transcript tool — this surface is metadata-only.`
          : "video unavailable or private",
      },
    ],
  };
}

// ── Channel table ───────────────────────────────────────────────────────

export type ChannelDef = {
  actions: ReadonlySet<string>;
  run: (args: { action: string; query?: string; url?: string }) => Promise<ReachResult>;
};

export const CHANNELS: Record<string, ChannelDef> = {
  github: {
    actions: new Set(["search", "read"]),
    run: async ({ action, query, url }) =>
      action === "search" ? ghSearch(query ?? "") : ghRead(url ?? ""),
  },
  v2ex: {
    actions: new Set(["hot", "read"]),
    run: async ({ action, url }) =>
      action === "hot" ? v2exHot() : v2exRead(url ?? ""),
  },
  reddit: {
    actions: new Set(["search", "read"]),
    run: async ({ action, query, url }) =>
      action === "search" ? redditSearch(query ?? "") : redditRead(url ?? ""),
  },
  hackernews: {
    actions: new Set(["search"]),
    run: async ({ query }) => hnSearch(query ?? ""),
  },
  stackoverflow: {
    actions: new Set(["search"]),
    run: async ({ query }) => stackSearch(query ?? ""),
  },
  youtube: {
    actions: new Set(["read"]),
    run: async ({ url }) => youtubeInfo(url ?? ""),
  },
};

/** Map a URL to the channel that can read it natively. */
export function channelForUrl(url: string): { channel: string; action: string } | null {
  if (/^https?:\/\/(?:www\.)?github\.com\//i.test(url)) {
    if (ghIssueRef(url) || ghRepoFromUrl(url)) return { channel: "github", action: "read" };
  }
  if (/^https?:\/\/(?:www\.)?v2ex\.com\/t\/\d+/i.test(url)) return { channel: "v2ex", action: "read" };
  if (/^https?:\/\/(?:www\.)?reddit\.com\/r\/[\w-]+\/comments\//i.test(url))
    return { channel: "reddit", action: "read" };
  if (/^https?:\/\/(?:www\.|m\.)?youtube\.com\/watch|youtu\.be\//i.test(url))
    return { channel: "youtube", action: "read" };
  return null;
}

const PLATFORM_TOOL_DESCRIPTION = `Reach into specific platforms with dedicated structured adapters (public APIs, read-only, no login): github (search repos; read a repo with its README, or an issue/PR WITH its comment thread), reddit (search posts; read a post with its comment tree), v2ex (hot topics; read a topic with replies), hackernews (search), stackoverflow (search), youtube (video metadata). Call with {channel, action, query} for search-style actions, or {url} to auto-pick the channel. Prefer this over web_browse when the target is one of these platforms — it returns clean structured data instead of scraped HTML. Results include comments and metadata web scraping cannot get.`;

export function buildPlatformReachTools(_ctx: ToolContext) {
  return {
    platform_reach: tool({
      needsApproval: false,
      description: PLATFORM_TOOL_DESCRIPTION,
      inputSchema: z.object({
        channel: z
          .string()
          .optional()
          .describe("Channel: github, reddit, v2ex, hackernews, stackoverflow, or youtube."),
        action: z
          .string()
          .optional()
          .describe("Channel action: search, read, or hot (v2ex)."),
        query: z
          .string()
          .optional()
          .describe("Search query, or the URL for read actions."),
        url: z
          .string()
          .optional()
          .describe("Direct link to read - overrides channel/action with auto-routing."),
      }),
      execute: async ({ channel, action, query, url }) => {
        try {
          if (url) {
            const routed = channelForUrl(url);
            if (routed) {
              return await CHANNELS[routed.channel].run({
                action: routed.action,
                url,
              });
            }
            return { error: "no native channel for that URL — use web_browse" };
          }
          if (!channel || !action) {
            return {
              error: "provide channel + action (+query or url), or a url",
              channels: Object.fromEntries(
                Object.entries(CHANNELS).map(([k, v]) => [k, [...v.actions]]),
              ),
            };
          }
          const def = CHANNELS[channel];
          if (!def) {
            return {
              error: `unknown channel '${channel}'`,
              channels: Object.fromEntries(
                Object.entries(CHANNELS).map(([k, v]) => [k, [...v.actions]]),
              ),
            };
          }
          if (!def.actions.has(action)) {
            return {
              error: `channel '${channel}' supports: ${[...def.actions].join(", ")}`,
            };
          }
          return await def.run({ action, query, url });
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  };
}

// Re-exported for web_browse's routing (kept out of the public tool shape).
export { htmlToText };
