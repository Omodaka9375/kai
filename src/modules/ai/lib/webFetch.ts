import { invoke } from "@tauri-apps/api/core";
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

/** GET a URL expecting a JSON body. Returns `null` on non-2xx or bad JSON. */
export async function webGetJson<T>(
  url: string,
  opts: { headers?: Record<string, string> } = {},
): Promise<T | null> {
  const r = await webGet(url, opts);
  if (r.status < 200 || r.status >= 300) return null;
  try {
    return JSON.parse(r.body) as T;
  } catch {
    return null;
  }
}
