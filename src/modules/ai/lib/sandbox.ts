/**
 * Agent sandbox — frontend state for the per-project execution policy.
 *
 * The authoritative config lives in the project at `.kai/sandbox.json`,
 * enforced by the Rust layer. This module caches the loaded mode per
 * workspace root so consumers (session badge, tool gating) don't hammer
 * IPC on every render.
 */

import type { SandboxMode } from "./native";
import { native } from "./native";
import { IS_WINDOWS } from "@/lib/platform";

export type SandboxCache = { root: string; mode: SandboxMode } | null;

let cached: SandboxCache = null;

/** The workspace root the sandbox confines tool IO to. Set by App.tsx from
 * the same live-context source tools resolve against. Null = no project →
 * sandboxing is a no-op. */
let currentRoot: string | null = null;

/** Set the confinement root (App.tsx live-context effect). */
export function setSandboxRoot(root: string | null): void {
  const norm = root ? normPath(root) : null;
  if (norm === currentRoot) return;
  currentRoot = norm;
}

function normPath(p: string): string {
  let s = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** True when `abs` is the root itself or a descendant. Case-insensitive on
 * Windows (case-preserving but case-insensitive FS). */
function isWithin(abs: string, root: string): boolean {
  const a = normPath(abs);
  const r = normPath(root);
  if (a === r) return true;
  if (IS_WINDOWS) {
    const al = a.toLowerCase();
    const rl = r.toLowerCase();
    return al === rl || al.startsWith(`${rl}/`);
  }
  return a.startsWith(`${r}/`);
}

export type SandboxDecision = { ok: true } | { ok: false; reason: string };

/**
 * A per-call confinement override that replaces the module-global sandbox
 * root + per-project mode. The Telegram assistant uses it to force
 * workspaceOnly confinement to its own scratch dir regardless of the
 * desktop's Settings → Sandbox — the global `currentRoot` is owned by
 * App.tsx for the active desktop project, and a single global can't safely
 * serve a headless assistant turn interleaved with a desktop agent at every
 * await point. The desktop path passes no override and behaves exactly as
 * before (global root + `.kai/sandbox.json`).
 */
export type SandboxOverride = { root: string; mode: SandboxMode };

/** Resolve (root, mode) for a check: an explicit override wins, else the
 *  global root + its per-project mode. `null` root = confinement is a no-op. */
async function effectiveSandbox(
  override?: SandboxOverride | null,
): Promise<{ root: string | null; mode: SandboxMode }> {
  if (override) return { root: normPath(override.root), mode: override.mode };
  if (!currentRoot) return { root: null, mode: "off" };
  return { root: currentRoot, mode: await loadSandboxMode(currentRoot) };
}

/**
 * Confinement check applied on canonicalized paths by the security layer
 * (checkReadableCanonical / checkWritableCanonical) so every fs tool inherits
 * it. Semantics:
 *   off            — allow everything (no-op).
 *   readOnly       — reads allowed anywhere the security layer permits;
 *                    writes must be inside the project root.
 *   workspaceOnly  — reads AND writes must be inside the project root.
 *
 * `override` (see {@link SandboxOverride}) substitutes the root + mode for
 * this one call; omit it to use the global sandbox (desktop behavior).
 */
export async function checkSandbox(
  kind: "read" | "write",
  abs: string,
  override?: SandboxOverride | null,
): Promise<SandboxDecision> {
  const { root, mode } = await effectiveSandbox(override);
  if (!root) return { ok: true };
  if (mode === "off") return { ok: true };
  if (mode === "readOnly" && kind === "read") return { ok: true };
  if (isWithin(abs, root)) return { ok: true };
  const label = mode === "readOnly" ? "read-only" : "workspace-only";
  const area = override ? "the allowed root" : "the project";
  return {
    ok: false,
    reason: `Blocked by sandbox (${label}): ${kind}s outside ${area} are not allowed. Ask the user to change the sandbox mode in Settings > Sandbox if this is intended. Path: ${abs}`,
  };
}

// ── Shell command gating ─────────────────────────────────────────────────
//
// Full command parsing is L2's job (OS-level confinement). This is the
// best-effort L1 gate. CLASSIFICATION RULE (learned the hard way): a path
// claim must be a WHOLE shell argument, never a mid-string fragment —
// the previous substring tokenizer treated `src/lib/foo.test.ts` as the
// absolute path `/lib/foo.test.ts`, and matched sed expressions
// (`s/foo/bar/`), URL fragments (`https://...` → drive letter `s:`),
// date formats (`+%Y/%m`), regex args (`^/usr`), and shebangs inside
// string literals as path claims — blocking everyday commands in
// workspaceOnly mode.
//
// Unresolvable tokens fall through to the normal approval card — the user
// is the backstop, as with every shell command today.

/** URL scheme — `https://…`, `file://…`. Never a filesystem claim. */
const URL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** Paths inside the user's own tree that tools legitimately touch even when
 * sandboxed (none today — listed for future additions like temp dirs). */
const SHELL_ALLOW_OUTSIDE: string[] = [];

/**
 * Split a shell command into argument tokens for path classification.
 * Quote-aware (single/double quotes strip and protect spaces); whitespace
 * and shell separators (`; | & ( ) < >`) outside quotes are boundaries.
 * Not a full parser — command substitutions and escapes pass through as
 * literal text and simply fail to classify as paths.
 */
export function splitShellArgs(command: string): string[] {
  return splitShellTokens(command).map((token) => token.value);
}

/** Small quote-aware shell lexer used by both path classification and
 *  redirection detection. Operators stay separate so `echo hi>/tmp/x`
 *  cannot masquerade as a read, while quoted ">" remains ordinary text. */
function splitShellTokens(command: string): Array<{ value: string; operator: boolean }> {
  const out: Array<{ value: string; operator: boolean }> = [];
  let cur = "";
  let curHasUnquoted = false;
  let quote: '"' | "'" | null = null;
  const push = () => {
    if (cur) {
      out.push({
        value: cur,
        // Operators must consist entirely of unquoted shell characters.
        operator: curHasUnquoted && /^(?:\d+)?(?:>>?|<<?)$/.test(cur),
      });
      cur = "";
      curHasUnquoted = false;
    }
  };
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // Do NOT push: shell concatenates quoted/unquoted fragments into one
      // argument (`pre"/tmp/x"` is one word, not `/tmp/x` as a bare path).
      quote = ch;
      continue;
    }
    if (/[\s;|&()]/.test(ch)) {
      push();
      continue;
    }
    if (ch === "<" || ch === ">") {
      push();
      out.push({ value: ch, operator: true });
      curHasUnquoted = false;
      continue;
    }
    cur += ch;
    curHasUnquoted = true;
  }
  push();
  return out;
}

