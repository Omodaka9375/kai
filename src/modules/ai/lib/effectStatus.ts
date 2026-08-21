/**
 * EffectStatus — typed tool call outcomes.
 *
 * Every tool call produces an effect on the world. We MUST know which
 * kind of effect occurred, because downstream reasoning depends on it:
 *
 *   - UNKNOWN ≠ NONE: "the command timed out, we don't know if it ran"
 *     is VERY different from "the command did nothing."
 *   - PARTIAL: multi_edit with 3/5 edits applied — the file is in an
 *     intermediate state the model needs to understand.
 *   - ROLLED_BACK: batch_edit tried to apply across files, failed, and
 *     reverted — no changes survived.
 *
 * Without this distinction, the model treats every tool result as if
 * it succeeded, leading to phantom state assumptions.
 *
 * ## Integration
 *
 * Each tool execute function returns a Result object. We annotate
 * that result with an `_effect` field that the fence system strips
 * before the model sees it, or (optionally) keeps as a trusted
 * annotation the model can reason about.
 *
 * The `EffectStatus` type is also used by the conversation ledger
 * for checkpoint management and by the shell background registry
 * for process lifecycle tracking.
 */

/** The outcome of a tool call's side effects. */
export type EffectStatus =
  | "COMMITTED"   // Side effects applied successfully.
  | "NONE"         // No side effects (read-only).
  | "UNKNOWN"      // Side effects may or may not have been applied.
  | "PARTIAL"      // Some side effects applied, some did not.
  | "ROLLED_BACK"  // Side effects were applied and then reverted.
  | "REJECTED";    // Authorization denied — nothing happened.

/** Human-readable label for display purposes. */
export const EFFECT_LABELS: Record<EffectStatus, string> = {
  COMMITTED: "Committed",
  NONE: "No effect",
  UNKNOWN: "Unknown",
  PARTIAL: "Partial",
  ROLLED_BACK: "Rolled back",
  REJECTED: "Rejected",
};

/** A tool result annotated with its effect status. */
export interface ToolResult<T = unknown> {
  /** The tool's actual return value. */
  data: T;
  /** The effect status of this tool call. */
  effect: EffectStatus;
  /** Optional human-readable note about the effect. */
  note?: string;
}

/**
 * Create a committed result (tool ran, effects applied).
 */
export function committed<T>(data: T, note?: string): ToolResult<T> {
  return { data, effect: "COMMITTED", note };
}

/**
 * Create a no-effect result (read-only tool).
 */
export function noEffect<T>(data: T, note?: string): ToolResult<T> {
  return { data, effect: "NONE", note };
}

/**
 * Create an unknown-effect result (network, background process, timeout).
 */
export function unknown<T>(data: T, note?: string): ToolResult<T> {
  return { data, effect: "UNKNOWN", note };
}

/**
 * Create a partial-effect result (some edits succeeded, some failed).
 */
export function partial<T>(data: T, note?: string): ToolResult<T> {
  return { data, effect: "PARTIAL", note };
}

/**
 * Create a rolled-back result (batch edit tried and reverted).
 */
export function rolledBack<T>(data: T, note?: string): ToolResult<T> {
  return { data, effect: "ROLLED_BACK", note };
}

/**
 * Create a rejected result (gate denied the tool call).
 */
export function rejected<T>(data: T, note?: string): ToolResult<T> {
  return { data, effect: "REJECTED", note };
}

/**
 * Determine the effect status for a shell command based on its exit code
 * and whether it timed out.
 */
export function shellEffectStatus(exitCode: number | null, timedOut: boolean): EffectStatus {
  if (timedOut) return "UNKNOWN";
  if (exitCode === null) return "UNKNOWN";
  return "COMMITTED"; // Shell commands always have side effects if they ran.
}

/**
 * Strip the _effect wrapper from a ToolResult, returning the raw data.
 * Used at the fence boundary so the model sees clean data (or optionally
 * sees the annotated form).
 */
export function unwrapResult<T>(result: ToolResult<T> | T): T {
  if (result != null && typeof result === "object" && "_effect" in (result as Record<string, unknown>)) {
    return (result as ToolResult<T>).data;
  }
  return result as T;
}

/**
 * Annotate a raw result with its effect status for internal tracking.
 * This adds an `_effect` field that the fence/output stripping removes
 * before the model sees the result. Used by tool implementations.
 */
export function annotateResult<T extends Record<string, unknown>>(
  result: T,
  effect: EffectStatus,
  note?: string,
): T & { _effect: EffectStatus; _note?: string } {
  return { ...result, _effect: effect, ...(note ? { _note: note } : {}) };
}

/**
 * Extract the effect status from an annotated result.
 */
export function getEffectStatus(result: unknown): EffectStatus | null {
  if (result != null && typeof result === "object" && "_effect" in (result as Record<string, unknown>)) {
    const status = (result as Record<string, unknown>)._effect;
    if (typeof status === "string" && isEffectStatus(status)) return status;
  }
  return null;
}

function isEffectStatus(s: string): s is EffectStatus {
  return ["COMMITTED", "NONE", "UNKNOWN", "PARTIAL", "ROLLED_BACK", "REJECTED"].includes(s);
}