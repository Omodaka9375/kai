/**
 * Watch system — periodic shell command polling with condition DSL and
 * change detection. Inspired by Turnstone's watch.json tool.
 *
 * The agent creates a watch that runs a shell command on a timer. When
 * the condition fires (or when output changes, in change-detection mode),
 * the result is injected into the conversation as a system message so
 * the model can react to it.
 *
 * Use cases:
 * - CI/CD monitoring: ping a deployment until it returns 200
 * - Build watching: poll a build status file
 * - Process monitoring: watch for a process to exit or a log pattern
 * - Git polling: detect new commits in a watched repo
 *
 * ## Architecture
 * Watches live in a module-scoped registry. Each runs an interval that
 * calls `native.shellSessionRun` on the agent's shell session. On match
 * or change, the result is injected via chatStore.addMessage().
 *
 * All watches are reaped when the owning chat session is closed.
 */

import { native } from "../lib/native";
import { useChatStore } from "../store/chatStore";
import { tool, generateId } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import { checkShellCommand } from "../lib/security";

export type WatchMode = "fire_on_match" | "fire_on_change";

export interface WatchConfig {
  /** Unique handle assigned on creation. */
  id: string;
  /** Shell command to poll. */
  command: string;
  /** Polling interval in seconds (min 5, max 300). */
  intervalSecs: number;
  /**
   * JavaScript expression evaluated against the result object.
   * The expression has access to: exit_code, stdout, stderr, timed_out.
   * Must evaluate to boolean. E.g. "exit_code !== 0", "stdout.length > 0".
   */
  condition?: string;
  /** Mode: fire when condition matches, or when output changes from baseline. */
  mode: WatchMode;
  /** Human-readable label shown when the watch fires. */
  label?: string;
  /** Shell session ID used for execution. */
  shellId: number;
  /** Current CWD when the watch was created. */
  cwd: string | null;
  /** Owning chat session ID (reaped on close). */
  sessionId: string;
}

interface WatchState extends WatchConfig {
  /** Interval handle for cleanup. */
  interval: ReturnType<typeof setInterval>;
  /** Previous stdout/exit_code for change detection. */
  lastResult: string | null;
  /** How many times we've polled. */
  polls: number;
  /** Whether the watch has fired at least once (change detection needs baseline). */
  hasBaseline: boolean;
  /** Whether this watch is still active. */
  active: boolean;
}

// ── Registry ──────────────────────────────────────────────────────────────

const watches = new Map<string, WatchState>();

/** Create a watch and start polling. */
function startWatch(config: WatchConfig): WatchState {
  const state: WatchState = {
    ...config,
    interval: setInterval(() => poll(state), config.intervalSecs * 1000),
    lastResult: null,
    polls: 0,
    hasBaseline: false,
    active: true,
  };
  watches.set(config.id, state);
  return state;
}

/** Stop and remove a watch. */
function stopWatch(id: string): boolean {
  const w = watches.get(id);
  if (!w) return false;
  clearInterval(w.interval);
  w.active = false;
  watches.delete(id);
  return true;
}

/** Reap all watches owned by a session. */
export function reapSessionWatches(sessionId: string): void {
  for (const [id, w] of watches) {
    if (w.sessionId === sessionId) {
      clearInterval(w.interval);
      w.active = false;
      watches.delete(id);
    }
  }
}

/** Get all active watch IDs (for listing). */
export function listWatches(): WatchConfig[] {
  return Array.from(watches.values())
    .filter((w) => w.active)
    .map(({ interval: _, lastResult: _l, polls: _p, hasBaseline: _h, active: _a, ...cfg }) => cfg);
}

// ── Polling ────────────────────────────────────────────────────────────────

async function poll(w: WatchState): Promise<void> {
  if (!w.active) return;
  w.polls++;

  try {
    const result = await native.shellSessionRun(
      w.shellId,
      w.command,
      w.cwd,
      30, // 30s timeout per poll
    );

    const fingerprint = `${result.exit_code}:${result.stdout}:${result.stderr}`;

    if (w.mode === "fire_on_match") {
      if (evaluateCondition(w.condition, result)) {
        injectWatchResult(w, result);
        // Don't stop — the watch keeps running for subsequent matches.
      }
    } else {
      // Change detection mode.
      if (!w.hasBaseline) {
        // First poll — establish baseline, don't fire.
        w.lastResult = fingerprint;
        w.hasBaseline = true;
        return;
      }
      if (fingerprint !== w.lastResult) {
        w.lastResult = fingerprint;
        injectWatchResult(w, result);
      }
    }
  } catch {
    // Poll failed — log but don't kill the watch.
    console.debug(`[kai] watch ${w.id} poll failed (command: ${w.command})`);
  }
}

// ── Condition evaluation ──────────────────────────────────────────────────

function evaluateCondition(
  condition: string | undefined,
  result: { exit_code: number | null; stdout: string; stderr: string; timed_out: boolean },
): boolean {
  if (!condition) return true; // No condition = always fire.

  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(
      "exit_code",
      "stdout",
      "stderr",
      "timed_out",
      `return Boolean(${condition})`,
    );
    return fn(result.exit_code, result.stdout, result.stderr, result.timed_out);
  } catch {
    console.debug(`[kai] watch condition eval failed: ${condition}`);
    return false;
  }
}