/** True when the command redirects output (including fd-prefixed and
 *  whitespace-free forms: >, >>, 2>, 2>>). */
function hasOutputRedirection(command: string): boolean {
  const tokens = splitShellTokens(command);
  return tokens.some(
    (token, index) =>
      token.operator &&
      token.value.includes(">") &&
      tokens[index + 1]?.value,
  );
}

/** True when a token contains a `..` path segment — relative traversal
 * that can escape the project (resolved against the agent's cwd). */
function isEscapeTraversal(tok: string): boolean {
  return tok.split(/[\\/]/).includes("..");
}

/**
 * Classify one shell argument as a filesystem claim, or null when it is
 * not one (options, URLs, relative paths, substitution soup).
 *   - Windows absolute: single drive letter + separator (`D:/…`, `D:\\…`).
 *     The drive must be ONE letter — `s://…` (URL residue) never matches.
 *   - Unix absolute: argument STARTS with `/`.
 *   - Home-relative: `~/…` (home is never inside the project → outside).
 *   - Traversal: any `..` segment (relative escape, e.g. `../secrets`).
 */
function pathClaim(tok: string): string | null {
  if (!tok || tok.startsWith("-")) return null; // options
  if (URL_RE.test(tok)) return null;
  if (/^[A-Za-z]:[\\/]/.test(tok)) return tok;
  if (tok.startsWith("/")) {
    // Quote-stripped substitution soup (awk programs, brace groups) is not
    // a path. Real absolute paths carry no shell metacharacters.
    return /[{}"'`$*?|;]/.test(tok) ? null : tok;
  }
  if (/^~\//.test(tok) || /^~\\/.test(tok)) return tok; // ~/… but not bare ~
  if (isEscapeTraversal(tok)) return tok;
  return null;
}

/**
 * Gate a shell command against the sandbox. Flags commands whose ARGUMENTS
 * name paths outside the project. Write-shaped commands (cp/mv/rm/tee/…,
 * output redirection) are blocked on ANY outside claim in both modes;
 * read-shaped commands naming outside paths are allowed in readOnly (the
 * approval card is the gate for reads) and blocked in workspaceOnly.
 */
export async function checkShellSandbox(
  command: string,
  override?: SandboxOverride | null,
): Promise<SandboxDecision> {
  const { root, mode } = await effectiveSandbox(override);
  if (!root) return { ok: true };
  if (mode === "off") return { ok: true };

  const writeShaped =
    /\b(cp|mv|rm|rmdir|mkdir|tee|touch|truncate|shred|install|rsync|dd)\b/i.test(
      command,
    ) || hasOutputRedirection(command);

  const outside: string[] = [];
  for (const tok of splitShellArgs(command)) {
    const claim = pathClaim(tok);
    if (!claim) continue;
    if (isWithin(claim, root)) continue;
    if (SHELL_ALLOW_OUTSIDE.some((p) => isWithin(claim, p))) continue;
    outside.push(claim);
  }
  if (outside.length === 0) return { ok: true };
  if (!writeShaped && mode === "readOnly") {
    // Reads outside are allowed in readOnly mode — shell commands may
    // legitimately inspect other locations; the approval card is the gate.
    return { ok: true };
  }
  const label = mode === "readOnly" ? "read-only" : "workspace-only";
  const area = override ? "the allowed root" : "the project";
  return {
    ok: false,
    reason: `Blocked by sandbox (${label}): the command names path(s) outside ${area}:\n  ${outside.slice(0, 5).join("\n  ")}\nRun it inside ${area}, or ask the user to change the sandbox mode in Settings > Sandbox.`,
  };
}

/** Load the sandbox mode for a workspace root (cached per root). */
export async function loadSandboxMode(
  root: string | null | undefined,
): Promise<SandboxMode> {
  if (!root) return "off";
  if (cached?.root === root) return cached.mode;
  try {
    const c = await native.sandboxLoadConfig(root);
    cached = { root, mode: c.mode };
    return c.mode;
  } catch {
    return "off";
  }
}

/** Drop the cache — after settings writes or workspace switches. */
export function invalidateSandboxCache(): void {
  cached = null;
}

/** Test seam: pin the mode resolved for `loadSandboxMode`, bypassing IPC. */
export function __setSandboxModeForTests(
  root: string | null,
  mode: SandboxMode,
): void {
  cached = root ? { root: normPath(root), mode } : null;
}

export const SANDBOX_LABELS: Record<SandboxMode, string> = {
  off: "Sandbox off",
  readOnly: "Sandbox: read-only (writes confined to project)",
  workspaceOnly: "Sandbox: workspace only (all IO confined to project)",
};

/**
 * The OS-confinement root (Layer 2) for shell commands, or null when the
 * sandbox is off / readOnly. Only `workspaceOnly` OS-confines: an OS wall
 * would also block reads, which readOnly explicitly allows. Passed to the
 * Rust `sandbox_root` param on shell commands; the Rust side falls back to
 * the plain command when the platform runner (bwrap / sandbox-exec) is
 * missing.
 */
export async function sandboxExecRoot(
  override?: SandboxOverride | null,
): Promise<string | null> {
  const { root, mode } = await effectiveSandbox(override);
  if (!root) return null;
  return mode === "workspaceOnly" ? root : null;
}
