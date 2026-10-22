/**
 * Tool output guard — wraps tool execute functions so every tool result is:
 *
 * 1. Annotated with an EffectStatus (COMMITTED/NONE/UNKNOWN/PARTIAL/ROLLED_BACK)
 * 2. Fenced with nonce-delimited trust boundaries
 *
 * The annotation tells the model whether side effects actually happened.
 * The fence prevents prompt injection from untrusted tool output.
 *
 * Both guards run in a single wrapper so there's only one interception point.
 */

import type { FenceOptions, FenceState, FenceTag } from "./fence";
import { fence } from "./fence";
import { type EffectStatus } from "./effectStatus";
import { guardToolOutput, formatGuardWarning } from "./outputGuard";
import { redactToolOutput } from "./redact";
import { noteWrite } from "./autoVerify";
import { noteRemoteSurfaceTouched } from "./provenance";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolDef = any;

/**
 * Default effect status per tool name. Overridden by result inspection
 * for tools like bash_run (timed_out → UNKNOWN) and multi_edit (partial
 * failures → PARTIAL).
 */
const DEFAULT_EFFECT: Record<string, EffectStatus> = {
  // Mutating tools — side effects are visible and committed.
  write_file: "COMMITTED",
  edit: "COMMITTED",
  multi_edit: "COMMITTED",
  batch_edit: "COMMITTED",
  create_directory: "COMMITTED",
  fs_delete: "COMMITTED",
  fs_rename: "COMMITTED",
  fs_create_file: "COMMITTED",

  // Shell tools — outcome varies.
  bash_run: "COMMITTED",
  shell_session_run: "COMMITTED",
  bash_background: "UNKNOWN",
  bash_kill: "UNKNOWN",
  bash_logs: "NONE",

  // Read-only tools — no side effects.
  read_file: "NONE",
  list_directory: "NONE",
  grep: "NONE",
  glob: "NONE",
  fs_search: "NONE",
  fs_grep: "NONE",
  get_terminal_output: "NONE",

  // Web tools — fetch is read-only from our perspective.
  web_browse: "NONE",
  web_fetch: "NONE",
  web_search: "NONE",

  // Structural tools.
  todo_write: "COMMITTED",
  checkpoint_undo: "ROLLED_BACK",
  run_subagent: "NONE",

  // Media generation.
  generate_image: "NONE",
  generate_video: "NONE",

  // Terminal interaction.
  suggest_command: "NONE",
  display_image: "NONE",
  open_preview: "NONE",
};

/** Remote surfaces — content KAI does not control. Fencing one of these
 *  tags the owning session in the provenance tracker so subsequent
 *  save_memory entries are stamped "injection-exposed" (see provenance.ts).
 *  MCP tools (server__name) are detected by the `__` separator separately. */
const REMOTE_SURFACE_TOOLS: Set<string> = new Set([
  "web_browse",
  "web_fetch",
  "web_search",
]);

/** Tools that should NOT be fenced (structural, no inline text output). */
const NO_FENCE: Set<string> = new Set([
  "bash_background",
  "bash_list",
  "bash_kill",
  "todo_write",
  "checkpoint_undo",
  "run_subagent",
  "generate_image",
  "generate_video",
]);

/**
 * Wrap every tool's `execute` so its result is scrubbed of credential-shaped
 * strings before anything (the model, the output guard, the transcript) sees
 * it.
 *
 * This is applied as the INNERMOST wrapper — before `withToolGuard` — so the
 * output guard and the fence both operate on already-redacted text, and so
 * redaction still happens on the unfenced path (fencing is opt-in per session
 * via `fenceState`; redaction is not).
 */
export function withToolRedaction(tools: Record<string, ToolDef>): Record<string, ToolDef> {
  const out: Record<string, ToolDef> = {};

  for (const [name, toolDef] of Object.entries(tools)) {
    const execute = (toolDef as { execute?: (...args: unknown[]) => unknown })
      .execute;
    if (!execute) {
      out[name] = toolDef;
      continue;
    }

    const wrapped = { ...toolDef };
    (wrapped as { execute?: (...args: unknown[]) => unknown }).execute = async (
      ...args: unknown[]
    ) => {
      const raw = await (execute as (...a: unknown[]) => unknown)(...args);
      return redactToolOutput(name, raw);
    };
    out[name] = wrapped;
  }

  return out;
}

/**
 * Wrap all tools with effect status annotation + output fencing.
 */
