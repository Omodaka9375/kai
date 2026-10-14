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
import { useChatStore, flushAllPendingWatchWakes } from "../store/chatStore";
import { tool, generateId } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import { checkShellCommand } from "../lib/security";
import { checkShellSandbox, sandboxExecRoot } from "../lib/sandbox";

// ── Heartbeat (Rust-driven scheduler tick) ─────────────────────────────────
//
// WHY NOT setInterval: WebView2 (Chromium) intensively throttles timers in
// hidden pages — after ~5 minutes in the background, timers wake at most
// once per minute. A 5s watch degraded to ~1 poll/min exactly when the user
// had KAI backgrounded ("watches often don't fire"). IPC event delivery is
// NOT subject to timer throttling, so the tick comes from a Rust thread via
// a Channel. The JS side is now a tick-driven scheduler: each watch owns a
// nextDue timestamp; on every tick, due watches poll. setInterval remains
// only as a fallback when the Rust heartbeat is unavailable (tests, plain
// web) so watches still work there — just throttled when hidden.

/** Fixed per-poll timeout, scaled to the interval so a slow command cannot
 *  strangle the schedule (5s interval → 5s timeout, not a fixed 30s that
 *  serializes one slow command across three tick periods). */
export function pollTimeoutSecsFor(intervalSecs: number): number {
  return Math.max(5, Math.min(30, intervalSecs));
}

/** A watch whose poll has failed N consecutive times is presumed dead (its
 *  shell session died with the app restart, the sandbox distro was removed,
 *  etc.). Rather than silently no-oping forever — the classic "watch never
 *  fired and nobody knew" — it self-reports ONE final injection with the
 *  last error, then stops itself. Circuit-breaker threshold. */
export const WATCH_MAX_CONSECUTIVE_FAILURES = 10;

let heartbeatStarted = false;

async function ensureHeartbeat(): Promise<void> {
  if (heartbeatStarted) return;
  heartbeatStarted = true;
  try {
    const { Channel } = await import("@tauri-apps/api/core");
    const channel = new Channel<void>();
    channel.onmessage = () => {
      schedulerTick();
    };
    await native.watchHeartbeat(channel);
  } catch {
    // Rust heartbeat unavailable (tests, plain web) — fall back to a local
    // 1s timer. Subject to background throttling, but strictly better than
    // no scheduling at all.
    setInterval(() => schedulerTick(), 1000);
  }
}

/** Advance the schedule: poll every watch whose nextDue has passed. Runs at
 *  most once per tick; a poll already in flight skips its turn (see poll). */
function schedulerTick(): void {
  const now = Date.now();
  for (const w of watches.values()) {
    if (!w.active) continue;
    if (w.inFlight) continue; // previous poll still running — skip this tick
    if (now < w.nextDue) continue;
    w.nextDue = now + w.intervalSecs * 1000;
    void poll(w);
  }
}

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
  /** Next timestamp (ms) at which the scheduler may poll. */
  nextDue: number;
  /** A poll is currently executing — skip ticks until it settles. */
  inFlight: boolean;
  /** Consecutive failed polls (reset on success) — drives the breaker. */
  consecutiveFailures: number;
  /** Last error text for the breaker's self-report. */
  lastError: string | null;
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

/** Create a watch and register it with the tick-driven scheduler. The first
 *  watch creation also (lazily) starts the Rust heartbeat. */
async function startWatch(config: WatchConfig): Promise<WatchState> {
  const state: WatchState = {
    ...config,
    nextDue: Date.now(),
    inFlight: false,
    consecutiveFailures: 0,
    lastError: null,
    lastResult: null,
    polls: 0,
    hasBaseline: false,
    active: true,
  };
  watches.set(config.id, state);
  await ensureHeartbeat();
  return state;
}

/** Stop and remove a watch. */
function stopWatch(id: string): boolean {
  const w = watches.get(id);
  if (!w) return false;
  w.active = false;
  watches.delete(id);
  return true;
}

/** Stop and remove a watch by id. Exported for tests + watch_kill. */
export function stopWatchById(id: string): boolean {
  return stopWatch(id);
}

/** Reap all watches owned by a session. */
export function reapSessionWatches(sessionId: string): void {
  for (const [id, w] of watches) {
    if (w.sessionId === sessionId) {
      w.active = false;
      watches.delete(id);
    }
  }
}

/** Get all active watch configs (for listing). */
export function listWatches(): WatchConfig[] {
  return Array.from(watches.values())
    .filter((w) => w.active)
    .map(({ nextDue: _nd, inFlight: _if, consecutiveFailures: _cf, lastError: _le, ...cfg }) => cfg);
}

/** Number of live watch timers (diagnostics). */
export function watchCount(): number {
  return watches.size;
}

