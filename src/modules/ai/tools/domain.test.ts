import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * DOMAIN tools (domain_check + domain_find) — 2026-11-01.
 *
 * Contract:
 *  - normalizeDomain is the SSRF gate: only bare ASCII LDH domains survive;
 *    scheme/www/path/query/port must be stripped or rejected.
 *  - IANA's RDAP bootstrap maps TLD → registry RDAP service (session-cached);
 *    the registry is fetched DIRECTLY (no redirector — rdap.org 403s bare
 *    HTTP clients). RDAP is authoritative (200 = registered with parsed
 *    registrar/dates/NS; registry 404 = available), DNS DoH corroborates
 *    (delegated NS proves registered even when RDAP is missing — ccTLDs).
 *  - A TLD absent from the bootstrap → "no RDAP service" note, DNS-only.
 *  - domain_find generates pattern candidates across TLDs, checks them, and
 *    returns AVAILABLE ones sorted: exact keyword first, then shortest,
 *    then caller's TLD order.
 *  - Everything rides the Rust proxy with allowPrivateNetwork: false and the
 *    LAN-only policy (same class as web_browse/web_search).
 */

const shared = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; allowPrivateNetwork: boolean; requireLanOnly: boolean }>,
  responses: new Map<string, { status: number; body: string }>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (_cmd: string, args: Record<string, unknown>) => {
    shared.calls.push({
      url: String(args.url),
      allowPrivateNetwork: args.allowPrivateNetwork === true,
      requireLanOnly: args.requireLanOnly === true,
    });
    const hit = shared.responses.get(String(args.url));
    if (hit) return { status: hit.status, headers: {}, body: Array.from(new TextEncoder().encode(hit.body)) };
    return { status: 404, headers: {}, body: Array.from(new TextEncoder().encode("{}")) };
  }),
}));

import {
  normalizeDomain,
  normalizeTld,
  parseRdap,
  generateCandidates,
  checkDomain,
  buildDomainTools,
} from "./domain";
import { presentationFor } from "../lib/toolPresentations";

const TAKEN_RDAP = JSON.stringify({
  ldhName: "example.com",
  status: ["active"],
  events: [
    { eventAction: "registration", eventDate: "1995-08-14T04:00:00Z" },
    { eventAction: "expiration", eventDate: "2027-08-13T04:00:00Z" },
  ],
  nameservers: [{ ldhName: "A.IANA-SERVERS.NET" }, { ldhName: "B.IANA-SERVERS.NET" }],
  entities: [
    {
      roles: ["registrar"],
      vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Reserved Internet Registry"]]],
    },
  ],
});

/** IANA bootstrap body used by every test: all TLDs here route to one test
 *  registry ("zz" is deliberately absent — the no-RDAP-service case). */
const BOOTSTRAP = JSON.stringify({
  services: [[
    ["com", "dev", "io", "app", "tv", "xyz", "ai", "co", "net", "org", "sh"],
    ["https://rdap.test-registry.com/v1/"],
  ]],
});

