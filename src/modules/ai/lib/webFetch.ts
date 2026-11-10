import { invoke } from "@tauri-apps/api/core";
import type { ZodType } from "zod";
import { requireLanOnly } from "./proxyFetch";

/**
 * Shared SSRF-hardened HTTP client for web tools.
 *
 * Same guarantees as web.ts's httpFetch: every request goes through the
 * Rust proxy (bypasses CORS), model-chosen URLs are pinned to
 * `allowPrivateNetwork: false` (loopback/private/metadata IPs are blocked
 * with DNS-pinning + per-redirect re-checks in net.rs), and the LAN-only
 * policy applies to public-internet destinations.
 *
 * Extracted so the platform-channel fetchers (channels.ts) share ONE
 * request path instead of each hand-rolling its own invoke() shape.
 */

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

export type HttpResult = { status: number; body: string };

/** GET a URL through the Rust proxy. Throws on transport errors. */
export async function webGet(
  url: string,
  opts: { headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const resp = await invoke<{
    status: number;
    headers: Record<string, string>;
    body: number[];
  }>("ai_http_request", {
    url,
    method: "GET",
    headers: { "User-Agent": BROWSER_UA, ...(opts.headers ?? {}) },
    allowPrivateNetwork: false,
    requireLanOnly: requireLanOnly(),
  });
  return {
    status: resp.status,
    body: new TextDecoder().decode(new Uint8Array(resp.body)),
  };
}

/** POST a UTF-8 or JSON body through the Rust proxy. Throws on transport errors. */
export async function webPost(
  url: string,
  opts: {
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<HttpResult> {
  const resp = await invoke<{
    status: number;
    headers: Record<string, string>;
    body: number[];
  }>("ai_http_request", {
    url,
    method: "POST",
    headers: { "User-Agent": BROWSER_UA, ...(opts.headers ?? {}) },
    body: Array.from(new TextEncoder().encode(opts.body ?? "")),
    allowPrivateNetwork: false,
    requireLanOnly: requireLanOnly(),
  });
  return {
    status: resp.status,
    body: new TextDecoder().decode(new Uint8Array(resp.body)),
  };
}

/**
 * GET a URL expecting a JSON body. Returns `null` on non-2xx or bad JSON.
 *
 * Pass a zod `schema` to VALIDATE the parsed body (2026-11-10 review
 * finding: every adapter inherited an unchecked `JSON.parse(x) as T` — a
 * third-party shape change surfaced as deep-undefined instead of a clean
 * null). With a schema, a shape mismatch returns `null` like any other
 * failure; without one, the legacy unchecked parse is kept for callers
 * that fully validate downstream.
 */
export async function webGetJson<T>(
  url: string,
  opts: { headers?: Record<string, string>; schema?: ZodType<T> } = {},
): Promise<T | null> {
  const r = await webGet(url, opts);
  if (r.status < 200 || r.status >= 300) return null;
  try {
    const parsed: unknown = JSON.parse(r.body);
    if (!opts.schema) return parsed as T;
    const res = opts.schema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}
