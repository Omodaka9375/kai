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

export type SandboxCache = { root: string; mode: SandboxMode } | null;

let cached: SandboxCache = null;

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

export const SANDBOX_LABELS: Record<SandboxMode, string> = {
  off: "Sandbox off",
  readOnly: "Sandbox: read-only (writes confined to project)",
  workspaceOnly: "Sandbox: workspace only (all IO confined to project)",
};
