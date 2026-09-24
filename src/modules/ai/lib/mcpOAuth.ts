/**
 * Host-side OAuth 2.1 + PKCE client for remote (sse/http) MCP servers,
 * per the MCP spec's 2025 authorization revision:
 *
 *   1. Unauthenticated connect → server answers 401 with a `WWW-Authenticate`
 *      header pointing at the Authorization Server (resource metadata is
 *      optional; MCP servers embed the realm/resource directly).
 *   2. We act as a PUBLIC OAuth client: authorization-code + PKCE, no client
 *      secret, redirect to `http://localhost:<port>/callback` bound by the
 *      Rust host (`mcp_oauth_start`) since the webview cannot bind ports.
 *   3. Tokens are persisted in the OS keychain (service "kai", account
 *      `mcp-oauth:<server-id>`) — never localStorage, never the store file.
 *   4. On 401 with a stored token we transparently refresh once, then
 *      surface an auth-required error if the refresh fails.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createProxyFetch } from "./proxyFetch";

const KEYRING_SERVICE = "kai";

/** fetch that routes through the Rust SSRF-hardened proxy. */
const oauthFetch = createProxyFetch({ allowPrivateNetwork: true });

// ── Keychain ────────────────────────────────────────────────────────────────

type StoredTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null; // epoch ms
  /** Authorization server that issued these tokens (for refresh). */
  tokenUrl: string;
  clientId: string;
};

function accountFor(serverId: string): string {
  return `mcp-oauth:${serverId}`;
}

