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
 *   type ToolGuard = (call) => string | undefined | Promise<...>
 *
 * A guard returns a denial REASON or silence (`undefined`). The return type
 * has no "allow" case, so guard ordering can never turn a denial back into
 * permission, and no guard can grant what an earlier guard refused. This is
 * deliberately weaker-than-approval and stronger-than-convention: it cannot
 * approve anything, it can only veto.
 *
 * Guards can be async (the path floor canonicalizes, which is IPC). That is
 * a 2026-11-15 fix: the synchronous signature is why the floor only ever
 * pattern-matched the LITERAL path string, so a symlink into a protected
 * directory passed the central floor — the canonical recheck lives in
 * `security.ts` as `checkReadableCanonical` and first-party tools call it
 * inline, but MCP tools have no inline check and never reached it.
 *
 * Inline checks stay in place (defense in depth — they run pre-sandbox and
 * pre-mutation with tool-specific knowledge); this wrapper guarantees that
 * even tools which forget them still pass the path/command floor.
 */

import { native } from "./native";
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
 *
 * Guards may be async. The path floor has to be: a symlink recheck needs the
 * native canonicalize, which is an IPC round trip. (2026-11-15 audit: the
 * floor was synchronous, so it could only ever pattern-match the LITERAL
 * path — a symlink into ~/.ssh slipped past it, because the canonical-form
 * recheck every first-party tool runs was structurally unavailable here.)
 */
export type ToolGuard = (
  call: GuardedToolCall,
) => string | undefined | Promise<string | undefined>;

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

/** Read-side path floor: every path a call mentions must clear the
 *  secret/protected-dir READ deny-list — on the LITERAL path AND on its
 *  canonical form. (Write tools run their own, stricter check inline; this
 *  catches tools that never check at all, above all MCP tools, which have no
 *  inline checks by construction.)
 *
 *  The canonical pass is the whole point: `checkReadable` is a pure string
 *  matcher, so without it a symlink or `..` hop that resolves into a
 *  protected directory reads as an innocuous path here and slips through.
 *
 *  Canonicalizing EVERY path arg on EVERY tool call is an IPC round trip per
 *  path, so it is gated: a literal that already fails `checkReadable` never
 *  reaches canonicalize (cheaper + keeps deny reasons pointing at what the
 *  model actually typed), and a path with no symlink-ish shape...
 *
 *  There is deliberately NO cheap-skip heuristic. A path like
 *  `D:/repo/notes.txt` has nothing suspicious in its string yet its parent
 *  can be a junction into ~/.ssh. Skipping on string shape would re-open
 *  exactly the hole this guard exists to close, so the cost is paid in full.
 *
 *  Fail-closed: if canonicalize rejects we still return ok — that is what a
 *  not-yet-existing path does (the tool itself will surface ENOENT), and the
 *  literal check has already passed. Errors that are NOT "missing path"
 *  cannot be distinguished portably across platforms, so a genuinely
 *  unreadable-but-existing path leans on the tool's own inline check.
 *
 *  Note this is defense in DEPTH against a first-party tool forgetting its
 *  check and against MCP argument smuggling — it is NOT a sandbox. A
 *  malicious MCP server process reads whatever its own user account can
 *  read, canonical paths or not.
 */
export const pathReadFloorGuard: ToolGuard = async ({ args }) => {
  for (const p of collectPathArgs(args)) {
    const r = await canonicalReadFloor(p);
    if (!r.ok) {
      return `Blocked by central tool guard: ${r.reason}`;
    }
  }
  return undefined;
};

/** Literal-then-canonical read check for one path: the deny-list on the
 *  literal string first (so an obvious secret never costs an IPC round trip
 *  and the reason names what the model typed), then the same check on the
 *  canonical form (so a symlink/`..` hop into a protected dir is caught).
 *  Split out so tests can inject a fake canonicalizer and prove the hop. */
export async function canonicalReadFloor(
  path: string,
  canonicalize: (p: string) => Promise<string> = native.canonicalize,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const initial = checkReadable(path);
  if (!initial.ok) return initial;
  let canonical: string;
  try {
    canonical = await canonicalize(path);
  } catch {
    // Path does not exist yet (or is not resolvable): the literal check above
    // already passed, and the tool's own read will surface the real error.
    return { ok: true };
  }
  const recheck = checkReadable(canonical);
  if (!recheck.ok) {
    return {
      ok: false,
      reason:
        `${recheck.reason} (the path you gave resolves to a protected location: ${canonical})`.slice(
          0,
          400,
        ),
    };
  }
  return { ok: true };
}

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

/** Run the call past every guard, first denial wins. Async because the path
 *  floor canonicalizes; guards that have nothing to check stay synchronous
 *  and cost nothing. */
export async function evaluateToolGuards(
  call: GuardedToolCall,
  guards: readonly ToolGuard[] = DEFAULT_TOOL_GUARDS,
): Promise<string | undefined> {
  for (const g of guards) {
    let reason: string | undefined;
    try {
      reason = await g(call);
    } catch {
      // Fail closed. Continuing would execute the tool when this was the
      // only guard (or when every later guard stayed silent), turning a
      // broken security check into permission.
      return "Blocked by central tool guard: a guard failed while evaluating the call; refusing to execute.";
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
      const denial = await evaluateToolGuards(
        { name, args: args[0] },
        guards,
      );
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
