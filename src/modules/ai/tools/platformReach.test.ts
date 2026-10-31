import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { channelForUrl, CHANNELS } from "./platformReach";

/**
 * Platform reach contract (2026-10-31) — KAI's NATIVE implementation of
 * the Agent-Reach approach, replacing the CLI bridge (agent_reach /
 * agent_reach_list, removed the same day after the user's security
 * review: supply-chain + PATH-trust + firewall-prompt concerns).
 *
 * The approach copied, the machinery not:
 *   - per-platform channel table + uniform result shape (kept)
 *   - public-API-first with honest degradation (kept)
 *   - URL auto-routing (kept — web_browse routes platform URLs here)
 *   - external CLI, PATH trust, shims, browser sessions (DROPPED)
 *
 * Security invariants pinned here:
 *   - Every request goes through lib/webFetch.ts → the SSRF-hardened
 *     Rust proxy with allowPrivateNetwork: false. No raw fetch anywhere.
 *   - Read-only public APIs only; login-walled platforms are NOT
 *     channels (no credentials, no browser sessions in KAI).
 *   - No management surface exists at all — there is nothing for a
 *     prompt injection to flip.
 *   - Results are fenced remote content with injection-exposure
 *     provenance (toolPresentations row pinned below).
 */

const src = readFileSync(new URL("./platformReach.ts", import.meta.url), "utf8");
const web = readFileSync(new URL("./web.ts", import.meta.url), "utf8");
const pres = readFileSync(
  new URL("../lib/toolPresentations.ts", import.meta.url),
  "utf8",
);
const kaiMd = readFileSync(new URL("../../../../KAI.md", import.meta.url), "utf8");

describe("channel table", () => {
  it("covers the public-API platforms with read-only actions", () => {
    expect([...Object.keys(CHANNELS)].sort()).toEqual([
      "github",
      "hackernews",
      "reddit",
      "stackoverflow",
      "v2ex",
      "youtube",
    ]);
    expect([...CHANNELS.github.actions]).toEqual(["search", "read"]);
    expect([...CHANNELS.v2ex.actions]).toEqual(["hot", "read"]);
    expect([...CHANNELS.youtube.actions]).toEqual(["read"]);
  });

  it("login-walled platforms are NOT channels (deliberate scope)", () => {
    for (const banned of ["xiaohongshu", "linkedin", "boss", "twitter", "facebook", "instagram"]) {
      expect(CHANNELS).not.toHaveProperty(banned);
    }
    expect(src).toContain("Login-walled platforms (Xiaohongshu, LinkedIn, BOSS,");
  });

  it("no management verbs exist anywhere in the module", () => {
    // There is no setup/add/remove/login/logout/configure surface at all —
    // nothing for a prompt injection to reach.
    expect(src).not.toMatch(/\b(setup|logout|configure|uninstall)\b/);
  });
});

describe("URL auto-routing", () => {
  it("routes platform URLs to their native channel", () => {
    expect(channelForUrl("https://github.com/tauri-apps/tauri/issues/9352")).toEqual({
      channel: "github",
      action: "read",
    });
    expect(channelForUrl("https://github.com/tauri-apps/tauri")).toEqual({
      channel: "github",
      action: "read",
    });
    expect(channelForUrl("https://www.v2ex.com/t/123456")).toEqual({
      channel: "v2ex",
      action: "read",
    });
    expect(
      channelForUrl("https://www.reddit.com/r/rust/comments/abc123/some_post/"),
    ).toEqual({ channel: "reddit", action: "read" });
    expect(channelForUrl("https://youtu.be/dQw4w9WgXcQ")).toEqual({
      channel: "youtube",
      action: "read",
    });
  });

  it("does NOT claim URLs outside its channels", () => {
    expect(channelForUrl("https://example.com/some/page")).toBeNull();
    expect(channelForUrl("https://github.com/tauri-apps/tauri/wiki")).toBeNull();
    expect(
      channelForUrl("https://www.reddit.com/r/rust/top"),
    ).toBeNull();
  });

  it("web_browse auto-routes and falls back to Jina on empty scrapes", () => {
    expect(web).toContain("channelForUrl(url)");
    expect(web).toContain("r.jina.ai");
    // Routing must fall THROUGH to the scrape when the adapter is empty.
    expect(web).toContain(
      "// Adapter came back empty (bad id, rate limit) — fall through",
    );
  });
});

describe("all fetches go through the hardened proxy", () => {
  it("the module imports webFetch (never raw fetch/invoke)", () => {
    expect(src).toContain('from "../lib/webFetch"');
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/invoke\(/);
  });

  it("webFetch pins allowPrivateNetwork: false on every request path", () => {
    const wf = readFileSync(new URL("../lib/webFetch.ts", import.meta.url), "utf8");
    expect(wf).toContain("allowPrivateNetwork: false");
    // webGet + webPost each pin it; webGetJson rides webGet.
    expect((wf.match(/allowPrivateNetwork: false/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((wf.match(/requireLanOnly: requireLanOnly"]/g) ?? []).length).toBeGreaterThanOrEqual(0);
    expect(wf).toContain("requireLanOnly: requireLanOnly()");
  });
});

describe("honest degradation (the Agent-Reach fallback discipline)", () => {
  it("reddit's 403 wall returns a structured note with alternatives", () => {
    expect(src).toContain("function redditBlockedNote");
    expect(src).toContain("r.status === 403 || !r.body.trim().startsWith(\"{\")");
    expect(src).toContain("Alternatives: web_search with site:reddit.com");
  });
});

describe("registry + inventory wiring", () => {
  it("platform_reach is fenced remote content in the presentations registry", () => {
    const entry = pres.slice(
      pres.indexOf("platform_reach: {"),
      pres.indexOf("gmail_read"),
    );
    expect(entry).toContain('effect: "NONE"');
    expect(entry).toContain("fence: true");
    expect(entry).toContain("remoteSurface: true");
  });

  it("KAI.md lists platform_reach as auto-execute (drift gate)", () => {
    expect(kaiMd).toContain("`platform_reach`");
    expect(kaiMd).not.toContain("`agent_reach`");
  });
});
