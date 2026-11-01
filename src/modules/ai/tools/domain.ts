import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";
import { requireLanOnly } from "../lib/proxyFetch";

/**
 * DOMAIN tools (2026-11-01) — name checker + finder, no API key needed.
 *
 * Why RDAP and not WHOIS: port-43 WHOIS is not HTTP (the Rust proxy is), and
 * every response shape is per-registrar free text. RDAP is the ICANN
 * standard replacing it: IANA's bootstrap file (data.iana.org/rdap/dns.json)
 * maps every TLD to its registry's RDAP service — every gTLD must run one,
 * and most ccTLDs do. 404 from the registry = not registered. Purchasing
 * still happens at a registrar — these tools only LOOK.
 *
 * (The rdap.org redirector was tried first and rejected: it bot-filters
 * bare HTTP clients with 403. IANA is the canonical, stable source.)
 *
 * Security class (same as web.ts):
 *  - FIXED endpoints only (IANA bootstrap, registry RDAP services it names,
 *    dns.google DoH) — the model controls the DOMAIN string, never the URL.
 *    normalizeDomain's charset makes path traversal impossible before
 *    interpolation, and only bootstrap-named https URLs are ever fetched.
 *  - Through the SSRF-hardened Rust proxy: allowPrivateNetwork: false,
 *    redirect policy re-checks every hop.
 *  - Model-initiated internet lookup → the LAN-only network policy applies
 *    (requireLanOnly), exactly like web_browse/web_search.
 *
 * DNS (dns.google JSON DoH) is the corroborating signal: NS records prove
 * a delegation even when a registry's RDAP is missing or rate-limits us;
 * NXDOMAIN agrees with "unregistered". RDAP stays authoritative when it
 * answers definitively (200 = registered, registry 404 = available).
 *
 * Both tools are AUTO-RUN (needsApproval: false): read-only public
 * registry lookups, no side effects, no credits — the web_search class.
 */

const IANA_BOOTSTRAP = "https://data.iana.org/rdap/dns.json";
const DOH_ENDPOINT = "https://dns.google/resolve";
/** One domain_check call: keeps the batch (and registry load) sane. */
const MAX_CHECK_DOMAINS = 10;
/** One domain_find call: candidates checked against the registries. */
const MAX_FIND_CANDIDATES = 24;
/** Default TLD sweep for the finder — practical, mixed price/credibility. */
const DEFAULT_TLDS = [
  "com", "app", "dev", "io", "ai", "co", "net", "org", "sh", "xyz",
] as const;

// ── HTTP (the web.ts model-chosen-lookup class, fixed endpoints) ──────────

async function httpFetch(
  url: string,
  accept: string,
): Promise<{ status: number; body: string }> {
  const resp = await invoke<{
    status: number;
    headers: Record<string, string>;
    body: number[];
  }>("ai_http_request", {
    url,
    method: "GET",
    headers: { Accept: accept },
    // Fixed public endpoints, but the call is still model-initiated —
    // never let it reach LAN / loopback / cloud-metadata addresses.
    allowPrivateNetwork: false,
    // Model-initiated internet lookup: the LAN-only policy applies.
    requireLanOnly: requireLanOnly(),
  });
  return {
    status: resp.status,
    body: new TextDecoder().decode(new Uint8Array(resp.body)),
  };
}

// ── IANA RDAP bootstrap (TLD → registry RDAP service URL) ──────────────────

/**
 * Session cache of IANA's dns.json: `[tlds[], urls[]]` services array.
 * One fetch per app session; failures retry on the next check (never
 * cached as "missing" — a network blip must not poison every TLD).
 */
let bootstrapCache: Promise<Map<string, string>> | null = null;

