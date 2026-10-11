/**
 * Auto-verify hook — the machine rule behind "verify every change".
 *
 * After a write-batch tool (edit / multi_edit / write_file / batch_edit /
 * rename / delete) succeeds, KAI runs the project's verify command and
 * appends the outcome to the tool result. "Agent forgot to typecheck" stops
 * being possible: the result itself carries the check.
 *
 * Configuration, first match wins:
 *   1. package.json "verify" / "verify:changed" script
 *   2. package.json "scripts" matching `tsc --noEmit` (TypeScript projects)
 *   3. src-tauri/Cargo.toml present → cargo check (Rust projects)
 *   4. nothing → no verification (plain text folders etc.)
 *
 * Debounced per project and capped: one verify per 15s window per root,
 * output truncated, failures reported as warnings — never as tool errors
 * (the edit DID succeed; the check outcome is information for the model).
 */

import { invoke } from "@tauri-apps/api/core";

export type VerifyOutcome =
  | { ran: false; reason: string }
  | { ran: true; command: string; ok: boolean; summary: string };

/** Tools whose success triggers a verification pass. */
const WRITE_TOOLS = new Set([
  "edit",
  "multi_edit",
  "write_file",
  "batch_edit",
  "rename",
  "delete",
]);

const DEBOUNCE_MS = 15_000;
const MAX_OUTPUT_CHARS = 1200;

type CacheEntry = { at: number; command: string; ok: boolean; summary: string };
const recentByRoot = new Map<string, CacheEntry>();

type PkgJson = { verify?: string; scripts?: Record<string, string> } | null;

/** Read package.json at the root; tolerant of missing/malformed files. */
async function readPkgJson(root: string): Promise<PkgJson> {
  try {
    const r = await invoke<{ kind: string; content?: string }>("fs_read_file", {
      path: `${root}/package.json`,
    });
    if (r?.kind === "text" && r.content) {
      return JSON.parse(r.content) as PkgJson;
    }
  } catch {
    /* absent */
  }
  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await invoke("fs_stat", { path });
    return true;
  } catch {
    return false;
  }
}

/** Pick the verify command for a project root. `null` = no verification. */
export async function resolveVerifyCommand(root: string): Promise<string | null> {
  const pkg = await readPkgJson(root);
  if (pkg) {
    const explicit = pkg.verify ?? pkg.scripts?.["verify:changed"] ?? pkg.scripts?.verify;
    if (typeof explicit === "string" && explicit.trim()) return explicit;
    // TypeScript projects: any script that typechecks is the verify loop.
    const tscScript = Object.values(pkg.scripts ?? {}).find((s) =>
      /\btsc\b[^\n]*--noEmit/.test(s),
    );
    if (tscScript) return tscScript;
    // package.json with deps but no scripts at all — still run tsc if it's
    // installed; resolveVerifyCommand has no cheap way to know, so let the
    // run fail-soft below.
  }
  if (await fileExists(`${root}/src-tauri/Cargo.toml`)) {
    return "cargo check";
  }
  return null;
}

/** Run the verify command in the project root, capped and debounced. */
async function runVerify(root: string, command: string): Promise<CacheEntry> {
  const { native } = await import("./native");
  try {
    const result = await native.runCommand(command, root, 180);
    const stdout = String(result?.stdout ?? "");
    const stderr = String(result?.stderr ?? "");
    const exit = Number(result?.exit_code ?? 0);
    const timedOut = Boolean(result?.timed_out);
    const combined = `${stdout}${stderr ? (stdout ? "\n" : "") + stderr : ""}`;
    const tail = combined.slice(-MAX_OUTPUT_CHARS);
    const firstErr = combined.split("\n").find((l) => /error/i.test(l));
    const lastLine = tail.split("\n").filter(Boolean).slice(-1)[0] ?? "";
    const summary = timedOut
      ? `TIMED OUT (180s) — last: ${lastLine}`
      : exit === 0
        ? "passed"
        : `FAILED (exit ${exit}): ${firstErr ?? lastLine}`;
    return { at: Date.now(), command, ok: exit === 0 && !timedOut, summary };
  } catch (e) {
    return {
      at: Date.now(),
      command,
      ok: false,
      summary: `could not run (${String(e).slice(0, 120)})`,
    };
  }
}

/**
 * Called from the tool-fencing layer after a successful write tool. Returns
 * the outcome to append to the tool result, or null when nothing ran.
 */
export async function maybeVerifyAfterWrite(
  toolName: string,
  workspaceRoot: string | null,
): Promise<VerifyOutcome | null> {
  if (!WRITE_TOOLS.has(toolName)) return null;
  if (!workspaceRoot) return null;

  const recent = recentByRoot.get(workspaceRoot);
  if (recent && Date.now() - recent.at < DEBOUNCE_MS) {
    // Same window: report the cached outcome, don't re-run. If the cached
    // run PASSED, say nothing at all — repeating "passed" per edit is noise.
    if (recent.ok) return null;
    return {
      ran: true,
      command: recent.command,
      ok: false,
      summary: `${recent.summary} (cached — check again after your next change)`,
    };
  }

  const command = await resolveVerifyCommand(workspaceRoot);
  if (!command) return null;

  const result = await runVerify(workspaceRoot, command);
  recentByRoot.set(workspaceRoot, result);
  if (result.ok) return null; // passed — silence is the signal
  return {
    ran: true,
    command: result.command,
    ok: false,
    summary: result.summary,
  };
}

/** Test hook — clear the debounce cache between cases. */
export function _resetVerifyCache(): void {
  recentByRoot.clear();
}
