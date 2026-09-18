/**
 * Shadow session (Layer 3) — frontend state + path translation.
 *
 * The agent's tools transparently resolve against the SHADOW copy while a
 * shadow session is active:
 *   - `toShadow(abs)`: project paths → shadow paths (identity otherwise)
 *   - `fromShadow(abs)`: inverse, for reporting real paths back to the user
 *
 * What is redirected (project-tree IO):
 *   - fs tools via ctx.getWorkspaceRoot()/getCwd() (they resolve paths
 *     against the returned root — see toShadowRoot)
 *   - shell commands (cwd param) — commands run with cwd inside the shadow
 *   - grep/glob/search roots
 *
 * What is NOT redirected:
 *   - the user's terminal tabs / file explorer (they see the real tree)
 *   - checkpoint storage, sessions, memory (~/.kai state, keyed by the REAL
 *     project root — state must survive merge/discard)
 *
 * The shadow root is stored per REAL project root so state survives reloads
 * and concurrent sessions on the same project agree.
 */

import type { ShadowInfo } from "./native";
import { native } from "./native";

const SEP_RE = /[\\/]/;

function norm(p: string): string {
  let s = p.replace(/\\/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** Active shadows keyed by real project root. */
const shadows = new Map<string, ShadowInfo>();

/** Reactive notifications for shadow mutations (create/merge/discard).
 *  The state is a module-resident map, not a store — UI surfaces
 *  (ShadowStrip, the session dropdown) subscribe and re-resolve. */
type ShadowListener = () => void;
const listeners = new Set<ShadowListener>();

/** Subscribe to shadow state changes. Returns the unsubscribe function. */
export function onShadowChange(fn: ShadowListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emitShadowChange(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      // A broken listener must not fail the mutation.
    }
  }
}

/** Load the active shadow for a project (idempotent; null when none). */
export async function loadShadow(
  projectRoot: string | null | undefined,
): Promise<ShadowInfo | null> {
  if (!projectRoot) return null;
  const key = norm(projectRoot);
  if (shadows.has(key)) return shadows.get(key) ?? null;
  try {
    const info = await native.shadowStatus(projectRoot);
    if (info) shadows.set(key, info);
    return info;
  } catch {
    return null;
  }
}

/** Create a shadow for a project; rejects when one is already active. */
export async function createShadow(
  projectRoot: string,
): Promise<ShadowInfo> {
  const info = await native.shadowCreate(projectRoot);
  shadows.set(norm(projectRoot), info);
  emitShadowChange();
  return info;
}

/** Get the resident shadow for a project (no IPC). */
export function getShadow(projectRoot: string | null | undefined): ShadowInfo | null {
  if (!projectRoot) return null;
  return shadows.get(norm(projectRoot)) ?? null;
}

/** True when `abs` is inside the real project tree (case-insensitive on win). */
function isWithin(abs: string, root: string): boolean {
  const a = norm(abs);
  const r = norm(root);
  const al = a.toLowerCase();
  const rl = r.toLowerCase();
  return al === rl || al.startsWith(`${rl}/`);
}

/**
 * Map a filesystem path into the shadow when a shadow session is active and
 * the path is inside the project. Everything else passes through unchanged.
 */
export function toShadow(abs: string): string {
  for (const [realRoot, info] of shadows) {
    if (isWithin(abs, realRoot)) {
      const rel = norm(abs).slice(norm(realRoot).length);
      return norm(info.shadowRoot) + rel;
    }
  }
  return abs;
}

/** Inverse of {@link toShadow} — shadow paths → real paths (for reporting). */
export function fromShadow(abs: string): string {
  for (const [realRoot, info] of shadows) {
    if (isWithin(abs, info.shadowRoot)) {
      const rel = norm(abs).slice(norm(info.shadowRoot).length);
      return norm(realRoot) + rel;
    }
  }
  return abs;
}

/**
 * Redirection wrapper for ToolContext: routes the tool-visible cwd and
 * workspace root into the shadow when active. Applies AFTER the underlying
 * live-context getters resolve.
 */
export function withShadowRedirect<T extends { getCwd(): string | null; getWorkspaceRoot(): string | null }>(base: T): T {
  return {
    ...base,
    getCwd(): string | null {
      const c = base.getCwd();
      return c == null ? null : toShadow(c);
    },
    getWorkspaceRoot(): string | null {
      const r = base.getWorkspaceRoot();
      return r == null ? null : toShadow(r);
    },
  };
}

/** Merge (dryRun) → returns the report; a real merge clears the shadow. */
export async function mergeShadow(
  projectRoot: string,
  dryRun: boolean,
): Promise<import("./native").ShadowMergeReport> {
  const report = await native.shadowMerge(projectRoot, dryRun);
  if (!dryRun) {
    shadows.delete(norm(projectRoot));
    emitShadowChange();
  }
  return report;
}

/** Discard the shadow copy entirely. */
export async function discardShadow(projectRoot: string): Promise<void> {
  await native.shadowDiscard(projectRoot);
  shadows.delete(norm(projectRoot));
  emitShadowChange();
}

export function shadowActiveFor(projectRoot: string | null | undefined): boolean {
  return getShadow(projectRoot) != null;
}

/** Format a merge report as a user-readable summary (chat-friendly). */
export function formatMergeReport(
  r: import("./native").ShadowMergeReport,
): string {
  const lines: string[] = [];
  if (r.copied.length) lines.push(`Applied ${r.copied.length} change(s).`);
  if (r.conflicts.length) {
    lines.push(`${r.conflicts.length} conflict(s) — files changed in BOTH the shadow and the real project were left untouched:`);
    for (const c of r.conflicts.slice(0, 10)) lines.push(`  - ${c}`);
    if (r.conflicts.length > 10) lines.push(`  … and ${r.conflicts.length - 10} more`);
  }
  if (r.deletedInShadow.length) {
    lines.push(`${r.deletedInShadow.length} file(s) deleted in the shadow remain in the project (listed, not auto-deleted):`);
    for (const d of r.deletedInShadow.slice(0, 10)) lines.push(`  - ${d}`);
    if (r.deletedInShadow.length > 10) lines.push(`  … and ${r.deletedInShadow.length - 10} more`);
  }
  return lines.join("\n") || "Nothing to merge — no changes in the shadow.";
}

export const _internal = { SEP_RE, isWithin };