export function withToolGuard(
  tools: Record<string, ToolDef>,
  fenceState: FenceState,
  getWorkspaceRoot?: (() => string | null) | null,
): Record<string, ToolDef> {
  const out: Record<string, ToolDef> = {};

  for (const [name, toolDef] of Object.entries(tools)) {
    const execute = (toolDef as { execute?: (...args: unknown[]) => unknown })
      .execute;
    if (!execute) {
      out[name] = toolDef;
      continue;
    }

    const doFence = !NO_FENCE.has(name);
    const baseEffect = DEFAULT_EFFECT[name] ?? "NONE";

    const wrapped = { ...toolDef };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (wrapped as any).execute = async (...args: any[]) => {
      const raw = await (execute as (...a: unknown[]) => unknown)(...args);
      // Provenance: a remote fetch happened — stamp the session so any memory
      // entry written afterwards carries the injection-exposed marker.
      if (doFence && (REMOTE_SURFACE_TOOLS.has(name) || name.includes("__"))) {
        noteRemoteSurfaceTouched(fenceState.sessionId);
      }
      const effect = resolveEffect(name, raw, baseEffect);
      let result = annotate(raw, effect);
      // Run output guard before fencing — the warnings are added to
      // the result so the model sees them alongside the fenced content.
      if (doFence) {
        const guard = guardToolOutput(name, result);
        if (guard.hasWarnings) {
          const note = formatGuardWarning(guard);
          if (note) result = { ...result, _outputWarnings: guard.warnings, _outputWarningNote: note };
        }
        result = fenceToolOutput(name, result, fenceState);
      }
      // AUTO-VERIFY: mark the project dirty after a successful write. The
      // verification itself runs ONCE at run end (AgentRunBridge →
      // verifyIfDirtyAtRunEnd) — a per-write await would stall every tool
      // result on a full typecheck and fire on half-edited mid-refactor
      // states. Zero latency here; the mark is a synchronous Map write.
      if (effect === "COMMITTED") {
        noteWrite(name, getWorkspaceRoot?.() ?? null);
      }
      // Strip internal metadata before it reaches the model. The model
      // has no explanation for _effect (e.g. "COMMITTED") and may
      // misinterpret it as a stop/completion signal.
      delete (result as Record<string, unknown>)._effect;
      delete (result as Record<string, unknown>)._outputWarnings;
      delete (result as Record<string, unknown>)._outputWarningNote;
      return result;
    };
    out[name] = wrapped;
  }

  return out;
}

// ── Effect resolution ─────────────────────────────────────────────────────

function resolveEffect(
  toolName: string,
  result: unknown,
  base: EffectStatus,
): EffectStatus {
  if (result == null || typeof result !== "object") return base;

  const r = result as Record<string, unknown>;

  // Shell commands: timed_out → UNKNOWN, exit_code ≠ null → COMMITTED.
  if (toolName === "bash_run" || toolName === "shell_session_run") {
    if (r.timed_out === true) return "UNKNOWN";
    if (r.exit_code === null) return "UNKNOWN";
    return "COMMITTED";
  }

  // multi_edit: check for partial success.
  if (toolName === "multi_edit") {
    if (r.applied != null && r.failed != null) {
      const applied = Number(r.applied);
      const failed = Number(r.failed);
      if (failed > 0 && applied > 0) return "PARTIAL";
      if (failed > 0 && applied === 0) return "ROLLED_BACK";
    }
    if (r.error != null) return "ROLLED_BACK";
    return "COMMITTED";
  }

  // batch_edit: check for rollback.
  if (toolName === "batch_edit") {
    if (r.ok === false) return "ROLLED_BACK";
    return "COMMITTED";
  }

  // edit: check for error.
  if (toolName === "edit") {
    if (r.error != null) return "ROLLED_BACK";
    return "COMMITTED";
  }

  // write_file: check for error string.
  if (toolName === "write_file") {
    if (typeof r.error === "string") return "ROLLED_BACK";
    return "COMMITTED";
  }

  // bash_kill: exit status may tell us.
  if (toolName === "bash_kill") {
    if (r.ok === true) return "COMMITTED";
    return "UNKNOWN";
  }

  return base;
}

function annotate(
  result: unknown,
  effect: EffectStatus,
): Record<string, unknown> {
  if (result == null || typeof result !== "object") {
    return { _effect: effect, value: result };
  }
  if (result instanceof Error) {
    return { _effect: "ROLLED_BACK", error: result.message };
  }
  return { ...(result as Record<string, unknown>), _effect: effect };
}

// ── Output fencing ────────────────────────────────────────────────────────

