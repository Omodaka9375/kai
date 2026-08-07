/**
 * Agent Hooks System — lifecycle scripts that execute before/after tool calls.
 *
 * Hooks live in `.kai/hooks/` as shell scripts:
 *   - pre_tool.sh   — runs before every tool call, can block by exit code
 *   - post_tool.sh  — runs after every successful tool call
 *   - pre_write.sh  — runs before file writes (edit, write_file, batch_edit)
 *   - post_write.sh — runs after file writes
 *
 * Each script receives:
 *   - TOOL_NAME env var
 *   - TOOL_INPUT env var (JSON string of tool arguments)
 *   - TOOL_PATH env var (file path for file-related tools)
 *
 * pre_* scripts: exit code 0 = allow, non-zero = block
 * post_* scripts: exit code is ignored (fire-and-forget)
 */

import { invoke } from "@tauri-apps/api/core";
import { native } from "./native";

const HOOKS_DIR = ".kai/hooks";

/** Run a hook script from the .kai/hooks/ directory. */
async function runHook(
  workspaceRoot: string,
  scriptName: string,
  env: Record<string, string>,
): Promise<{ ok: boolean; output: string }> {
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const hookPath = `${root}/${HOOKS_DIR}/${scriptName}`;

  try {
    const r = await native.readFile(hookPath);
    if (r.kind !== "text") return { ok: true, output: "" };
  } catch {
    // Hook script doesn't exist — silently skip.
    return { ok: true, output: "" };
  }

  // Build env var exports as a shell prefix.
  const envExports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join("\n");

  try {
    // Use bash_run through the persistent shell session.
    // For hooks, we open a one-shot shell via invoke directly.
    const result = await invoke<{
      stdout: string;
      stderr: string;
      exit_code: number | null;
      timed_out: boolean;
    }>("shell_run_command", {
      command: `${envExports}\nbash "${hookPath}"`,
      cwd: root,
      timeoutSecs: 10,
    });
    return {
      ok: result.exit_code === 0,
      output: result.stdout + result.stderr,
    };
  } catch (e) {
    console.debug(`hook ${scriptName}: failed to run:`, e);
    return { ok: false, output: String(e) };
  }
}

export type HookEnv = {
  toolName: string;
  toolInput: unknown;
  toolPath?: string;
};

/**
 * Run the pre-tool hook. Returns { allowed: boolean, reason?: string }.
 */
export async function runPreToolHooks(
  workspaceRoot: string | null,
  env: HookEnv,
): Promise<{ allowed: boolean; reason?: string }> {
  if (!workspaceRoot) return { allowed: true };

  const hookEnv: Record<string, string> = {
    TOOL_NAME: env.toolName,
    TOOL_INPUT: JSON.stringify(env.toolInput),
    ...(env.toolPath ? { TOOL_PATH: env.toolPath } : {}),
  };

  const result = await runHook(workspaceRoot, "pre_tool.sh", hookEnv);
  if (!result.ok) {
    return { allowed: false, reason: result.output.trim() || "pre_tool.sh blocked this action" };
  }

  // Also run tool-specific pre-hook.
  const specificResult = await runHook(
    workspaceRoot,
    `pre_${env.toolName}.sh`,
    hookEnv,
  );
  if (!specificResult.ok) {
    return {
      allowed: false,
      reason: specificResult.output.trim() || `pre_${env.toolName}.sh blocked this action`,
    };
  }

  return { allowed: true };
}

/**
 * Run the post-tool hook (fire-and-forget).
 */
export async function runPostToolHooks(
  workspaceRoot: string | null,
  env: HookEnv & { result: unknown },
): Promise<void> {
  if (!workspaceRoot) return;

  const hookEnv: Record<string, string> = {
    TOOL_NAME: env.toolName,
    TOOL_INPUT: JSON.stringify(env.toolInput),
    TOOL_RESULT: JSON.stringify(env.result),
    ...(env.toolPath ? { TOOL_PATH: env.toolPath } : {}),
  };

  void runHook(workspaceRoot, "post_tool.sh", hookEnv);
  void runHook(workspaceRoot, `post_${env.toolName}.sh`, hookEnv);
}