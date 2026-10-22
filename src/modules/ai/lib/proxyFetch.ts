import { Channel, invoke } from "@tauri-apps/api/core";

/** Streaming events emitted by the Rust `ai_http_stream` command. */
type AiStreamEvent =
  | { kind: "headers"; status: number; headers: Record<string, string> }
  | { kind: "chunk"; bytes: number[] }
  | { kind: "end" }
  | { kind: "error"; message: string };

type RequestHeaders = Record<string, string>;

function headerInitToRecord(
  init: HeadersInit | undefined,
): RequestHeaders | undefined {
  if (!init) return undefined;
  const out: RequestHeaders = {};
  if (init instanceof Headers) {
    init.forEach((value, key) => {
      out[key] = value;
    });
  } else if (Array.isArray(init)) {
    for (const [k, v] of init) out[k] = v;
  } else {
    for (const [k, v] of Object.entries(init)) out[k] = String(v);
  }
  return out;
}

/**
 * Convert a BodyInit to a base64 string for efficient IPC transfer.
 * Base64 is ~1.33x the original size vs ~4-5x for a JSON number array,
 * which makes image uploads (multi-MB base64 payloads) feasible.
 */
async function bodyToBase64(
  body: BodyInit | null | undefined,
): Promise<string | undefined> {
  if (body == null) return undefined;
  let bytes: Uint8Array;
  if (typeof body === "string") {
    bytes = new TextEncoder().encode(body);
  } else if (body instanceof ArrayBuffer) {
    bytes = new Uint8Array(body);
  } else if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  } else if (body instanceof Blob) {
    bytes = new Uint8Array(await body.arrayBuffer());
  } else {
    // FormData / URLSearchParams / ReadableStream — uncommon for AI SDK calls.
    const text = await new Response(body as BodyInit).text();
    bytes = new TextEncoder().encode(text);
  }
  // Use chunked btoa to avoid call-stack limits on large payloads.
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * The "LAN only" network policy (Settings → Security). When active, the
 * Rust proxy refuses PUBLIC endpoints — agent web tools can reach the LAN
 * (intranet hostnames, local model servers) but not the internet.
 *
 * Applies ONLY to model-callable fetches (web_browse / web_search /
 * media URL fetch). User-configured surfaces — MCP
 * servers, api-tester, provider calls, LM Studio — are exempt BY DESIGN:
 * those endpoints were chosen by the human, not by the model.
 *
 * The policy is read lazily per request (no fetch-instance rebuild; a flip
 * in Settings applies to the very next call, cross-window via
 * Kai://prefs-changed). Fail-closed defaults to full access only when the
 * store cannot be read (tests, plain web) — never blocks on error paths.
 */
import { usePreferencesStore } from "@/modules/settings/preferences";

function lanOnlyActive(): boolean {
  try {
    return usePreferencesStore.getState().networkPolicy === "lan";
  } catch {
    return false;
  }
}

/** Model-callable fetch surfaces only — the gate the proxy layer consults.
 *  Exported for web.ts, whose fixed-instance fetchers are
 *  model-chosen destinations. */
export function requireLanOnly(): boolean {
  return lanOnlyActive();
}

export function createProxyFetch(
  opts: { allowPrivateNetwork?: boolean } = {},
): typeof fetch {
  const allowPrivate = opts.allowPrivateNetwork === true;
  // NOT policy-gated: instances of this fetch serve user-configured
  // endpoints (MCP servers, OAuth, provider calls, LM Studio) — the human
  // chose the destination, so the LAN-only policy (which constrains what
  // the MODEL may reach) does not apply.
  return async (input, init) => proxyFetchImpl(input, init, allowPrivate, false);
}

/** Backwards-compatible default — refuses private networks unless the caller
 *  explicitly opts in via {@link createProxyFetch}. Used by provider-class
 *  flows (TTS/STT endpoints, provider CDN fetches) with fixed destinations,
 *  so the LAN-only policy does not apply here either. */
export const proxyFetch: typeof fetch = (input, init) =>
  proxyFetchImpl(input, init, false, false);

async function proxyFetchImpl(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  allowPrivateNetwork: boolean,
  lanOnly: boolean,
): Promise<Response> {
  const url = input instanceof URL ? input.toString() : String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = headerInitToRecord(init?.headers);
  const bodyBase64 = await bodyToBase64(init?.body);

  const signal = init?.signal;
  if (signal?.aborted) {
    throw makeAbortError();
  }

  return new Promise<Response>((resolve, reject) => {
    let resolved = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    let cancelled = false;

    const onAbort = () => {
      cancelled = true;
      if (!resolved) {
        reject(makeAbortError());
      } else if (streamController) {
        try {
          streamController.error(makeAbortError());
        } catch {
          /* already closed */
        }
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const channel = new Channel<AiStreamEvent>();
    channel.onmessage = (event) => {
      if (cancelled) return;
      switch (event.kind) {
        case "headers": {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
            cancel() {
              cancelled = true;
            },
          });
          resolved = true;
          resolve(
            new Response(stream, {
              status: event.status,
              headers: new Headers(event.headers),
            }),
          );
          break;
        }
        case "chunk": {
          streamController?.enqueue(Uint8Array.from(event.bytes));
          break;
        }
        case "end": {
          streamController?.close();
          break;
        }
        case "error": {
          if (!resolved) {
            reject(new Error(event.message));
          } else {
            streamController?.error(new Error(event.message));
          }
          break;
        }
      }
    };

    invoke("ai_http_stream", {
      url,
      method,
      headers,
      bodyBase64: bodyBase64 ?? null,
      allowPrivateNetwork,
      requireLanOnly: lanOnly,
      onEvent: channel,
    }).catch((e) => {
      if (resolved) return; // headers already arrived; chunk-side error wins
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

function makeAbortError(): DOMException {
  return new DOMException("Request aborted", "AbortError");
}
