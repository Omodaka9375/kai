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

import type { FenceState } from "./fence";
import { type EffectStatus } from "./effectStatus";
import { guardToolOutput, formatGuardWarning } from "./outputGuard";

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
  youtube_transcript: "NONE",

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
 * Wrap all tools with effect status annotation + output fencing.
 */
export function withToolGuard(
  tools: Record<string, ToolDef>,
  fenceState: FenceState,
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
    fenceField(r, "stdout", state.nonces.tool);
    fenceField(r, "stderr", state.nonces.tool);
  } else if (toolName === "bash_logs") {
    fenceField(r, "bytes", state.nonces.tool);
  } else if (toolName === "web_browse" || toolName === "web_fetch" || toolName === "web_search") {
    fenceField(r, "content", state.nonces.web);
    fenceField(r, "body", state.nonces.web);
  } else if (toolName === "fs_search" || toolName === "fs_grep") {
    fenceField(r, "content", state.nonces.tool);
  } else if (toolName === "youtube_transcript") {
    fenceField(r, "transcript", state.nonces.web);
  } else if (toolName.includes("__")) {
    const key = findTextKey(r);
    if (key) fenceField(r, key, state.nonces.mcp);
  } else {
    fenceField(r, "text", state.nonces.tool);
    fenceField(r, "content", state.nonces.tool);
  }

  return r;
}

function fenceField(
  r: Record<string, unknown>,
  key: string,
  nonce: string,
): void {
  const v = r[key];
  if (typeof v !== "string" || v.length === 0) return;
  const clean = v.replace(/\[start\s+\w+_\w+\]\n?/g, "")
    .replace(/\n?\[end\s+\w+_\w+\]/g, "");
  r[key] = `[start tool_${nonce}]\n${clean}\n[end tool_${nonce}]`;
}

function findTextKey(obj: Record<string, unknown>): string | null {
  for (const k of ["text", "content", "body", "result", "output", "data"]) {
    if (typeof obj[k] === "string") return k;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > 20) return k;
  }
  return null;
}