export async function loadMcpTokens(serverId: string): Promise<StoredTokens | null> {
  try {
    const raw = await invoke<string | null>("secrets_get", {
      service: KEYRING_SERVICE,
      account: accountFor(serverId),
    });
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredTokens;
    if (!parsed.accessToken || !parsed.tokenUrl || !parsed.clientId) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveMcpTokens(serverId: string, tokens: StoredTokens): Promise<void> {
  await invoke("secrets_set", {
    service: KEYRING_SERVICE,
    account: accountFor(serverId),
    password: JSON.stringify(tokens),
  });
}

export async function clearMcpTokens(serverId: string): Promise<void> {
  try {
    await invoke("secrets_delete", {
      service: KEYRING_SERVICE,
      account: accountFor(serverId),
    });
  } catch {
    // already absent
  }
}

// ── PKCE ────────────────────────────────────────────────────────────────────

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256B64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return b64url(new Uint8Array(digest));
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

// ── WWW-Authenticate discovery ──────────────────────────────────────────────

/**
 * Parse a `WWW-Authenticate` header per RFC 9729 OAuth 2.0 Protected
 * Resource metadata, e.g.
 *   WWW-Authenticate:Bearer realm="https://mcp.example.com",
 *     resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"
 * Falls back to common well-known locations when only a realm is present.
 */
export type AuthServerInfo = {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
};

function parseWwwAuthenticate(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    out[m[1].toLowerCase()] = m[2].replace(/\\"/g, '"');
  }
  return out;
}

type ProtectedResourceMetadata = {
  authorization_servers?: string[];
};

type AuthorizationServerMetadata = {
  authorization_endpoint?: string;
  token_endpoint?: string;
  scopes_supported?: string[];
};

/**
 * Discover the authorization server for an MCP server that answered 401.
 * Returns null when the challenge is not an OAuth bearer challenge we can
 * act on (e.g. a plain API-key server).
 */
export async function discoverAuthServer(
  serverUrl: string,
  wwwAuthenticate: string,
): Promise<AuthServerInfo | null> {
  if (!/bearer/i.test(wwwAuthenticate)) return null;
  const params = parseWwwAuthenticate(wwwAuthenticate);

  // 1. resource_metadata → fetch protected-resource metadata.
  let authServerBase: string | undefined = params.authorization_server;
  if (!authServerBase && params.resource_metadata) {
    try {
      const resp = await oauthFetch(params.resource_metadata);
      if (resp.ok) {
        const meta = (await resp.json()) as ProtectedResourceMetadata;
        authServerBase = meta.authorization_servers?.[0];
      }
    } catch {
      // fall through
    }
  }

  // 2. Bare realm — try the server's own well-known locations (common for
  //    MCP servers that co-host the AS).
  if (!authServerBase) {
    const base = new URL(serverUrl).origin;
    for (const candidate of [
      `${base}/.well-known/oauth-authorization-server`,
      `${base}/.well-known/oauth-protected-resource`,
    ]) {
      try {
        const resp = await oauthFetch(candidate);
        if (!resp.ok) continue;
        const meta = (await resp.json()) as
          & ProtectedResourceMetadata
          & AuthorizationServerMetadata;
        if (meta.authorization_servers?.[0]) {
          authServerBase = meta.authorization_servers[0];
          break;
        }
        // AS metadata served directly at this location.
        if (meta.authorization_endpoint && meta.token_endpoint) {
          return {
            authorizationUrl: meta.authorization_endpoint,
            tokenUrl: meta.token_endpoint,
            clientId: clientIdFor(serverUrl),
            scopes: meta.scopes_supported,
          };
        }
      } catch {
        // try next
      }
    }
  }

  if (!authServerBase) return null;

  // 3. Fetch the AS metadata for endpoints.
  const asWellKnown =
    authServerBase.replace(/\/+$/, "") +
    "/.well-known/oauth-authorization-server";
  try {
    const resp = await oauthFetch(asWellKnown);
    if (!resp.ok) return null;
    const meta = (await resp.json()) as AuthorizationServerMetadata;
    if (!meta.authorization_endpoint || !meta.token_endpoint) return null;
    return {
      authorizationUrl: meta.authorization_endpoint,
      tokenUrl: meta.token_endpoint,
      clientId: clientIdFor(serverUrl),
      scopes: meta.scopes_supported,
    };
  } catch {
    return null;
  }
}

/**
 * Client identifier. As a PUBLIC client we register a stable per-server
 * identifier derived from the redirect URI — servers that require dynamic
 * client registration are not supported yet (rare; Linear/GitHub/etc. accept
 * static public clients for loopback redirects).
 */
function clientIdFor(serverUrl: string): string {
  // Loopback redirect per RFC 8252: the port may vary, so key on origin.
  return `kai-mcp-${new URL(serverUrl).hostname}`;
}

// ── Authorization-code flow ────────────────────────────────────────────────

export class OAuthCancelled extends Error {
  constructor() {
    super("authentication cancelled");
  }
}

/** Wait for the browser redirect to hit our loopback listener.
 * `openBrowser` is invoked only AFTER the event listener is registered — an
 * already-granted consent can redirect within milliseconds, and an event
 * fired before `listen()` resolves would be silently dropped. */
function waitForCallback(
  listenerId: number,
  state: string,
  timeoutMs: number,
  openBrowser: () => Promise<void>,
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let unlisten: (() => void) | null = null;
    const timer = setTimeout(() => {
      void invoke("mcp_oauth_cancel", { listenerId }).catch(() => {});
      cleanup();
      reject(new Error("authentication timed out"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (unlisten) unlisten();
      unlisten = null;
    };

    void listen<{
      listenerId: number;
      params: Record<string, string>;
      error: string | null;
    }>("Kai://mcp-oauth-callback", (event) => {
      if (event.payload.listenerId !== listenerId) return;
      cleanup();
      const { params, error } = event.payload;
      if (error) {
        reject(new Error(`authentication failed: ${error}`));
        return;
      }
      if (params.state !== state) {
        reject(new Error("authentication state mismatch (possible CSRF)"));
        return;
      }
      if (params.error) {
        reject(
          new Error(
            `authorization error: ${params.error}${params.error_description ? ` — ${params.error_description}` : ""}`,
          ),
        );
        return;
      }
      if (!params.code) {
        reject(new Error("authorization response missing code"));
        return;
      }
      resolve(params);
    }).then((fn) => {
      // Promise resolved after the timeout already rejected? Then clean up.
      if (!unlisten) fn();
      else {
        unlisten = fn;
        // Listener is live — NOW open the browser (see note above).
        void openBrowser().catch((e) => {
          cleanup();
          reject(e instanceof Error ? e : new Error(String(e)));
        });
      }
    });
  });
}

export type TokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
};

/** Exchange the authorization code for tokens (PKCE verifier included). */
async function exchangeCode(
  info: AuthServerInfo,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    client_id: info.clientId,
    redirect_uri: redirectUri,
  });
  const resp = await oauthFetch(info.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`token exchange failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  return (await resp.json()) as TokenResponse;
}

/** Full interactive flow: discover → browser → callback → exchange → persist. */
export async function runAuthorizationFlow(
  serverId: string,
  serverUrl: string,
  wwwAuthenticate: string,
): Promise<StoredTokens | null> {
  const info = await discoverAuthServer(serverUrl, wwwAuthenticate);
  if (!info) {
    throw new Error(
      "server requires authentication but no OAuth authorization server could be discovered",
    );
  }

  const listener = await invoke<{ listenerId: number; port: number }>(
    "mcp_oauth_start",
    { timeoutSecs: 300 },
  );
  const redirectUri = `http://localhost:${listener.port}/callback`;

  const state = randomToken();
  const codeVerifier = randomToken();
  const codeChallenge = await sha256B64Url(codeVerifier);

  const authUrl = new URL(info.authorizationUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", info.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  if (info.scopes && info.scopes.length > 0) {
    authUrl.searchParams.set("scope", info.scopes.join(" "));
  }

  // Open the user's browser at the consent page — deferred until the
  // callback listener is live (see waitForCallback).
  const params = await waitForCallback(
    listener.listenerId,
    state,
    300_000,
    () => openUrl(authUrl.toString()),
  );
  const tokens = await exchangeCode(info, params.code, codeVerifier, redirectUri);

  const stored: StoredTokens = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
    tokenUrl: info.tokenUrl,
    clientId: info.clientId,
  };
  await saveMcpTokens(serverId, stored);
  return stored;
}