// ── Result injection ──────────────────────────────────────────────────────

function injectWatchResult(
  w: WatchState,
  result: { exit_code: number | null; stdout: string; stderr: string; timed_out: boolean; cwd_after?: string },
): void {
  const label = w.label ?? w.command;
  const exitCode = result.exit_code ?? "?";
  const stdoutTrimmed = (result.stdout ?? "").slice(0, 2000);
  const stderrTrimmed = (result.stderr ?? "").slice(0, 500);

  let text = `**Watch fired**: \`${label}\` (exit: ${exitCode}, poll #${w.polls})\n\n`;
  if (stdoutTrimmed) {
    text += `\`\`\`\n${stdoutTrimmed}\n\`\`\`\n`;
  }
  if (stderrTrimmed) {
    text += `stderr:\n\`\`\`\n${stderrTrimmed}\n\`\`\``;
  }
  if (result.timed_out) {
    text += "\n\n⚠️ Command timed out.";
  }

  // Inject as a system message so the model sees it as new information.
  const sessionId = w.sessionId;
  useChatStore.getState().injectMessage(sessionId, text);
}

// ── Tool implementations ──────────────────────────────────────────────────

export function buildWatchTools(ctx: ToolContext) {
  return {
    watch_create: tool({
      description:
        "Create a periodic watch on a shell command. The command is polled every N seconds. When the condition matches (or output changes, in change-detection mode), the result is injected into the conversation as new information. Use for CI/CD monitoring, build status polling, process watching, and git change detection. Watches are automatically stopped when the session ends. Use watch_list to see active watches, watch_kill to stop one.",
      inputSchema: z.object({
        command: z.string().describe("Shell command to run periodically."),
        interval_secs: z.number().min(5).max(300).describe("Polling interval in seconds (5-300)."),
        condition: z.string().optional().describe(
          "JavaScript expression evaluated against { exit_code, stdout, stderr, timed_out }. Must be boolean. E.g. 'exit_code !== 0', 'stdout.includes(\"MERGED\")'. If omitted, fires on every poll.",
        ),
        mode: z.enum(["fire_on_match", "fire_on_change"]).optional().default("fire_on_match").describe(
          "fire_on_match: fire when condition is true. fire_on_change: fire when command output differs from the previous poll.",
        ),
        label: z.string().optional().describe("Human-readable label for notifications."),
      }),
      needsApproval: true,
      execute: async ({ command, interval_secs, condition, mode, label }, options) => {
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        if (options?.abortSignal?.aborted) return { error: "Cancelled." };

        const sessionId = ctx.getSessionId();
        if (!sessionId) return { error: "No active chat session." };

        const existing = listWatches();
        if (existing.length >= 5) {
          return { error: "Maximum 5 active watches per session." };
        }

        const shellId = await getOrCreateShell(ctx, sessionId);
        const id = `watch_${generateId().slice(0, 6)}`;

        const config: WatchConfig = {
          id,
          command,
          intervalSecs: Math.max(5, Math.min(300, interval_secs)),
          condition,
          mode,
          label,
          shellId,
          cwd: ctx.getCwd(),
          sessionId,
        };

        startWatch(config);

        return {
          ok: true,
          watch_id: id,
          command,
          interval_secs: config.intervalSecs,
          mode,
          condition: condition ?? "(always fire)",
        };
      },
    }),

    watch_list: tool({
      description: "List all active watches for this session.",
      inputSchema: z.object({}),
      execute: async () => {
        const all = listWatches();
        if (all.length === 0) return { watches: [], note: "No active watches." };
        return {
          watches: all.map((w) => ({
            id: w.id,
            command: w.command,
            interval_secs: w.intervalSecs,
            mode: w.mode,
            label: w.label,
          })),
        };
      },
    }),

    watch_kill: tool({
      description: "Stop and remove a watch by its ID.",
      inputSchema: z.object({
        watch_id: z.string().describe("Watch ID from watch_create or watch_list."),
      }),
      execute: async ({ watch_id }) => {
        const ok = stopWatch(watch_id);
        if (!ok) return { error: `Watch not found: ${watch_id}` };
        return { ok: true, watch_id };
      },
    }),
  } as const;
}

// ── Shell session reuse ───────────────────────────────────────────────────

const sessionShellIds = new Map<string, number>();

async function getOrCreateShell(ctx: ToolContext, sessionId: string): Promise<number> {
  const existing = sessionShellIds.get(sessionId);
  if (existing) return existing;
  const id = await native.shellSessionOpen(ctx.getCwd());
  sessionShellIds.set(sessionId, id);
  return id;
}

/** Close and release session shell (called on session close). */
export function closeWatchSessionShell(sessionId: string): void {
  const id = sessionShellIds.get(sessionId);
  if (id != null) {
    void native.shellSessionClose(id).catch(() => {});
    sessionShellIds.delete(sessionId);
  }
}