/**
 * Reflex engine bridge (frontend side of src-tauri reflex.rs).
 *
 * The classifier in localReflex.ts previously talked straight to a
 * user-started `serve-engine.ps1` on a fixed port. With Option A (downloaded
 * engine), this bridge owns the lifecycle: it asks Rust to ensure the
 * artifacts exist and the serve process is running, derives the endpoint
 * from the response, and exposes status/setup/remove for the settings UI.
 *
 * Everything is fire-and-forget safe: any Rust error resolves to "engine
 * unavailable" and the send flow falls through to the cloud LLM untouched.
 */
import { invoke, Channel } from "@tauri-apps/api/core";

export type ReflexStatus = {
  installed: boolean;
  running: boolean;
  version: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  installing: boolean;
  modelDepth: number;
  port: number;
};

export type ReflexSetupEvent = {
  phase: "engine" | "weights" | "tools" | "done" | "error";
  downloaded: number;
  total: number;
  message: string | null;
};

/** Cached status so the composer's per-send check is a cheap promise hit. */
let cachedEnsure: { at: number; promise: Promise<boolean> } | null = null;
const ENSURE_TTL_MS = 10_000;

/**
 * Ensure the engine is installed and running. Resolves true when the
 * /complete endpoint is expected to answer. Called (debounced) by
 * localReflex.ts before the first classify of a send; also safe to call
 * from a settings toggle.
 */
export function ensureReflexEngine(): Promise<boolean> {
  if (cachedEnsure && Date.now() - cachedEnsure.at < ENSURE_TTL_MS) {
    return cachedEnsure.promise;
  }
  const promise = invoke<ReflexStatus>("reflex_ensure_running")
    .then((status) => {
      if (status.running) {
        applyEndpointOverride(status.port);
        return true;
      }
      return false;
    })
    .catch(() => false);
  cachedEnsure = { at: Date.now(), promise };
  return promise;
}

export function invalidateReflexCache(): void {
  cachedEnsure = null;
}

export async function reflexEngineStatus(): Promise<ReflexStatus | null> {
  try {
    return await invoke<ReflexStatus>("reflex_status");
  } catch {
    return null;
  }
}

/** Download the engine + weights (progress events land in onEvent). */
export async function setupReflexEngine(
  onEvent: (e: ReflexSetupEvent) => void,
): Promise<boolean> {
  invalidateReflexCache();
  try {
    const channel = new Channel<ReflexSetupEvent>();
    channel.onmessage = onEvent;
    await invoke("reflex_setup", { onEvent: channel });
    // Warm the engine right after download so the first prompt is fast.
    const ok = await ensureReflexEngine();
    return ok;
  } catch {
    return false;
  }
}

export async function removeReflexEngine(): Promise<void> {
  invalidateReflexCache();
  try {
    await invoke("reflex_remove");
  } catch {
    // nothing to remove / already gone
  }
  clearEndpointOverride();
}

/** Keep the frontend classifier pointed at the Rust-managed port. */
function applyEndpointOverride(port: number): void {
  try {
    const key = "kai.localReflexEndpoint";
    const current = localStorage.getItem(key);
    const wanted = `http://127.0.0.1:${port}`;
    if (current !== wanted) localStorage.setItem(key, wanted);
  } catch {
    // localStorage unavailable (rare webview state) - the default port
    // matches anyway.
  }
}

function clearEndpointOverride(): void {
  try {
    localStorage.removeItem("kai.localReflexEndpoint");
  } catch {
    /* noop */
  }
}