beforeEach(() => {
  shared.calls.length = 0;
  shared.responses.clear();
  shared.responses.set("https://data.iana.org/rdap/dns.json", {
    status: 200,
    body: BOOTSTRAP,
  });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("normalizeDomain — the SSRF gate", () => {
  it("strips scheme, www, path, query, fragment, trailing dots", () => {
    expect(normalizeDomain("https://example.com/about?x=1#frag")).toBe("example.com");
    expect(normalizeDomain("http://www.example.com/")).toBe("example.com");
    expect(normalizeDomain("WWW.Example.COM.")).toBe("example.com");
    expect(normalizeDomain("example.com")).toBe("example.com");
    expect(normalizeDomain("  example.app  ")).toBe("example.app");
  });

  it("accepts multi-label and hyphenated names", () => {
    expect(normalizeDomain("mail.example.co.uk")).toBe("mail.example.co.uk");
    expect(normalizeDomain("my-app.io")).toBe("my-app.io");
  });

  it("rejects anything that could escape the URL path segment", () => {
    // No port, no userinfo, no injection, no unicode, no bare TLD, no IPs.
    expect(normalizeDomain("example.com:8080")).toBeNull();
    expect(normalizeDomain("user@example.com")).toBeNull();
    expect(normalizeDomain("../../../etc/passwd")).toBeNull();
    expect(normalizeDomain("..%2f..%2f")).toBeNull();
    expect(normalizeDomain("exämple.com")).toBeNull();
    expect(normalizeDomain("com")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("192.168.1.1")).toBeNull();
    // Hyphens may not lead/trail a label.
    expect(normalizeDomain("-bad.io")).toBeNull();
    expect(normalizeDomain("bad-.io")).toBeNull();
  });
});

describe("normalizeTld", () => {
  it("accepts bare and dotted TLDs, rejects junk", () => {
    expect(normalizeTld(".com")).toBe("com");
    expect(normalizeTld("APP")).toBe("app");
    expect(normalizeTld("io")).toBe("io");
    expect(normalizeTld("")).toBeNull();
    expect(normalizeTld(".")).toBeNull();
    expect(normalizeTld("co.uk")).toBeNull(); // multi-label is not a TLD here
    expect(normalizeTld("x")).toBeNull(); // too short
  });
});

describe("parseRdap — defensive JSON parsing", () => {
  it("extracts registrar, dates, nameservers from a real-shaped RDAP body", () => {
    const r = parseRdap("example.com", TAKEN_RDAP);
    expect(r.registered).toBe(true);
    expect(r.registrar).toBe("Reserved Internet Registry");
    expect(r.createdAt).toBe("1995-08-14T04:00:00Z");
    expect(r.expiresAt).toBe("2027-08-13T04:00:00Z");
    expect(r.nameservers).toEqual(["a.iana-servers.net", "b.iana-servers.net"]);
  });

  it("unreadable JSON → registered null, never a crash", () => {
    const r = parseRdap("x.com", "<html>gateway error</html>");
    expect(r.registered).toBeNull();
  });

  it("missing optional fields degrade gracefully", () => {
    const r = parseRdap("x.io", JSON.stringify({ ldhName: "x.io" }));
    expect(r.registered).toBe(true);
    expect(r.registrar).toBeUndefined();
    expect(r.nameservers).toBeUndefined();
  });
});

describe("generateCandidates — pattern-major, deduped, capped", () => {
  it("exact name across ALL tlds comes first (pattern-major)", () => {
    const out = generateCandidates(["kai"], ["com", "io", "app"]);
    expect(out[0]).toBe("kai.com");
    expect(out[1]).toBe("kai.io");
    expect(out[2]).toBe("kai.app");
    expect(out[3]).toBe("getkai.com");
  });

  it("joins multi-word keywords and strips non-alphanumerics", () => {
    const out = generateCandidates(["Fast", "Mail!"], ["io"]);
    expect(out[0]).toBe("fastmail.io");
    expect(out).toContain("getfastmail.io");
  });

  it("dedupes and caps", () => {
    const out = generateCandidates(["a"], ["com", "com"]);
    expect(out.filter((d) => d === "a.com").length).toBe(1);
    const capped = generateCandidates(["superlongkeyword"], ["com", "io", "app"]);
    expect(capped.length).toBeLessThanOrEqual(24);
  });
});

describe("checkDomain — IANA bootstrap → registry RDAP + DoH corroboration", () => {
  it("200 → registered, with parsed fields and delegated DNS", async () => {
    shared.responses.set("https://rdap.test-registry.com/v1/domain/example.com", { status: 200, body: TAKEN_RDAP });
    shared.responses.set(
      "https://dns.google/resolve?name=example.com&type=NS",
      { status: 200, body: JSON.stringify({ Status: 0, Answer: [{ type: 2, data: "a.iana-servers.net." }] }) },
    );
    const r = await checkDomain("example.com");
    expect(r.registered).toBe(true);
    expect(r.dns).toBe("delegated");
    expect(r.registrar).toBe("Reserved Internet Registry");
  });

  it("registry 404 + NXDOMAIN → available", async () => {
    shared.responses.set(
      "https://dns.google/resolve?name=free.dev&type=NS",
      { status: 200, body: JSON.stringify({ Status: 3 }) },
    );
    const r = await checkDomain("free.dev");
    expect(r.registered).toBe(false);
    expect(r.dns).toBe("undelegated");
    expect(r.note).toContain("available");
  });

  it("registry 404 but DNS delegated → taken (ccTLD RDAP gap)", async () => {
    shared.responses.set(
      "https://dns.google/resolve?name=weird.tv&type=NS",
      { status: 200, body: JSON.stringify({ Status: 0, Answer: [{ type: 2, data: "ns.weird.tv." }] }) },
    );
    const r = await checkDomain("weird.tv");
    expect(r.registered).toBe(true);
    expect(r.note).toContain("verify with a registrar");
  });

  it("429 → unknown with a rate-limit note", async () => {
    shared.responses.set("https://rdap.test-registry.com/v1/domain/ratelimited.io", { status: 429, body: "" });
    const r = await checkDomain("ratelimited.io");
    expect(r.registered).toBeNull();
    expect(r.note).toContain("rate-limited");
  });

  it("a TLD with no RDAP service (some ccTLDs) → unknown with a clear note", async () => {
    const r = await checkDomain("somewhere.zz");
    expect(r.registered).toBeNull();
    expect(r.note).toContain("no RDAP service");
  });

  it("every request: bootstrap-named host, SSRF-guarded, LAN-policy applied", async () => {
    shared.responses.set("https://rdap.test-registry.com/v1/domain/a.com", { status: 404, body: "" });
    await checkDomain("a.com", { probeDns: false });
    expect(shared.calls.length).toBeGreaterThanOrEqual(1);
    for (const c of shared.calls) {
      // Only the IANA bootstrap, a bootstrap-named registry, or the DoH
      // endpoint — never a model-chosen host.
      expect(
        c.url === "https://data.iana.org/rdap/dns.json" ||
        c.url.startsWith("https://rdap.test-registry.com/v1/domain/") ||
        c.url.startsWith("https://dns.google/resolve?name="),
      ).toBe(true);
      expect(c.allowPrivateNetwork).toBe(false);
      expect(c.requireLanOnly).toBe(false); // test env: no prefs store
    }
  });
});

describe("tools — registration + behavior", () => {
  it("both tools are auto-run, approval-free (web_search class)", () => {
    const tools = buildDomainTools() as unknown as Record<
      string,
      { needsApproval?: boolean; description: string }
    >;
    expect(tools["domain_check"]).toBeDefined();
    expect(tools["domain_find"]).toBeDefined();
    expect(tools["domain_check"].needsApproval).not.toBe(true);
    expect(tools["domain_find"].needsApproval).not.toBe(true);
    expect(tools["domain_check"].description).toContain("RDAP");
  });

  it("domain_check checks a batch and summarizes", async () => {
    shared.responses.set("https://rdap.test-registry.com/v1/domain/taken.com", { status: 200, body: TAKEN_RDAP });
    shared.responses.set(
      "https://dns.google/resolve?name=taken.com&type=NS",
      { status: 200, body: JSON.stringify({ Status: 0, Answer: [{ type: 2, data: "ns.taken.com." }] }) },
    );
    shared.responses.set(
      "https://dns.google/resolve?name=free.dev&type=NS",
      { status: 200, body: JSON.stringify({ Status: 3 }) },
    );
    const tools = buildDomainTools() as unknown as {
      domain_check: { execute: (i: { domains: string[] }) => Promise<{ results: Array<{ domain: string; registered: boolean | null }>; summary: string }> };
    };
    const res = await tools.domain_check.execute({ domains: ["taken.com", "free.dev", "not a domain"] });
    expect(res.results).toHaveLength(3);
    expect(res.results[0]!.registered).toBe(true);
    expect(res.results[1]!.registered).toBe(false);
    expect(res.results[2]!.registered).toBeNull();
    expect(res.summary).toBe("1 of 3 available");
  });

  it("domain_find returns available names sorted exact-first, then shortest", async () => {
    // kai.com taken; kai.app, kai.io free; getkai.com free (longer).
    shared.responses.set("https://rdap.test-registry.com/v1/domain/kai.com", { status: 200, body: TAKEN_RDAP });
    shared.responses.set(
      "https://dns.google/resolve?name=kai.com&type=NS",
      { status: 200, body: JSON.stringify({ Status: 0, Answer: [{ type: 2, data: "ns.kai.com." }] }) },
    );
    const tools = buildDomainTools() as unknown as {
      domain_find: { execute: (i: { keywords: string[]; tlds?: string[]; limit?: number }) => Promise<{ available: string[]; checked: number; takenCount: number }> };
    };
    const res = await tools.domain_find.execute({ keywords: ["kai"], tlds: ["com", "app", "io"], limit: 5 });
    expect(res.checked).toBeGreaterThan(0);
    expect(res.available).toContain("kai.app");
    expect(res.available).toContain("kai.io");
    expect(res.available).not.toContain("kai.com");
    // Exact-keyword names come before get- (longer) variants.
    const exactIdx = res.available.findIndex((d) => d === "kai.app");
    const variantIdx = res.available.findIndex((d) => d.startsWith("get"));
    if (exactIdx >= 0 && variantIdx >= 0) {
      expect(exactIdx).toBeLessThan(variantIdx);
    }
    // Every returned name uses one of the requested TLDs.
    for (const d of res.available) {
      expect(d).toMatch(/\.(com|app|io)$/);
    }
  });
});

describe("registrations", () => {
  it("presentation rows exist (remote-surface, fenced — registry data)", () => {
    const check = presentationFor("domain_check");
    const find = presentationFor("domain_find");
    expect(check.remoteSurface).toBe(true);
    expect(find.remoteSurface).toBe(true);
    expect(check.fence).toBe(true);
  });

  it("wired into the extended tools (source pin)", () => {
    const tools = readFileSync(new URL("./tools.ts", import.meta.url), "utf8");
    expect(tools).toContain("...buildDomainTools()");
  });

  it("assistant catalog exposes both as READ tier", async () => {
    const catalog = readFileSync(
      new URL("../../assistant/toolCatalog.ts", import.meta.url),
      "utf8",
    );
    expect(catalog).toContain('name: "domain_check", tier: "read"');
    expect(catalog).toContain('name: "domain_find", tier: "read"');
  });
});