// ── Refresh ────────────────────────────────────────────────────────────────

/**
 * Refresh an access token using the stored refresh token. Returns null when
 * there is no refresh token or the grant was revoked (caller should re-auth).
 */
export async function refreshAccessToken(
  serverId: string,
  stored: StoredTokens,
): Promise<StoredTokens | null> {
  if (!stored.refreshToken) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    client_id: stored.clientId,
  });
  try {
    const resp = await oauthFetch(stored.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!resp.ok) return null;
    const tokens = (await resp.json()) as TokenResponse;
    const next: StoredTokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? stored.refreshToken,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
      tokenUrl: stored.tokenUrl,
      clientId: stored.clientId,
    };
    await saveMcpTokens(serverId, next);
    return next;
  } catch {
    return null;
  }
}

export function isTokenExpiring(stored: StoredTokens, withinMs = 30_000): boolean {
  return stored.expiresAt != null && stored.expiresAt - Date.now() < withinMs;
}

// ── Connect-time gate ───────────────────────────────────────────────────────

/** Thrown when a remote server needs sign-in but we must not open a browser
 *  (background connects). The UI surfaces the message with a Reconnect path. */
export class AuthRequiredError extends Error {
  constructor(serverName: string) {
    super(
      `authentication required — open Settings → Extensions and click Reconnect on "${serverName}" to sign in`,
    );
    this.name = "AuthRequiredError";
  }
}

export type AuthProbe = {
  ok: boolean;
  status: number;
  wwwAuthenticate: string | null;
};

/** Minimal probe: does the endpoint accept our current credentials? */
async function probe(url: string, headers: Record<string, string>): Promise<AuthProbe> {
  try {
    // HEAD may not be allowed; a GET is the safest probe for both SSE
    // (event-stream) and streamable-HTTP endpoints.
    const resp = await oauthFetch(url, { method: "GET", headers });
    const www = resp.headers.get("www-authenticate");
    return { ok: resp.ok, status: resp.status, wwwAuthenticate: www };
  } catch {
    // Network-level failure — not an auth problem; let the client surface it.
    return { ok: true, status: 0, wwwAuthenticate: null };
  }
}

/**
 * Resolve the Authorization header for a remote MCP server connect.
 *
 * - Valid stored token → returned proactively (refreshed first if it is
 *   about to expire, so long-lived sessions never 401 mid-run).
 * - Endpoint answers 401 → one refresh attempt, then (if `interactive`)
 *   the full browser flow; otherwise AuthRequiredError.
 * - Non-401 endpoints keep any static headers unchanged (API-key servers,
 *   local servers, etc.).
 */
export async function ensureAuthorization(
  serverId: string,
  serverName: string,
  serverUrl: string,
  baseHeaders: Record<string, string>,
  interactive: boolean,
): Promise<Record<string, string>> {
  if (!serverUrl) return baseHeaders;

  let tokens = await loadMcpTokens(serverId);
  if (tokens && isTokenExpiring(tokens)) {
    // Proactively refresh so a connect never starts with a token that dies
    // seconds later. On failure we keep the old one — the 401 path below
    // handles full re-auth.
    tokens = (await refreshAccessToken(serverId, tokens)) ?? tokens;
  }

  const headers: Record<string, string> = { ...baseHeaders };
  if (tokens) headers.Authorization = `Bearer ${tokens.accessToken}`;

  const first = await probe(serverUrl, headers);
  if (first.ok) return headers;

  if (first.status === 401) {
    // Token revoked/expired server-side → try one refresh, re-probe.
    if (tokens) {
      const refreshed = await refreshAccessToken(serverId, tokens);
      if (refreshed) {
        const retryHeaders = { ...baseHeaders, Authorization: `Bearer ${refreshed.accessToken}` };
        const second = await probe(serverUrl, retryHeaders);
        if (second.ok) return retryHeaders;
      }
    }
    if (!interactive) throw new AuthRequiredError(serverName);

    const challenge = first.wwwAuthenticate ?? "Bearer";
    const fresh = await runAuthorizationFlow(serverId, serverUrl, challenge);
    if (!fresh) throw new AuthRequiredError(serverName);
    return { ...baseHeaders, Authorization: `Bearer ${fresh.accessToken}` };
  }

  // 403/404/etc — static headers may still satisfy the actual client
  // handshake (probes can hit the wrong route); pass through unchanged.
  return headers;
}

export type { StoredTokens };