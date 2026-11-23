/**
 * Reflex engine bridge (frontend side of src-tauri reflex.rs).
 *
 * The classifier in localReflex.ts talks to Rust via IPC (`reflex_classify`).
 * This bridge owns the lifecycle: it asks Rust to ensure the artifacts exist
 * and the serve process is running, and exposes status/setup/remove for the
 * settings UI.
 *
 * Everything is fire-and-forget safe: any Rust error resolves to "engine
 * unavailable" and the send flow falls through to the cloud LLM untouched.
 */
import { invoke, Channel } from "@tauri-apps/api/core";

export type ReflexStatus = {
  installed: boolean;
  running: boolean;
  modelName: string;
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
 * /complete endpoint is expected to answer.
 */
export function ensureReflexEngine(): Promise<boolean> {
  if (cachedEnsure && Date.now() - cachedEnsure.at < ENSURE_TTL_MS) {
    return cachedEnsure.promise;
  }
  const promise = invoke<ReflexStatus>("reflex_ensure_running")
    .then((status) => status.running)
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

/** Download the engine + weights (progress events land in onEvent) and warm it. */
export async function setupReflexEngine(
  onEvent: (e: ReflexSetupEvent) => void,
): Promise<boolean> {
  invalidateReflexCache();
  const channel = new Channel<ReflexSetupEvent>();
  channel.onmessage = onEvent;
  await invoke("reflex_setup", { onEvent: channel });
  // Warm the engine right after download so the first prompt is fast.
  return ensureReflexEngine();
}

export async function removeReflexEngine(): Promise<void> {
  invalidateReflexCache();
  await invoke("reflex_remove");
}
