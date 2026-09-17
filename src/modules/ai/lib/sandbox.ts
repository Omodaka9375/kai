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
 * Confinement check applied on canonicalized paths by the security layer
 * (checkReadableCanonical / checkWritableCanonical) so every fs tool inherits
 * it. Semantics:
 *   off            — allow everything (no-op).
 *   readOnly       — reads allowed anywhere the security layer permits;
 *                    writes must be inside the project root.
 *   workspaceOnly  — reads AND writes must be inside the project root.
 */
export async function checkSandbox(
  kind: "read" | "write",
  abs: string,
): Promise<SandboxDecision> {
  const root = currentRoot;
  if (!root) return { ok: true };
  const mode = await loadSandboxMode(root);
  if (mode === "off") return { ok: true };
  if (mode === "readOnly" && kind === "read") return { ok: true };
  if (isWithin(abs, root)) return { ok: true };
  const label = mode === "readOnly" ? "read-only" : "workspace-only";
  return {
    ok: false,
    reason: `Blocked by sandbox (${label}): ${kind}s outside the project are not allowed. Ask the user to change the sandbox mode in Settings > Sandbox if this is intended. Path: ${abs}`,
  };
}

// ── Shell command gating ─────────────────────────────────────────────────
//
// Full command parsing is L2's job (OS-level confinement). This is the
// best-effort L1 gate: extract path-LIKE tokens from the command text and
// verify each against the sandbox root. Unresolvable tokens are allowed
// through to the normal approval card — the user is the backstop, as with
// every shell command today.

const PATH_TOKEN_RE =
  /(?:[A-Za-z]:)?(?:[\\/][^\s"'`<>|;,&(){}[\]]+){1,}/g;

/** Paths inside the user's own tree that tools legitimately touch even when
 * sandboxed (none today — listed for future additions like temp dirs). */
const SHELL_ALLOW_OUTSIDE: string[] = [];

/**
 * Extract path-like tokens from a shell command and check them against the
 * sandbox. Flags commands that name absolute paths outside the project.
 * Returns ok:true when nothing resolvable is outside, or when the sandbox
 * is off. Write-shaped commands (cp/mv/rm/tee/…, output redirection) are
 * blocked on ANY outside path; read-only mode allows non-write-shaped
 * commands that merely name outside paths (the approval card is the gate
 * for reads).
 */
export async function checkShellSandbox(
  command: string,
): Promise<SandboxDecision> {
  const root = currentRoot;
  if (!root) return { ok: true };
  const mode = await loadSandboxMode(root);
  if (mode === "off") return { ok: true };

  const writeShaped =
    /\b(cp|mv|rm|rmdir|mkdir|tee|touch|truncate|shred|install|rsync|dd)\b/i.test(
      command,
    ) || /(?:^|\s)>{1,2}\s/.test(command);

  const matches = command.match(PATH_TOKEN_RE) ?? [];
  const outside: string[] = [];
  for (const raw of matches) {
    let t = raw.replace(/[\\/]+$/, "");
    if (!t || t.length < 2) continue;
    // Windows drive letters without a path (`D:`) and pure-option forms
    // like `/dev/null` style flags are not filesystem claims — skip
    // short/unresolvable shapes.
    if (/^[A-Za-z]:$/.test(t)) continue;
    if (t.startsWith("-")) continue;
    if (t.startsWith("~")) {
      // `~`-relative claims: home is never inside the project root, so a
      // ~ path is an outside claim unless it's a bare `~` prefix alone
      // (too vague to enforce) — treat bare `~` as unresolvable and skip.
      if (t === "~") continue;
    }
    if (isWithin(t, root)) continue;
    if (SHELL_ALLOW_OUTSIDE.some((p) => isWithin(t, p))) continue;
    outside.push(t);
  }
  if (outside.length === 0) return { ok: true };
  if (!writeShaped && mode === "readOnly") {
    // Reads outside are allowed in readOnly mode — shell commands may
    // legitimately inspect other locations; the approval card is the gate.
    return { ok: true };
  }
  const label = mode === "readOnly" ? "read-only" : "workspace-only";
  return {
    ok: false,
    reason: `Blocked by sandbox (${label}): the command names path(s) outside the project:\n  ${outside.slice(0, 5).join("\n  ")}\nRun it inside the project, or ask the user to change the sandbox mode in Settings > Sandbox.`,
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