// ── Polling ────────────────────────────────────────────────────────────────

async function poll(w: WatchState): Promise<void> {
  if (!w.active || w.inFlight) return;
  w.inFlight = true;
  w.polls++;
  try {
    const result = await native.shellSessionRun(
      w.shellId,
      w.command,
      w.cwd,
      pollTimeoutSecsFor(w.intervalSecs),
      await sandboxExecRoot(),
    );
    w.consecutiveFailures = 0;
    w.lastError = null;

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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    w.lastError = msg;
    w.consecutiveFailures++;
    // Circuit breaker: N consecutive failures means the watch is dead (shell
    // session gone, sandbox distro removed, ...). Self-report ONCE into the
    // chat so the model (and user) see why it stopped, then stop the watch —
    // previously this looped silently forever.
    if (w.consecutiveFailures >= WATCH_MAX_CONSECUTIVE_FAILURES) {
      injectWatchFailure(w);
      stopWatch(w.id);
    } else {
      console.warn(
        `[kai] watch ${w.id} poll failed (${w.consecutiveFailures}/${WATCH_MAX_CONSECUTIVE_FAILURES}, command: ${w.command}):`,
        msg,
      );
    }
  } finally {
    w.inFlight = false;
  }
}

// ── Condition evaluation ──────────────────────────────────────────────────

/** Evaluate the condition expression against a poll result. Pure, exported for tests. */
export function evaluateCondition(
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

// PowerShell serializes native-command stderr into CLIXML when the console
// host detects a redirected stream: `#< CLIXML` + `<Objs …><S S="Error">…</S>`.
// The text inside <S> uses `_xHHHH_` hex escapes (`_x001B_` = ESC,
// `_x000D__x000A_` = CRLF) plus XML entities. Decode it back into readable
// lines so a watch on a failing command shows the actual error, not an XML blob.
const CLIXML_ESCAPE_RE = /_x([0-9a-fA-F]{4})_/g;
const XML_ENTITY_RE = /&(lt|gt|amp|quot|apos);/g;
const ANSI_CSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function decodeClixmlEscapes(s: string): string {
  return s.replace(CLIXML_ESCAPE_RE, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

function decodeXmlEntities(s: string): string {
  const map: Record<string, string> = {
    lt: "<",
    gt: ">",
    amp: "&",
    quot: '"',
    apos: "'",
  };
  return s.replace(XML_ENTITY_RE, (_m, name: string) => map[name] ?? _m);
}

/**
 * If `text` is PowerShell CLIXML, extract the human-readable content of each
 * `<S>` element (decoded + ANSI-stripped). Returns `text` unchanged when the
 * input isn't CLIXML or no `<S>` elements were found.
 */
function stripClixml(text: string): string {
  if (!text.includes("CLIXML")) return text;
  const parts: string[] = [];
  const re = /<S\b[^>]*>([\s\S]*?)<\/S>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const decoded = decodeXmlEntities(decodeClixmlEscapes(m[1]));
    const clean = decoded
      .replace(ANSI_CSI_RE, "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
      .trim();
    if (clean) parts.push(clean);
  }
  if (parts.length === 0) return text;
  return parts.join("\n");
}

function injectWatchResult(
  w: WatchState,
  result: { exit_code: number | null; stdout: string; stderr: string; timed_out: boolean; cwd_after?: string },
): void {
  const label = w.label ?? w.command;
  const exitCode = result.exit_code ?? "?";
  const stdoutTrimmed = stripClixml(result.stdout ?? "").slice(0, 2000);
  const stderrTrimmed = stripClixml(result.stderr ?? "").slice(0, 500);

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
  void useChatStore.getState().injectMessage(sessionId, text);
  // The injection may have queued a wake for a NON-active session (the
  // bridge only flushes for the session it's mounted against) — flush all
  // queued wakes so the background session reacts too.
  flushAllPendingWatchWakes();
}

/** Terminal self-report for a dead watch (circuit breaker). Tells the model
 *  the watch is gone and why, so it can re-create it or tell the user. */
function injectWatchFailure(w: WatchState): void {
  const label = w.label ?? w.command;
  const text =
    `**Watch stopped**: \`${label}\` (id: ${w.id}) — its command failed ${w.consecutiveFailures} polls in a row ` +
    `and the watch was auto-stopped. Last error:\n\`\`\`\n${(w.lastError ?? "unknown").slice(0, 500)}\n\`\`\`\n` +
    `If this task still needs monitoring, create a new watch with watch_create.`;
  void useChatStore.getState().injectMessage(w.sessionId, text);
  flushAllPendingWatchWakes();
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
        const sandbox = await checkShellSandbox(command);
        if (!sandbox.ok) return { error: sandbox.reason };
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

        await startWatch(config);

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