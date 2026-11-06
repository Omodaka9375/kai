import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * SOURCE PINS (2026-11-06): web_search's Brave engine ladder rung.
 *
 * Context: the legacy engines are scrape-based (Bing's undocumented RSS
 * serializer + a DDG HTML scrape that answers 202 "anomaly" to anonymous
 * programmatic requests) and the ecosystem is closing - Microsoft retired
 * the Bing Search APIs and Google's Custom Search JSON API shuts down Jan
 * 1, 2027. Brave is the top rung: its OWN index (nothing to retire out
 * from under us), best independent agent-quality scores, $5/mo free
 * credits on the prepaid plan. When no key is configured, web_search
 * behaves exactly as before.
 */
describe("Brave search engine wiring (source pins)", () => {
  const web = readFileSync(new URL("./web.ts", import.meta.url), "utf8");
  const providers = readFileSync(
    new URL("../config/providers.ts", import.meta.url),
    "utf8",
  );
  const keyring = readFileSync(new URL("../lib/keyring.ts", import.meta.url), "utf8");
  const agent = readFileSync(new URL("../lib/agent.ts", import.meta.url), "utf8");

  it("brave is a registered SEARCH-only provider with keychain storage", () => {
    expect(providers).toContain('id: "brave"');
    expect(providers).toContain('"brave-search-api-key"');
    expect(providers).toContain("https://api-dashboard.search.brave.com");
  });

  it("braveSearch uses the official API with the subscription-token header", () => {
    expect(web).toContain("api.search.brave.com/res/v1/web/search");
    expect(web).toContain('"X-Subscription-Token": key');
  });

  it("no key = old behavior; with key, Brave is tried before Bing", () => {
    // The gate: empty key returns [] (falls through to Bing), and the Brave
    // attempt sits BEFORE the Bing attempt in the ladder.
    const braveGate = web.indexOf("const key = useChatStore.getState().apiKeys.brave;");
    const braveCall = web.indexOf("const brave = await braveSearch(query);");
    const bingCall = web.indexOf("const bing = await bingSearch(query);");
    expect(braveGate).toBeGreaterThan(-1);
    expect(braveCall).toBeGreaterThan(-1);
    expect(braveCall).toBeLessThan(bingCall);
  });

  it("a Brave failure falls through to the legacy engines, never errors the tool", () => {
    // The Brave attempt is wrapped in its own try/catch that falls through.
    expect(web).toContain("} catch {\n            // fall through to Bing\n          }");
  });

  it("Brave requests ride the SSRF-hardened proxy with the LAN-only policy", () => {
    expect(web).toContain("allowPrivateNetwork: false");
  });

  it("a search-only key does not enable the chat composer (hasAnyKey excludes brave)", () => {
    expect(keyring).toContain('p.id !== "brave"');
  });

  it("reaching the chat-model builder with brave throws (no accidental chat models)", () => {
    expect(agent).toContain(
      "Brave is a search provider (web_search), not a chat model provider.",
    );
  });
});
