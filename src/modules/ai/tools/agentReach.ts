import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";

/**
 * Agent Reach bridge - read-only reach into platforms the built-in
 * web_search / web_browse handle poorly or not at all: login-walled and
 * Chinese platforms, video subtitles, and clean structured data
 * (GitHub issues+PRs with comments, YouTube captions, Bilibili, V2EX,
 * Reddit, XiaoHongShu, Xueqiu quotes, and a Jina/Exa web fallback).
 *
 * External tool (uv-installed `agent-reach`, https://github.com/Panniantong/Agent-Reach):
 * one CLI, one JSON output shape, read-only by design (its own README
 * pins "只读" - it cannot post, like, or message). KAI treats it exactly
 * like ffmpeg in terminalVideo: OPTIONAL, fail-soft, cached probe.
 *
 * SECURITY MODEL:
 *  - Read-only: the tool only ever runs `agent-reach <channel> <action>`,
 *    `agent-reach read <url>`, or `agent-reach channels`. The management
 *    verbs (setup/add/remove/login/logout/configure/uninstall/update)
 *    are DELIBERATELY NOT exposed to the model - a model-callable path to
 *    `configure` or `login` would let prompt injection flip credentials
 *    or open browser sessions. The user manages channels in a terminal.
 *  - Allowlist FIRST: channel+action pairs are validated against
 *    KNOWN_CHANNEL_ACTIONS (from `agent-reach channels`, the live source
 *    of truth) before anything is spawned. Unknown combos bounce with
    the table so the model self-corrects in one round-trip.
 *  - Injection-proof quoting: every argument is double-quoted for the
 *    shell AND rejected on ANY metachar ($ ` ; & " \ | < > newlines) -
 *    same reject-class as terminalVideo's shellQuote (PowerShell and
 *    POSIX dialects share all of these). A search term like `x"; rm -rf`
 *    never reaches a shell.
 *  - Output is REMOTE CONTENT: it lands in the transcript fenced (see
 *    toolPresentations), exactly like web_browse results.
 */

/** Management-style channel names must never be runnable here. */
const READ_ONLY_VERBS = new Set(["read", "channels"]);

type ChannelActions = Record<string, ReadonlySet<string>>;

/**
 * Channel/action table from `agent-reach channels` (v1.6.0). Read-only
 * actions only - the login-gated channels appear here too so the model
 * can ATTEMPT them and relay Agent Reach's structured NEED_LOGIN error
 * instead of guessing.
 */
const KNOWN_CHANNEL_ACTIONS: ChannelActions = {
  web: new Set(["search", "read"]),
  github: new Set(["search", "read"]),
  youtube: new Set(["read", "search", "subtitle", "transcribe"]),
  bilibili: new Set(["search", "read", "hot", "subtitle"]),
  v2ex: new Set(["hot", "node", "read", "user"]),
  reddit: new Set(["search", "read", "subreddit"]),
  twitter: new Set(["search", "profile", "tweets", "thread"]),
  facebook: new Set(["search", "profile"]),
  instagram: new Set(["search", "profile", "posts"]),
  xiaohongshu: new Set(["search", "read", "comments"]),
  xueqiu: new Set(["quote", "search", "hot_posts", "hot_stocks"]),
  boss: new Set(["search", "read"]),
  linkedin: new Set(["jobs", "read"]),
  xiaoyuzhou: new Set(["transcribe"]),
};

/**
 * Quote one argument for the shell AND reject every metachar live in
 * either PowerShell or POSIX: `"` breaks quoting, `$` + backtick
 * interpolate inside double quotes, `;`/`&`/`|` chain, `<`/`>` redirect,
 * backslash escapes. Same single-class reject as terminalVideo's
 * shellQuote (an earlier draft there had `&` outside the class and
 * accepted `x"; cmd; #` - statement injection; keep the class intact).
 */