function parseBootstrap(body: string): Map<string, string> {
  const map = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return map;
  }
  const services = (
    parsed as { services?: unknown }
  ).services;
  if (!Array.isArray(services)) return map;
  for (const svc of services) {
    if (!Array.isArray(svc) || svc.length < 2) continue;
    const [tlds, urls] = svc as [unknown, unknown];
    if (!Array.isArray(tlds) || !Array.isArray(urls)) continue;
    const url =
      urls.find((u): u is string => typeof u === "string" && u.startsWith("https://")) ??
      null;
    if (!url) continue;
    for (const t of tlds) {
      if (typeof t === "string") map.set(t.toLowerCase(), url);
    }
  }
  return map;
}

/** TLD → registry RDAP base URL (IANA bootstrap, session-cached). */
async function rdapServiceFor(tld: string): Promise<string | null> {
  bootstrapCache ??= httpFetch(IANA_BOOTSTRAP, "application/json")
    .then((r) => parseBootstrap(r.body))
    .catch(() => {
      // Do NOT cache the failure — retry on the next check.
      bootstrapCache = null;
      return new Map<string, string>();
    });
  const map = await bootstrapCache;
  return map.get(tld) ?? null;
}

// ── Normalization (pure, exported for tests) ──────────────────────────────

/**
 * Normalize user/model-supplied "domain" text into a bare lowercase
 * registry name: strip scheme, www., path/query/fragment, trailing dots.
 * Returns null for anything that isn't ASCII LDH labels joined by dots —
 * this is also the SSRF gate: the result can't contain `/`, `:`, `?`, `#`,
 * or any character the charset rejects, so it can never escape the
 * rdap.org path segment it gets interpolated into.
 */
export function normalizeDomain(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.replace(/^www\./, "");
  const cut = s.search(/[/?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  s = s.replace(/\.+$/, "");
  if (s.length === 0 || s.length > 253) return null;
  // LDH labels, at least two, no empty/leading/trailing hyphens, ASCII only.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) {
    return null;
  }
  // IP-literal shapes (all-numeric labels) are not domain names — and this
  // guard keeps the tool from being pointed at LAN addresses by their
  // "domain-looking" form. At least one label must contain a letter.
  if (!s.split(".").some((label) => /[a-z]/.test(label))) return null;
  return s;
}

/** TLD for the finder: bare lowercase LDH (".com" and "com" both fine). */
export function normalizeTld(raw: string): string | null {
  let s = raw.trim().toLowerCase().replace(/^\.+/, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s) || s.length < 2 || s.length > 24) {
    return null;
  }
  return s;
}

// ── RDAP + DoH parsing (defensive: json-parse-must-validate) ──────────────

type RdapDomain = {
  ldhName?: unknown;
  status?: unknown;
  events?: unknown;
  nameservers?: unknown;
  entities?: unknown;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Pull the registrar's display name from an RDAP entity (vcard fn). */
function registrarName(entity: unknown): string | null {
  if (!isRecord(entity)) return null;
  const vcard = entity.vcardArray;
  if (!Array.isArray(vcard) || vcard.length < 2 || !Array.isArray(vcard[1])) {
    return asString(entity.handle);
  }
  for (const item of vcard[1]) {
    if (Array.isArray(item) && item[0] === "fn" && item.length >= 4) {
      const fn = asString(item[3]);
      if (fn) return fn;
    }
  }
  return asString(entity.handle);
}

export type DomainCheck = {
  domain: string;
  /** true = registered, false = available (registry RDAP says so),
   *  null = could not determine (rate limit, no RDAP service, network). */
  registered: boolean | null;
  registrar?: string | null;
  createdAt?: string | null;
  expiresAt?: string | null;
  nameservers?: string[];
  dns?: "delegated" | "undelegated" | "unknown";
  note?: string;
};

/** Parse an RDAP response body into check fields (200 assumed). */
export function parseRdap(domain: string, body: string): Omit<DomainCheck, "dns" | "note"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { domain, registered: null };
  }
  const d = parsed as RdapDomain;
  const out: Omit<DomainCheck, "dns" | "note"> = { domain, registered: true };

  const events = Array.isArray(d.events) ? d.events : [];
  for (const ev of events) {
    if (!isRecord(ev)) continue;
    const action = asString(ev.eventAction);
    const date = asString(ev.eventDate);
    if (!date) continue;
    if (action === "registration") out.createdAt = date;
    if (action === "expiration") out.expiresAt = date;
  }

  const ns: string[] = [];
  const nameservers = Array.isArray(d.nameservers) ? d.nameservers : [];
  for (const n of nameservers) {
    if (!isRecord(n)) continue;
    const ldh = asString(n.ldhName);
    if (ldh && !ns.includes(ldh.toLowerCase())) ns.push(ldh.toLowerCase());
    if (ns.length >= 8) break;
  }
  if (ns.length) out.nameservers = ns;

  const entities = Array.isArray(d.entities) ? d.entities : [];
  for (const e of entities) {
    if (!isRecord(e)) continue;
    const roles = Array.isArray(e.roles) ? e.roles : [];
    if (roles.some((r) => r === "registrar")) {
      const name = registrarName(e);
      if (name) {
        out.registrar = name;
        break;
      }
    }
  }
  return out;
}

