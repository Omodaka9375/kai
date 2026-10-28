/**
 * Central deny-only tool guards — the backstop the per-tool inline checks
 * can't provide.
 *
 * Today the security deny-list (`security.ts`) is invoked INSIDE each
 * first-party tool's execute, so a new tool — or any MCP tool — that skips
 * the inline call has no gate at all. This module adds the dsh-style
 * choke-point: a wrapper around every tool's execute whose guards have a
 * monotonic contract —
 *
 *   type ToolGuard = (call) => string | undefined
 *
 * A guard returns a denial REASON or silence (`undefined`). The return type
 * has no "allow" case, so guard ordering can never turn a denial back into
 * permission, and no guard can grant what an earlier guard refused. This is
 * deliberately weaker-than-approval and stronger-than-convention: it cannot
 * approve anything, it can only veto.
 *
 * Inline checks stay in place (defense in depth — they run pre-sandbox and
 * pre-mutation with tool-specific knowledge); this wrapper guarantees that
 * even tools which forget them still pass the path/command floor.
 */

import { checkReadable, checkShellCommand } from "./security";

/** One about-to-run tool call, seen by a guard. */
export type GuardedToolCall = {
  /** Registered tool name (MCP tools are already namespaced `server__tool`). */
  name: string;
  /** Raw model-provided arguments — untrusted, may be any JSON. */
  args: unknown;
};

/**
 * A monotonic execution guard. Return a denial reason to veto the call, or
 * `undefined` to leave it unchanged. There is NO allow result: a later
 * guard can deny, but nothing downstream of a denial can undo it.
 */
export type ToolGuard = (call: GuardedToolCall) => string | undefined;

/** Pull path-ish arguments out of a tool call's inputs. Covers the
 *  first-party shape (`path`, `edits[].path`, `source`/`destination`) and
 *  the common MCP shapes (`file_path`, `filePath`, `filename`). Anything
 *  non-string is ignored — guards must not crash on malformed input. */
export function collectPathArgs(args: unknown): string[] {
  const out: string[] = [];
  if (!args || typeof args !== "object") return out;
  const visit = (v: unknown, depth: number): void => {
    if (depth > 4 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (
        typeof val === "string" &&
        (k === "path" ||
          k === "file_path" ||
          k === "filePath" ||
          k === "filename" ||
          k === "source" ||
          k === "destination" ||
          k === "localPath" ||
          k === "remotePath" ||
          k === "archive" ||
          k === "directory")
      ) {
        out.push(val);
      } else if (typeof val === "object") {
        visit(val, depth + 1);
      }
    }
  };
  visit(args, 0);
  return out;
}

/** Commands a call may execute (first-party shell tools + common MCP
 *  shapes). */
export function collectCommandArgs(args: unknown): string[] {
  const out: string[] = [];
  if (!args || typeof args !== "object") return out;
  for (const k of ["command", "cmd", "script"]) {
    const v = (args as Record<string, unknown>)[k];
    if (typeof v === "string") out.push(v);
  }
  return out;
}

/** Read-side path floor: every path a call mentions must at least clear
 *  the secret/protected-dir READ deny-list. (Write tools run their own,
 *  stricter check inline; this catches tools that never check at all.) */
export const pathReadFloorGuard: ToolGuard = ({ args }) => {
  for (const p of collectPathArgs(args)) {
    const r = checkReadable(p);
    if (!r.ok) {
      return `Blocked by central tool guard: ${r.reason}`;
    }
  }
  return undefined;
};

/** Shell floor: every command-shaped argument must clear the destructive
 *  deny-list. Applies to ALL tools — a "rename" tool that smuggles a
 *  `command` field gets vetoed too. */
export const shellFloorGuard: ToolGuard = ({ args }) => {
  for (const c of collectCommandArgs(args)) {
    const r = checkShellCommand(c);
    if (!r.ok) {
      return `Blocked by central tool guard: ${r.reason}`;
    }
  }
  return undefined;
};

/** Default guard stack. Kept as a list so future policy (egress, path
 *  jail) is one push() away — each entry obeys the deny-only contract. */
export const DEFAULT_TOOL_GUARDS: readonly ToolGuard[] = [
  pathReadFloorGuard,
  shellFloorGuard,
];

/** Run the call past every guard, first denial wins. */
export function evaluateToolGuards(
  call: GuardedToolCall,
  guards: readonly ToolGuard[] = DEFAULT_TOOL_GUARDS,
): string | undefined {
  for (const g of guards) {
    let reason: string | undefined;
    try {
      reason = g(call);
    } catch {
      // A crashing guard must never grant permission: treat as silence and
      // keep walking the stack (other guards still apply).
      continue;
    }
    if (reason) return reason;
  }
  return undefined;
}

/**
 * Wrap every tool's `execute` with the central guard stack. A denied call
 * returns `{ error }` in the same shape the inline checks use, so effect
 * resolution (toolFencing.resolveEffect → ROLLED_BACK) and the model-facing
 * error path are unchanged. Generic over the tool-def shape so it composes
 * with `withToolRedaction` / `withToolGuard` without widening their types.
 */
export function withCentralToolGuards<T extends Record<string, unknown>>(
  tools: Record<string, T>,
  guards: readonly ToolGuard[] = DEFAULT_TOOL_GUARDS,
  onDeny?: (name: string, reason: string) => void,
): Record<string, T> {
  const out: Record<string, T> = {};
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
      // First positional arg is the tool input (AI SDK contract:
      // execute(input, options)).
      const denial = evaluateToolGuards({ name, args: args[0] }, guards);
      if (denial) {
        onDeny?.(name, denial);
        return { error: denial };
      }
      return (execute as (...a: unknown[]) => unknown)(...args);
    };
    out[name] = wrapped;
  }
  return out;
}
