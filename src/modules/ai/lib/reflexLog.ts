/**
 * Reflex usage log (2026-11-23) - the mining loop's data capture.
 *
 * Every reflex decision and every main-LLM execution of a reflex-capable
 * tool lands in a bounded local ring (`kai-reflex-log.json`, app data dir,
 * last REFLEX_LOG_CAP entries). `scripts/cactus/mine_usage.py` turns the
 * ring into real-usage training rows for the next Cactus fine-tune, which
 * is the loop that actually moves accuracy: frozen-suite hard negatives
 * plateaued (Run #3), real prompts do not.
 *
 * PRIVACY: entries stay on-device (same store class as kai-agents.json).
 * Only the user's own prompt text (truncated) and tool arguments are
 * recorded - never tool RESULTS, file contents, or model output.
 *
 * Three outcome kinds:
 *  - "executed"      the reflex handled the prompt locally
 *  - "fallthrough"   the reflex passed the prompt to the cloud LLM, with a
 *                    reason (engine-down entries are rare - the 60 s cache
 *                    collapses them - and mining ignores them)
 *  - "mined-llm-tool" the MAIN LLM executed a reflex-capable tool; paired
 *                    with the last user prompt this is a REAL positive
 *                    example (user intent -> correct calls) regardless of
 *                    what the reflex did.
 */
import { LazyStore } from "@tauri-apps/plugin-store";
import { REFLEX_ALLOWED_CANONICAL_TOOLS } from "./localReflex";

const STORE_PATH = "kai-reflex-log.json";
const KEY_ENTRIES = "entries";
export const REFLEX_LOG_CAP = 600;

export type ReflexOutcome = "executed" | "fallthrough" | "mined-llm-tool";

export type ReflexCall = { name: string; arguments: Record<string, unknown> };

export type ReflexEntry = {
  ts: number;
  sessionId: string;
  outcome: ReflexOutcome;
  /** User prompt text, truncated to 200 chars. Never tool output. */
  prompt: string;
  /** fallthrough reason: disabled | engine-down | long-prompt | non-text |
   *  no-reply | low-confidence | empty-calls | disallowed-tool | unmapped |
   *  conversational | code-shaped | ungrounded */
  reason?: string;
  confidence?: number;
  /** Canonical KAI calls (post-mapping) when known. */
  calls?: ReflexCall[];
  /** Engine classify latency in ms (executed/fallthrough entries). */
  latencyMs?: number;
  /** Whether the local execution succeeded (executed entries). */
  execOk?: boolean;
};

let store: LazyStore | null = null;
function getStore(): LazyStore {
  if (!store) store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 500 });
  return store;
}

/** Serialize read-modify-write appends so concurrent tool steps or sessions
 *  cannot overwrite each other's log entries. */
let writeQueue: Promise<void> = Promise.resolve();

/** Fire-and-forget append; logging must never break the send flow. */
export function recordReflexEntry(entry: ReflexEntry): void {
  writeQueue = writeQueue.then(async () => {
    try {
      const s = getStore();
      const cur = (await s.get<ReflexEntry[]>(KEY_ENTRIES)) ?? [];
      cur.push(entry);
      if (cur.length > REFLEX_LOG_CAP) cur.splice(0, cur.length - REFLEX_LOG_CAP);
      await s.set(KEY_ENTRIES, cur);
    } catch (e) {
      console.debug("[kai:reflex-log] append failed:", e);
    }
  });
}

export async function getReflexEntries(): Promise<ReflexEntry[]> {
  return (await getStore().get<ReflexEntry[]>(KEY_ENTRIES)) ?? [];
}

export async function clearReflexLog(): Promise<void> {
  await getStore().set(KEY_ENTRIES, []);
}

// ── Mining helper: is this canonical tool part minable? ───────────────────

export function isReflexCapableTool(name: string): boolean {
  return REFLEX_ALLOWED_CANONICAL_TOOLS.has(name);
}
