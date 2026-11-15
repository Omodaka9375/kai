import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { z } from "zod";

/**
 * Local-model configuration drift probe (2026-11-15).
 *
 * The problem: an OpenAI-compatible endpoint (LM Studio, Ollama, vLLM,
 * llama.cpp) serves whatever it has loaded. When the user swaps the local
 * model — different name, maybe a different port — KAI keeps its stored
 * model id and, depending on the server, either silently runs the wrong
 * model (LM Studio serves the loaded one regardless of the requested name)
 * or errors only when the next request goes out. Nothing ever TELLS the
 * user the configured model no longer exists.
 *
 * The check: on startup (after preferences hydrate — async, never blocking
 * boot), GET `<baseURL>/models` — the standard OpenAI-compatible listing —
 * and see whether the configured model id appears. Results surface through
 * the same pattern as the MCP down-warning: a hidden-when-healthy status
 * bar pill.
 *
 * Cloud providers are deliberately NOT probed: their model lists are
 * contractually stable, a bad id fails loudly at request time, and a boot
 * ping burns quota and adds a round-trip for no information.
 *
 * Network note: the probe reaches a user-configured LOCAL endpoint, so it
 * passes `allowPrivateNetwork: true` — the documented carve-out for
 * user-entered endpoints (same as LM Studio / api-tester traffic). The URL
 * is derived from the stored baseURL, never from anything model-chosen.
 */

export type LocalModelStatus =
  | { state: "idle" } // not checked (fresh boot, not applicable)
  | { state: "checking" }
  | { state: "ok" }
  | { state: "missing"; configuredId: string; available: string[] }
  | { state: "unreachable"; error: string };

type LocalModelProbeStore = {
  status: LocalModelStatus;
  set: (s: LocalModelStatus) => void;
};

export const useLocalModelProbeStore = create<LocalModelProbeStore>((set) => ({
  status: { state: "idle" },
  set: (status) => set({ status }),
}));

const modelsListSchema = z.object({
  data: z.array(z.object({ id: z.string() })).optional(),
  // Ollama's /v1/models is OpenAI-shaped; some servers (llama.cpp) return
  // the array directly or under "models".
  models: z.array(z.object({ name: z.string().optional(), id: z.string().optional() })).optional(),
});

/** Pure: turn a /models listing into a probe verdict. Exposed for tests. */
export function evaluateModelListing(
  configuredId: string,
  body: string,
): { ok: boolean; available: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const res = modelsListSchema.safeParse(parsed);
  if (!res.success) return null;
  const ids = [
    ...(res.data.data ?? []).map((m) => m.id),
    ...(res.data.models ?? []).map((m) => m.name ?? m.id ?? ""),
  ].filter(Boolean);
  // A listing with ZERO ids is not evidence the model is missing — it's a
  // shape we didn't understand. Silence (null) instead of a false warning.
  if (ids.length === 0) return null;
  // Exact match, then a prefix fallback: "llama-3.3" vs "llama-3.3-70b…"
  // naming drift is the most common shape; a bare prefix is a genuine hit.
  const ok = ids.includes(configuredId) || ids.some((id) => id.startsWith(configuredId));
  return { ok, available: ids };
}

/** Probe one endpoint: GET /models, check the configured id against it. */
export async function probeLocalModel(
  baseUrl: string,
  configuredId: string,
): Promise<LocalModelStatus> {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  if (!clean) return { state: "unreachable", error: "no base URL configured" };
  const url = `${clean}/models`;
  try {
    const resp = await invoke<{ status: number; body: number[] }>("ai_http_request", {
      url,
      method: "GET",
      headers: { "User-Agent": "kai-model-probe" },
      body: null,
      bodyBase64: null,
      // Local endpoints (LM Studio on 127.0.0.1:1234, Ollama on 11434) are
      // exactly the allowPrivateNetwork carve-out this flag exists for.
      allowPrivateNetwork: true,
      requireLanOnly: null,
    });
    const text = new TextDecoder().decode(new Uint8Array(resp.body));
    if (resp.status === 404) {
      // Endpoint reachable but no /models route — cannot verify, say nothing
      // rather than falsely warning (older llama.cpp builds lack it).
      return { state: "ok" };
    }
    if (resp.status < 200 || resp.status >= 300) {
      return { state: "unreachable", error: `HTTP ${resp.status}` };
    }
    const verdict = evaluateModelListing(configuredId, text);
    if (!verdict) return { state: "idle" }; // unparseable listing → stay silent
    return verdict.ok
      ? { state: "ok" }
      : { state: "missing", configuredId, available: verdict.available };
  } catch (e) {
    return { state: "unreachable", error: String(e).slice(0, 120) };
  }
}

/** Top-level runner: store-driving wrapper around probeLocalModel. */
export async function runLocalModelProbe(
  baseUrl: string,
  modelId: string,
): Promise<void> {
  const store = useLocalModelProbeStore.getState();
  if (!modelId) return;
  store.set({ state: "checking" });
  const status = await probeLocalModel(baseUrl, modelId);
  useLocalModelProbeStore.getState().set(status);
}
