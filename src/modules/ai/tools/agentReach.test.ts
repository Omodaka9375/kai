import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildReachCommand,
  parseReachOutput,
  reachQuoteForTest,
} from "./agentReach";

/**
 * Agent Reach bridge contract (2026-10-31).
 *
 * "Improve our agent's search tools with https://github.com/Panniantong/Agent-Reach"
 * — Agent Reach is an OPTIONAL, uv-installed read-only CLI giving the agent
 * reach into platforms web_search/web_browse can't handle (GitHub
 * issues+PRs with comments, YouTube subtitles, Bilibili, V2EX, Reddit,
 * XHS, Xueqiu). KAI wraps it with the same fail-soft pattern as ffmpeg
 * in terminalVideo, plus a read-only security model:
 *
 *   - Only read actions are reachable; the management verbs (setup / add /
 *     remove / login / logout / configure / uninstall / update) are NEVER
 *     exposed to the model — a model-callable `configure` or `login` path
 *     would let prompt injection flip credentials or open sessions.
 *   - channel+action validated against an allowlist BEFORE spawn.
 *   - Every argument quoted AND rejected on shell metachars (same
 *     reject-class as terminalVideo's shellQuote; PowerShell and POSIX
 *     share all of these).
 *   - Results are remote content: fenced + injection-exposure provenance
 *     via toolPresentations, like web_browse.
 */

const src = readFileSync(new URL("./agentReach.ts", import.meta.url), "utf8");

describe("quoting gate (injection safety)", () => {
  it("quotes a plain argument", () => {
    expect(reachQuoteForTest("tauri terminal")).toBe('"tauri terminal"');
  });

  it("rejects every shell metachar class", () => {
    for (const bad of [
      'x"; rm -rf',
      "a$b",
      "a`b",
      "a;b",
      "a&b",
      "a|b",
      "a<b",
      "a>b",
      "a\\b",
      'a"b',
      "a\nb",
      "a\rb",
    ]) {
      expect(() => reachQuoteForTest(bad)).toThrow();
    }
  });

  it("builds the three command shapes", () => {
    expect(buildReachCommand({ channel: "github", action: "search", query: "tauri" }))
      .toBe('agent-reach "github" "search" "tauri"');
    expect(buildReachCommand({ url: "https://v2ex.com/t/123" }))
      .toBe('agent-reach read "https://v2ex.com/t/123"');
    expect(buildReachCommand({ channel: "bilibili", action: "hot" }))
      .toBe('agent-reach "bilibili" "hot"');
  });
});

describe("allowlist + read-only surface", () => {
  it("the channel table carries only read actions", () => {
    const table = src.match(
      /const KNOWN_CHANNEL_ACTIONS: ChannelActions = \{[\s\S]*?\n\};/,
    )![0];
    // No management verb is ever a channel action.
    for (const verb of [
      "setup", "add", "remove", "login", "logout",
      "configure", "uninstall", "update", "browser", "doctor",
    ]) {
      expect(table).not.toMatch(new RegExp(`"${verb}"`));
    }
    expect(table).toContain('github: new Set(["search", "read"])');
  });

  it("management-shaped actions bounce before any spawn", () => {
    expect(src).toContain("READ_ONLY_VERBS");
    expect(src).toMatch(
      /if \(READ_ONLY_VERBS\.has\(action\)\) \{/,
    );
    // Unknown channels bounce with the known list for self-correction.
    expect(src).toMatch(/unknown channel '\$\{channel\}'/);
  });

  it("model-callable paths never run management verbs", () => {
    // The only spawn sites are: version (probe), channels (list),
    // read <url>, and <channel> <action>. Nothing else.
    const spawns = [...src.matchAll(/native\.runCommand\(/g)];
    expect(spawns.length).toBe(4);
    for (const m of spawns) {
      const line = src.slice(m.index!, m.index! + 200);
      expect(line).not.toMatch(/agent-reach (setup|add|remove|login|logout|configure|uninstall|update)/);
    }
  });
});

describe("fail-soft absence", () => {
  it("a missing install returns guidance, never an install attempt", () => {
    expect(src).toContain("Agent Reach is not installed on this machine");
    expect(src).toContain("Do not attempt the install yourself.");
  });

  it("presence probe is cached and one JSON check", () => {
    expect(src).toContain('native.runCommand("agent-reach version", null, 20)');
    expect(src).toContain('reachAvailable = r.exit_code === 0 && (r.stdout ?? "").includes(\'"ok": true\')');
  });
});

describe("output handling", () => {
  it("parses the v1.6 one-JSON-object shape, tolerating leading noise", () => {
    const out = parseReachOutput(
      'notice line\n{"schema_version":1,"ok":true,"channel":"github","items":[],"error":null}',
    );
    expect(out.ok).toBe(true);
    expect(out.channel).toBe("github");
    expect(out.items).toEqual([]);
  });

  it("surfaces the CLI's structured errors verbatim", () => {
    const out = parseReachOutput(
      '{"ok":false,"error":{"code":"NEED_LOGIN","hint":"agent-reach login bilibili"}}',
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatchObject({ code: "NEED_LOGIN" });
  });

  it("no-JSON output throws a readable error", () => {
    expect(() => parseReachOutput("Agent Reach v1.5.0")).toThrow(
      "printed no JSON",
    );
  });
});

describe("presentation registry + inventory wiring", () => {
  const pres = readFileSync(
    new URL("../lib/toolPresentations.ts", import.meta.url),
    "utf8",
  );
  const kaiMd = readFileSync(
    new URL("../../../../KAI.md", import.meta.url),
    "utf8",
  );

  it("results are fenced remote content (like web_browse)", () => {
    const entry = pres.slice(
      pres.indexOf("agent_reach: {"),
      pres.indexOf("agent_reach_list: {"),
    );
    expect(entry).toContain('effect: "NONE"');
    expect(entry).toContain("fence: true");
    expect(entry).toContain("remoteSurface: true");
    expect(pres).toMatch(/agent_reach_list: \{/);
  });

  it("KAI.md lists both tools as auto-execute (drift gate)", () => {
    expect(kaiMd).toContain("`agent_reach`, `agent_reach_list`");
  });
});
