/**
 * Auto-verify at RUN END — the machine rule behind "verify every change",
 * without the per-write latency tax.
 *
 * Why run-end, not per-write: a per-write await stalls every tool result on a
 * full typecheck (tens of seconds in real repos), and fires on HALF-EDITED
 * states — removing a symbol in one file and adding its replacement in the
 * next makes the intermediate check fail, pressuring the model to "fix" a
 * state it was about to complete. One verify per run, when the model has
 * declared itself done, is the correct granularity: the guarantee ("never
 * finish with a broken build") is preserved, mid-refactor noise disappears,
 * and the cost is the theoretical minimum.
 *
 * Flow:
 *   1. Write tools call noteWrite() from the tool-fencing layer — a
 *      synchronous mark, adds nothing to the tool result's latency.
 *   2. AgentRunBridge, when a run settles to idle (or errors), calls
 *      verifyIfDirtyAtRunEnd().
 *   3. If the project is dirty: resolve the verify command, run it (capped).
 *      FAIL → inject a wake message into the session; the agent gets a new
 *      turn with the failure output and must fix it before finishing.
 *      PASS → clear the dirty mark silently.
 *
 * Command resolution, first match wins:
 *   1. package.json "verify" / "verify:changed" script
 *   2. any package.json script matching `tsc --noEmit`
 *   3. src-tauri/Cargo.toml present → cargo check
 *   4. nothing → no verification
 */

import { invoke } from "@tauri-apps/api/core";

/** Tools whose success marks the project dirty for end-of-run verification. */
export const WRITE_TOOLS = new Set([
  "edit",
  "multi_edit",
  "write_file",
  "batch_edit",
  "rename",
  "delete",
]);

const MAX_OUTPUT_CHARS = 1_600;
const VERIFY_TIMEOUT_S = 240;

/** Last write timestamp per workspace root — the "dirty" mark. */
const dirtyAt = new Map<string, number>();

/** In-flight verification per root — prevents concurrent duplicate runs. */
const inFlight = new Set<string>();

export function noteWrite(toolName: string, workspaceRoot: string | null): void {
  if (!workspaceRoot || !WRITE_TOOLS.has(toolName)) return;
  dirtyAt.set(workspaceRoot, Date.now());
}

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
  }
  if (await fileExists(`${root}/src-tauri/Cargo.toml`)) {
    return "cargo check";
  }
  return null;
}

/** Run the verify command in the project root. Returns null on pass. */
async function runVerify(root: string, command: string): Promise<string | null> {
  const { native } = await import("./native");
  try {
    const result = await native.runCommand(command, root, VERIFY_TIMEOUT_S);
    const stdout = String(result?.stdout ?? "");
    const stderr = String(result?.stderr ?? "");
    const exit = Number(result?.exit_code ?? 0);
    if (exit === 0 && !result?.timed_out) return null;

    const combined = `${stdout}${stderr ? (stdout ? "\n" : "") + stderr : ""}`;
    const lines = combined.split("\n").filter((l) => l.trim());
    // Prefer the actual error lines; fall back to the output tail.
    const errorLines = lines.filter((l) => /error|warning:/i.test(l));
    const tail = (errorLines.length > 0 ? errorLines : lines).slice(-6).join("\n");
    const clipped = tail.length > MAX_OUTPUT_CHARS
      ? `${tail.slice(0, MAX_OUTPUT_CHARS)} …[truncated]`
      : tail;
    return result?.timed_out
      ? `"${command}" TIMED OUT after ${VERIFY_TIMEOUT_S}s — last output:\n${clipped}`
      : `"${command}" FAILED (exit ${exit}):\n${clipped}`;
  } catch (e) {
    return `could not run "${command}" (${String(e).slice(0, 160)})`;
  }
}

/**
 * Run end-of-run verification when the project has unverified writes.
 * Called from AgentRunBridge when the run settles to idle.
 * On failure, injects a wake message into the session (the existing
 * watch-wake path — it queues when the agent is busy again, flushes later).
 */
export async function verifyIfDirtyAtRunEnd(
  sessionId: string,
  workspaceRoot: string | null,
  injectMessage: (sessionId: string, text: string) => Promise<void>,
): Promise<void> {
  if (!workspaceRoot) return;
  const lastWrite = dirtyAt.get(workspaceRoot);
  if (lastWrite === undefined) return; // clean run — nothing to verify
  if (inFlight.has(workspaceRoot)) return; // a verification is already running
  inFlight.add(workspaceRoot);
  try {
    const command = await resolveVerifyCommand(workspaceRoot);
    if (!command) {
      dirtyAt.delete(workspaceRoot); // nothing to verify with — don't re-check
      return;
    }
    const failure = await runVerify(workspaceRoot, command);
    if (failure === null) {
      dirtyAt.delete(workspaceRoot); // verified — run is done, clean
      return;
    }
    // Failure: keep the dirty mark (the wake run's writes re-mark it anyway)
    // and wake the agent with the exact failure output.
    await injectMessage(
      sessionId,
      `[verify] ${failure}\n\nFix these failures before finishing — the project does not currently pass "${command}".`,
    );
  } finally {
    inFlight.delete(workspaceRoot);
  }
}

/** Test hook — clear all dirty/in-flight state between cases. */
export function _resetVerifyState(): void {
  dirtyAt.clear();
  inFlight.clear();
}
