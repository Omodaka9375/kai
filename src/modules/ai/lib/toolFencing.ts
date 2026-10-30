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
import { presentationFor } from "./toolPresentations";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolDef = any;

// Effect status / fence / remote-surface classification all live in the
// toolPresentations registry now (single source of truth shared with the
// result card + status line). presentationFor(name) resolves an unknown tool
// to the safe default: fence = true, remoteSurface = (name includes "__").

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

    const pres = presentationFor(name);
    const doFence = pres.fence;
    const baseEffect = pres.effect;

    const originalToModelOutput = (
      toolDef as {
        toModelOutput?: (opts: { output?: unknown }) => unknown;
      }
    ).toModelOutput;

    const wrapped = { ...toolDef };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (wrapped as any).execute = async (...args: any[]) => {
      const raw = await (execute as (...a: unknown[]) => unknown)(...args);
      // Provenance: a remote fetch happened — stamp the session so any memory
      // entry written afterwards carries the injection-exposed marker.
      if (doFence && pres.remoteSurface) {
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
      // Internal metadata (_effect / guard warnings) is KEPT on the result
      // so it persists into the transcript — a finished tool part can be
      // re-rendered from (args, output) alone, including whether its side
      // effects COMMITTED / PARTIAL / ROLLED_BACK. The model never sees it:
      // the SDK serializes provider-bound content through the toModelOutput
      // installed below, and the history-replay path strips it via
      // stripModelInternalMeta in agent.ts (belt and braces —
      // convertToModelMessages runs there WITHOUT the tool defs, so it
      // cannot consult toModelOutput).
      return result;
    };
    // Provider-facing serialization: strip internal fields, then preserve a
    // tool-owned serializer when one exists. look_at_screen needs this to
    // emit its vision content part (or OCR fallback); MCP tools may need it
    // to emit structured content. Overwriting those serializers would turn
    // images into base64-bearing JSON. Only use the SDK-default text/json
    // shape when the tool did not define its own projection.
    (wrapped as Record<string, unknown>)["toModelOutput"] = (
      opts: { output?: unknown },
    ): unknown => {
      const cleaned = stripInternalMeta(opts?.output);
      if (originalToModelOutput) {
        return originalToModelOutput.call(wrapped, { ...opts, output: cleaned });
      }
      return typeof cleaned === "string"
        ? { type: "text", value: cleaned }
        : { type: "json", value: cleaned === undefined ? null : cleaned };
    };
    out[name] = wrapped;
  }

  return out;
}

/** Copy of a tool result with the internal metadata keys removed. The
 *  fields persist into the transcript for replay-accurate rendering, so
 *  every MODEL-bound path (toModelOutput above; stripModelInternalMeta in
 *  agent.ts for history replay) must use this instead of sending the raw
 *  object. Only top-level keys are affected — annotate() never nests them. */
export function stripInternalMeta(v: unknown): unknown {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return v;
  const r = { ...(v as Record<string, unknown>) };
  delete r._effect;
  delete r._outputWarnings;
  delete r._outputWarningNote;
  return r;
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

  // voice_settings doubles as a read/list tool: only a changed setting is a
  // committed mutation. Its `changed` array is null when nothing changed.
  if (toolName === "voice_settings") {
    if (r.error != null) return "ROLLED_BACK";
    return Array.isArray(r.changed) && r.changed.length > 0
      ? "COMMITTED"
      : "NONE";
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

