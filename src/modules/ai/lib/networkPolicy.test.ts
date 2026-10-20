import { readFileSync } from "node:fs";
import { describe, expect, it, afterEach } from "vitest";
import { checkShellCommand } from "./security";

/**
 * LAN-only network policy contract tests.
 *
 * Three layers must hold for the Security → "Agent network access" toggle
 * to be real rather than theater:
 *   1. Rust proxy gate — ai_http_request/ai_http_stream accept
 *      require_lan_only and thread it into the IP filter (source contract;
 *      the classification math is pinned by Rust unit tests).
 *   2. Model-chosen web surfaces pass the flag — web.ts/youtube.ts read
 *      the live policy. Provider-class fetches (agent.ts localProxyFetch,
 *      MCP, TTS/STT) must NOT be gated: restricting those bricks the
 *      agent's ability to think.
 *   3. Shell egress classifier — checkShellCommand refuses public-internet
 *      destinations under the policy while allowing LAN targets. Behavioral
 *      tests below (the classifier is pure).
 */

const webSrc = readFileSync(new URL("../tools/web.ts", import.meta.url), "utf8");
const youtubeSrc = readFileSync(new URL("../tools/youtube.ts", import.meta.url), "utf8");
const netRs = readFileSync(
  new URL("../../../../src-tauri/src/modules/net.rs", import.meta.url),
  "utf8",
);
const agentSrc = readFileSync(new URL("./agent.ts", import.meta.url), "utf8");

describe("Rust proxy gate (source contract)", () => {
  it("ai_http_request / ai_http_stream accept require_lan_only", () => {
    expect(netRs).toContain("require_lan_only: Option<bool>");
    expect(netRs).toContain("require_lan_only");
    // Public IPs dropped when the policy is on:
    expect(netRs).toContain("IpKind::Public => !require_lan_only");
  });

  it("deny message points the agent at the policy", () => {
    expect(netRs).toContain("LAN only");
  });
});

describe("model-chosen surfaces are gated", () => {
  it("web.ts and youtube.ts pass requireLanOnly()", () => {
    expect(webSrc).toContain("requireLanOnly: requireLanOnly()");
    expect(youtubeSrc).toContain("requireLanOnly: requireLanOnly()");
  });
});

describe("provider-class fetches are NEVER gated", () => {
  it("agent.ts provider fetch does not consult the policy", () => {
    expect(agentSrc).not.toContain("requireLanOnly");
    expect(agentSrc).not.toMatch(/lanOnlyActive/);
  });
});

describe("shell egress classifier (behavioral)", () => {
  const enable = () => {
    (globalThis as Record<string, unknown>).__kaiLanOnlyPolicy = () => true;
  };
  const disable = () => {
    (globalThis as Record<string, unknown>).__kaiLanOnlyPolicy = () => false;
  };

  afterEach(disable);

  it("policy OFF: public commands pass (regression — default path unchanged)", () => {
    disable();
    expect(checkShellCommand("curl https://example.com")).toEqual({ ok: true });
    expect(checkShellCommand("pnpm install")).toEqual({ ok: true });
  });

  it("policy ON: public URLs denied with the policy pointer", () => {
    enable();
    const r = checkShellCommand("curl https://example.com");
    expect(r.ok).toBe(false);
    const reason = r.ok ? "" : r.reason;
    expect(reason).toContain("LAN only");
    expect(reason).toContain("example.com");
  });

  it("policy ON: LAN targets allowed", () => {
    enable();
    expect(checkShellCommand("curl http://192.168.1.20:8080/health")).toEqual({ ok: true });
    expect(checkShellCommand("curl http://localhost:3000")).toEqual({ ok: true });
    expect(checkShellCommand("curl http://nas.local/api")).toEqual({ ok: true });
    expect(checkShellCommand("curl http://intranet.internal/")).toEqual({ ok: true });
  });

  it("policy ON: package installs denied, local-registry installs allowed", () => {
    enable();
    expect(checkShellCommand("pnpm install").ok).toBe(false);
    expect(checkShellCommand("pip install requests").ok).toBe(false);
    expect(
      checkShellCommand("pnpm install --registry http://nexus.lan:8081/repository/npm/").ok,
    ).toBe(true);
    expect(
      checkShellCommand("pip install flask --index-url http://nexus.lan:8081/pypi/simple").ok,
    ).toBe(true);
  });

  it("policy ON: git network ops denied for public remotes", () => {
    enable();
    expect(checkShellCommand("git clone https://github.com/foo/bar").ok).toBe(false);
    expect(checkShellCommand("git clone git@nas.local:repo.git").ok).toBe(true);
  });

  it("policy ON: non-network commands unaffected", () => {
    enable();
    expect(checkShellCommand("cargo test").ok).toBe(true);
    expect(checkShellCommand("Get-ChildItem -Recurse").ok).toBe(true);
    expect(checkShellCommand("ls -la").ok).toBe(true);
  });

  it("policy ON: egress client with hidden host denied (evasion resistance)", () => {
    enable();
    expect(checkShellCommand("curl").ok).toBe(false);
    expect(checkShellCommand("ssh").ok).toBe(false);
  });

  it("policy reads the live hook lazily (no baked-in state)", () => {
    enable();
    expect(checkShellCommand("curl https://example.com").ok).toBe(false);
    disable();
    expect(checkShellCommand("curl https://example.com")).toEqual({ ok: true });
  });
});

describe("hook wiring (source contract)", () => {
  it("App.tsx installs the globalThis hook from the preferences store", async () => {
    const appSrc = readFileSync(new URL("../../../app/App.tsx", import.meta.url), "utf8");
    expect(appSrc).toContain("__kaiLanOnlyPolicy");
    expect(appSrc).toContain('networkPolicy === "lan"');
  });
});