/** DNS delegation status via Google's JSON DoH endpoint. */
async function dnsDelegation(
  domain: string,
): Promise<"delegated" | "undelegated" | "unknown"> {
  try {
    const { status, body } = await httpFetch(
      `${DOH_ENDPOINT}?name=${encodeURIComponent(domain)}&type=NS`,
      "application/dns-json",
    );
    if (status !== 200) return "unknown";
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return "unknown";
    }
    const rec = parsed as { Status?: unknown; Answer?: unknown };
    if (rec.Status === 3) return "undelegated"; // NXDOMAIN
    const answers = Array.isArray(rec.Answer) ? rec.Answer : [];
    for (const a of answers) {
      if (isRecord(a) && a.type === 2) return "delegated"; // NS record
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Check one domain: RDAP first (authoritative), DoH as the corroborating
 * signal when RDAP is inconclusive or contradicts. `probeDns` exists so
 * domain_find can skip the extra round-trip for speed (RDAP 404 is enough
 * for gTLD availability).
 */
export async function checkDomain(
  domain: string,
  opts: { probeDns?: boolean } = {},
): Promise<DomainCheck> {
  const probeDns = opts.probeDns !== false;
  let rdapStatus = 0;
  let rdapBody = "";
  try {
    // TLD → registry RDAP service via IANA's bootstrap (session-cached);
    // the registry is then fetched DIRECTLY — no redirector middleman.
    const tld = domain.slice(domain.lastIndexOf(".") + 1);
    const service = await rdapServiceFor(tld);
    if (!service) {
      // No RDAP service for this TLD (some ccTLDs) — DNS-only answer.
      const dns = probeDns ? await dnsDelegation(domain) : "unknown";
      if (dns === "delegated") {
        return {
          domain,
          registered: true,
          dns,
          note: "this TLD publishes no RDAP service but DNS is delegated — treat as taken; verify with a registrar",
        };
      }
      return {
        domain,
        registered: null,
        dns,
        note: "this TLD publishes no RDAP service (some ccTLDs) — verify with a registrar or a whois",
      };
    }
    const base = service.endsWith("/") ? service.slice(0, -1) : service;
    const r = await httpFetch(
      `${base}/domain/${domain}`,
      "application/rdap+json, application/json",
    );
    rdapStatus = r.status;
    rdapBody = r.body;
  } catch (e) {
    // Network / LAN-only policy refusal — still try DNS so the answer
    // isn't a bare "unknown" when the DoH endpoint is reachable.
    const dns = probeDns ? await dnsDelegation(domain) : "unknown";
    if (dns === "delegated") {
      return { domain, registered: true, dns, note: `RDAP lookup failed (${String(e)}) but DNS shows a live delegation` };
    }
    return {
      domain,
      registered: null,
      dns,
      note: `registry lookup failed: ${(e as Error)?.message ?? String(e)}`,
    };
  }

  if (rdapStatus === 200) {
    const parsed = parseRdap(domain, rdapBody);
    const dns = probeDns ? await dnsDelegation(domain) : "unknown";
    if (parsed.registered === null) {
      return { ...parsed, dns, note: "registry returned an unreadable RDAP response" };
    }
    return { ...parsed, dns };
  }
  if (rdapStatus === 404) {
    // Registry says no such domain — corroborate with DNS: a live NS
    // delegation means registered-but-RDAP-less (rare, some ccTLDs).
    const dns = probeDns ? await dnsDelegation(domain) : "unknown";
    if (dns === "delegated") {
      return {
        domain,
        registered: true,
        dns,
        note: "no RDAP record but DNS is delegated — treat as taken; verify with a registrar",
      };
    }
    return {
      domain,
      registered: false,
      dns,
      note: "available — no registry record (verify with a registrar before purchase)",
    };
  }
  if (rdapStatus === 429) {
    return { domain, registered: null, note: "rate-limited by the registry — try again in a moment" };
  }
  return {
    domain,
    registered: null,
    note: `registry returned HTTP ${rdapStatus}${
      rdapStatus === 404 || rdapStatus === 502 ? " (this TLD may not publish RDAP — verify with a registrar)" : ""
    }`,
  };
}

// ── Candidate generation for the finder (pure, exported for tests) ────────

/**
 * Name patterns applied to the joined keyword(s): the bare word first,
 * then the classic startup prefixes/suffixes.
 */
const PATTERNS: ReadonlyArray<(w: string) => string> = [
  (w) => w,
  (w) => `get${w}`,
  (w) => `try${w}`,
  (w) => `use${w}`,
  (w) => `${w}hq`,
  (w) => `${w}app`,
  (w) => `${w}dev`,
  (w) => `${w}labs`,
];

/** Sanitize one keyword: keep [a-z0-9], drop everything else. */
function keywordSlug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Generate check candidates: pattern-major (the exact name across ALL
 * TLDs comes first, then get-/try-/… variants), deduped, ≤63-char labels,
 * capped at MAX_FIND_CANDIDATES.
 */
export function generateCandidates(
  keywords: string[],
  tlds: string[],
  cap: number = MAX_FIND_CANDIDATES,
): string[] {
  const joined = keywords.map(keywordSlug).filter(Boolean).join("");
  if (!joined || joined.length > 63) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pattern of PATTERNS) {
    const sld = pattern(joined);
    if (sld.length > 63) continue;
    for (const tld of tlds) {
      const name = `${sld}.${tld}`;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

// ── Tools ──────────────────────────────────────────────────────────────────

export function buildDomainTools() {
  return {
    domain_check: tool({
      description:
        `Check whether one or more domain names are REGISTERED or AVAILABLE, with real registry (RDAP) data: registrar, registration and expiry dates, and nameservers for registered domains. Use it to verify exact names ("is kai-terminal.com free?"). Keyless public lookups; availability means no registry record — confirm with a registrar before purchasing.`,
      inputSchema: z.object({
        domains: z
          .array(z.string())
          .min(1)
          .max(MAX_CHECK_DOMAINS)
          .describe(`Domain names to check (max ${MAX_CHECK_DOMAINS}), e.g. ["example.com", "example.app"]. Bare names — scheme/www/path are stripped.`),
      }),
      needsApproval: false,
      execute: async ({ domains }) => {
        if (domains.length > MAX_CHECK_DOMAINS) {
          return {
            results: [],
            note: `check at most ${MAX_CHECK_DOMAINS} domains per call`,
          };
        }
        const results = await Promise.all(
          domains.map(async (raw) => {
            const domain = normalizeDomain(raw);
            if (!domain) {
              const check: DomainCheck = {
                domain: raw,
                registered: null,
                note: "not a valid domain name (needs at least two labels, ASCII letters/digits/hyphens)",
              };
              return check;
            }
            return checkDomain(domain);
          }),
        );
        const available = results.filter((r) => r.registered === false).length;
        return {
          results,
          summary: `${available} of ${results.length} available`,
        };
      },
    }),

    domain_find: tool({
      description:
        `FIND AVAILABLE domain names from keywords. Generates name patterns (the bare word, get-, try-, use-, -hq, -app, -dev, -labs) across practical TLDs (.com .app .dev .io .ai .co .net .org .sh .xyz — or your own list), checks each against the registries, and returns the AVAILABLE ones first. Use for naming a product/project ("find me a domain for a mail app called fastmail"). Exact-name matches sort first; short names before long. Keyless RDAP lookups; confirm with a registrar before purchasing.`,
      inputSchema: z.object({
        keywords: z
          .array(z.string())
          .min(1)
          .max(4)
          .describe('Base words, e.g. ["fast", "mail"] or ["kai"]. Spaces/punctuation are stripped; multi-word inputs are joined.'),
        tlds: z
          .array(z.string())
          .optional()
          .describe("TLDs to sweep (default: .com .app .dev .io .ai .co .net .org .sh .xyz)."),
        limit: z
          .number()
          .int()
          .min(5)
          .max(20)
          .optional()
          .describe("Max available names to return (default 10)."),
      }),
      needsApproval: false,
      execute: async ({ keywords, tlds, limit }) => {
        const tldList = (tlds && tlds.length ? tlds : [...DEFAULT_TLDS])
          .map((t) => normalizeTld(t))
          .filter((t): t is string => !!t);
        const uniqTlds = [...new Set(tldList)];
        if (!uniqTlds.length) {
          return { keywords, available: [], checked: 0, note: "no valid TLDs given" };
        }
        const candidates = generateCandidates(keywords, uniqTlds);
        if (!candidates.length) {
          return {
            keywords,
            available: [],
            checked: 0,
            note: "keywords produced no usable name — use 1-4 short alphanumeric words",
          };
        }
        // Fast path: RDAP 404 is definitive availability for bootstrap TLDs,
        // so skip the DNS round-trip while hunting. TLDs MISSING from the
        // bootstrap (some ccTLDs like .io) get the DNS probe instead so
        // REGISTERED ones are still filtered out of the results.
        const checks = await Promise.all(
          candidates.map(async (d) => {
            const tld = d.slice(d.lastIndexOf(".") + 1);
            const service = await rdapServiceFor(tld);
            return checkDomain(d, { probeDns: !service });
          }),
        );
        const joined = keywords.map(keywordSlug).filter(Boolean).join("");
        const tldRank = new Map(uniqTlds.map((t, i) => [t, i]));
        const available = checks
          .filter((c) => c.registered === false)
          .map((c) => c.domain)
          .sort((a, b) => {
            const [sa, ta] = [a.slice(0, a.indexOf(".")), a.slice(a.indexOf(".") + 1)];
            const [sb, tb] = [b.slice(0, b.indexOf(".")), b.slice(b.indexOf(".") + 1)];
            // Exact keyword match first, then shortest name, then TLD order.
            const ea = sa === joined ? 0 : 1;
            const eb = sb === joined ? 0 : 1;
            if (ea !== eb) return ea - eb;
            if (sa.length !== sb.length) return sa.length - sb.length;
            return (tldRank.get(ta) ?? 99) - (tldRank.get(tb) ?? 99);
          })
          .slice(0, Math.min(Math.max(limit ?? 10, 5), 20));
        return {
          keywords,
          available,
          checked: checks.length,
          takenCount: checks.filter((c) => c.registered === true).length,
          note: available.length
            ? "available per registry RDAP — confirm with a registrar before purchasing"
            : "all generated candidates are taken — try different keywords or TLDs",
        };
      },
    }),
  };
}