export function reachQuoteForTest(s: string): string {
  if (/[$`;&"\\|<>\r\n]/.test(s)) {
    throw new Error(
      "unsupported characters in Agent Reach argument (metachars are rejected)",
    );
  }
  return `"${s}"`;
}

/** Cached presence probe - spawning a process per call is not free. */
let reachAvailable: boolean | null = null;
async function hasAgentReach(): Promise<boolean> {
  if (reachAvailable !== null) return reachAvailable;
  try {
    const { native } = await import("../lib/native");
    const r = await native.runCommand("agent-reach version", null, 20);
    reachAvailable = r.exit_code === 0 && (r.stdout ?? "").includes('"ok": true');
  } catch {
    reachAvailable = false;
  }
  return reachAvailable;
}

/** Reset the probe cache (uv installs mid-session). Test seam. */
export function resetReachProbeForTest(): void {
  reachAvailable = null;
}

const REACH_TIMEOUT_S = 120;

/**
 * Build the `agent-reach` command line for a validated call.
 * Exported for unit tests - the QUOTING gate is the security surface.
 */
export function buildReachCommand(args: {
  channel?: string;
  action?: string;
  url?: string;
  query?: string;
}): string {
  const parts = ["agent-reach"];
  if (args.url) {
    parts.push("read", reachQuoteForTest(args.url));
    return parts.join(" ");
  }
  if (!args.channel || !args.action) {
    throw new Error("channel and action are required (or url for agent-reach read)");
  }
  parts.push(reachQuoteForTest(args.channel), reachQuoteForTest(args.action));
  if (args.query) parts.push(reachQuoteForTest(args.query));
  return parts.join(" ");
}

/** Parse Agent Reach's one JSON output shape; surface its structured
 *  errors (NEED_SETUP / NEED_LOGIN / UPSTREAM_BROKEN / ...) verbatim so
 *  the model can tell the user exactly what to do next. */
export function parseReachOutput(out: string): {
  ok: boolean;
  channel?: string;
  items?: unknown;
  meta?: unknown;
  error?: unknown;
} {
  // The CLI prints exactly one JSON object per invocation (v1.6+), but be
  // tolerant of leading non-JSON lines (update notices) by slicing from
  // the first '{'.
  const start = out.indexOf("{");
  if (start === -1) throw new Error("Agent Reach printed no JSON output");
  const parsed = JSON.parse(out.slice(start)) as {
    ok?: boolean;
    channel?: string;
    items?: unknown;
    meta?: unknown;
    error?: unknown;
  };
  return {
    ok: parsed.ok === true,
    channel: parsed.channel,
    items: parsed.items,
    meta: parsed.meta,
    error: parsed.error,
  };
}

export function buildAgentReachTools(_ctx: ToolContext) {
  return {
    agent_reach: tool({
      needsApproval: false,
      description:
        "Search and read platforms the built-in web tools cannot reach, via the locally installed Agent Reach CLI (read-only, structured JSON): GitHub repos/issues/PRs with comments, YouTube video info + full subtitles, Bilibili search/info/subtitles, V2EX topics and replies, Reddit posts/comments, XiaoHongShu notes, Xueqiu stock quotes, X/Twitter search, LinkedIn/BOSS job listings, and a semantic web search/read fallback (Jina/Exa). Call with {channel, action, query} e.g. {channel:'github', action:'search', query:'tauri terminal'} - or {url} to auto-pick the channel for a link (e.g. a GitHub issue or Bilibili video URL). Run {channel:'channels'}-style listing via agent_reach_list instead. Errors come back structured (NEED_LOGIN means the user must run `agent-reach login <channel>` in a terminal; NEED_SETUP means the channel is not enabled). Auto-executes (read-only).",
      inputSchema: z.object({
        channel: z
          .string()
          .optional()
          .describe("Channel name, e.g. github, youtube, bilibili, v2ex, reddit, twitter, xiaohongshu, xueqiu, web."),
        action: z
          .string()
          .optional()
          .describe("Action for the channel, e.g. search, read, subtitle, hot. See agent_reach_list for the live table."),
        query: z
          .string()
          .optional()
          .describe("Search query, URL, or argument for the action (e.g. the video URL for youtube subtitle)."),
        url: z
          .string()
          .optional()
          .describe("Direct link to read - Agent Reach picks the matching channel itself. Overrides channel/action."),
      }),
      execute: async ({ channel, action, query, url }) => {
        if (!(await hasAgentReach())) {
          return {
            error:
              "Agent Reach is not installed on this machine. Ask the user to run: uv tool install https://github.com/Panniantong/Agent-Reach/releases/latest/download/agent-reach.zip then `agent-reach setup` in a terminal (no admin password needed). Do not attempt the install yourself.",
          };
        }
        // URL mode: agent-reach read <url> (the CLI validates routing).
        if (url) {
          if (!/^https?:\/\//i.test(url)) {
            return { error: "url must be an http(s) link" };
          }
          try {
            const cmd = buildReachCommand({ url });
            const { native } = await import("../lib/native");
            const r = await native.runCommand(cmd, null, REACH_TIMEOUT_S);
            if (r.exit_code !== 0) {
              return { error: (r.stderr ?? "").slice(0, 400) || `agent-reach exited ${r.exit_code}` };
            }
            return parseReachOutput(r.stdout ?? "");
          } catch (e) {
            return { error: String(e) };
          }
        }
        // Channel mode: allowlist BEFORE spawn. channels is not a channel.
        if (!channel || !action) {
          return { error: "Provide channel+action+query, or a url. Use agent_reach_list for the table." };
        }
        if (READ_ONLY_VERBS.has(action)) {
          return { error: `'${action}' is not a channel action - use agent_reach_list for the channel table.` };
        }
        const allowed = KNOWN_CHANNEL_ACTIONS[channel];
        if (!allowed) {
          return {
            error: `unknown channel '${channel}'. Known: ${Object.keys(KNOWN_CHANNEL_ACTIONS).join(", ")}.`,
          };
        }
        if (!allowed.has(action)) {
          return {
            error: `channel '${channel}' does not support '${action}'. Supported: ${[...allowed].join(", ")}.`,
          };
        }
        try {
          const cmd = buildReachCommand({ channel, action, query });
          const { native } = await import("../lib/native");
          const r = await native.runCommand(cmd, null, REACH_TIMEOUT_S);
          if (r.exit_code !== 0) {
            return { error: (r.stderr ?? "").slice(0, 400) || `agent-reach exited ${r.exit_code}` };
          }
          return parseReachOutput(r.stdout ?? "");
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    agent_reach_list: tool({
      needsApproval: false,
      description:
        "List the Agent Reach channels available on THIS machine right now, with each channel's supported read actions and login/key requirements (live from `agent-reach channels`). Use this before agent_reach to discover what is enabled, and after any NEED_SETUP/NEED_LOGIN error to see what the user must enable. Auto-executes (read-only).",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasAgentReach())) {
          return {
            error:
              "Agent Reach is not installed on this machine. Ask the user to run: uv tool install https://github.com/Panniantong/Agent-Reach/releases/latest/download/agent-reach.zip then `agent-reach setup` in a terminal. Do not attempt the install yourself.",
          };
        }
        try {
          const { native } = await import("../lib/native");
          const r = await native.runCommand("agent-reach channels", null, 30);
          if (r.exit_code !== 0) {
            return { error: (r.stderr ?? "").slice(0, 400) || `agent-reach exited ${r.exit_code}` };
          }
          return parseReachOutput(r.stdout ?? "");
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  };
}