function fenceToolOutput(
  toolName: string,
  result: Record<string, unknown>,
  state: FenceState,
): Record<string, unknown> {
  const r = { ...result };

  if (toolName === "bash_run" || toolName === "shell_session_run") {
    fenceField(r, "stdout", "tool", state.nonces.tool);
    fenceField(r, "stderr", "tool", state.nonces.tool);
  } else if (toolName === "bash_logs") {
    fenceField(r, "bytes", "tool", state.nonces.tool);
  } else if (toolName === "web_browse" || toolName === "web_fetch") {
    // Remote surface: strip invisible/bidi chars + bind provenance.
    // `hiddenDropped` (from the extractor) is declared in the fence header so
    // the user sees the page tried to hide text from a naive scraper.
    fenceField(r, "content", "web", state.nonces.web, {
      sanitize: true,
      source: typeof r.url === "string" ? r.url : undefined,
      droppedHidden:
        typeof r.hiddenDropped === "number" ? r.hiddenDropped : undefined,
    });
    fenceField(r, "body", "web", state.nonces.web, { sanitize: true });
    // The catch path returns `{ error: String(e), url }` — an error string can
    // embed attacker-influenced content (an echoed URL, an HTTP error body
    // surfaced by the Rust proxy). Fence + sanitize it like any other remote
    // payload, or the forger-marker/DSML defense silently skips the error
    // path — exactly the shape a failed fetch of a hostile page produces.
    fenceField(r, "error", "web", state.nonces.web, {
      sanitize: true,
      source: typeof r.url === "string" ? r.url : undefined,
    });
  } else if (toolName === "web_search") {
    // Titles/snippets are attacker-influenced text — fence each result
    // (urls stay plain: metadata for the agent's browsing decision).
    fenceSearchResults(r, state.nonces.web);
  } else if (toolName === "fs_search" || toolName === "fs_grep") {
    // Both tools return `{ root, hits[], truncated, files_scanned }` — there is
    // no top-level `content`/`text`, so the generic fallback below never fires.
    // Fence the `text`/`content` field of every hit in the `hits` array.
    fenceHits(r, "hits", "tool", state.nonces.tool);
    fenceField(r, "content", "tool", state.nonces.tool);
  } else if (toolName.includes("__")) {
    // MCP server output: fence EVERY string field over the fence-entry
    // threshold, not just the first text-ish key — a result like
    // `{ summary, details }` would otherwise land `details` raw in the
    // model's context while `summary` got the trust boundary.
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === "string" && v.length > 0) {
        fenceField(r, k, "mcp", state.nonces.mcp, {
          sanitize: true,
          source: toolName.slice(0, toolName.indexOf("__")),
        });
      }
    }
  } else {
    fenceField(r, "text", "tool", state.nonces.tool);
    fenceField(r, "content", "tool", state.nonces.tool);
  }

  return r;
}

function fenceField(
  r: Record<string, unknown>,
  key: string,
  tag: FenceTag,
  nonce: string,
  opts?: FenceOptions,
): void {
  const v = r[key];
  if (typeof v !== "string" || v.length === 0) return;
  r[key] = fence(tag, nonce, v, opts);
}

/** Fence string fields (`text`, `content`, `body`) of every element in an
 *  array-valued key, e.g. grep/glob `hits`. Leaves non-string fields and
 *  non-array keys untouched. */
function fenceHits(
  r: Record<string, unknown>,
  key: string,
  tag: FenceTag,
  nonce: string,
): void {
  const v = r[key];
  if (!Array.isArray(v)) return;
  r[key] = v.map((item) => {
    if (item === null || typeof item !== "object") return item;
    const rec = { ...(item as Record<string, unknown>) };
    for (const field of ["text", "content", "body", "data"]) {
      const s = rec[field];
      if (typeof s === "string" && s.length > 0) {
        rec[field] = fence(tag, nonce, s);
      }
    }
    return rec;
  });
}

/** Fence the per-result text of a web_search result list: title + snippet are
 *  attacker-influenced; the url stays plain (metadata the agent decides on).
 *  Each result carries its own URL as the fence's `[source: …]`. */
function fenceSearchResults(
  r: Record<string, unknown>,
  nonce: string,
): void {
  const v = r.results;
  if (!Array.isArray(v)) return;
  r.results = v.map((item) => {
    if (item === null || typeof item !== "object") return item;
    const rec = { ...(item as Record<string, unknown>) };
    const source = typeof rec.url === "string" ? rec.url : undefined;
    for (const field of ["title", "snippet"]) {
      const s = rec[field];
      if (typeof s === "string" && s.length > 0) {
        rec[field] = fence("web", nonce, s, { sanitize: true, source });
      }
    }
    return rec;
  });
}

