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
import { nativeForContext, sandboxOverrideForContext, type ToolContext } from "./context";
import {
  checkShellCommand,
  powerShellFileSurgeryHint,
} from "../lib/security";
import { IS_WINDOWS } from "@/lib/platform";
import { checkShellSandbox, sandboxExecRoot, type SandboxOverride } from "../lib/sandbox";

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
  /** ALSO ping the owner's Telegram when this watch fires (needs the
   *  personal assistant enabled + bound). */
  notifyTelegram?: boolean;
  /** Shell session ID used for execution. */
  shellId: number;
  /** Current CWD when the watch was created. */
  cwd: string | null;
  /** Owning chat session ID (reaped on close). */
  sessionId: string;
  /** Project-bound execution client, captured with the watch. */
  native?: ReturnType<typeof nativeForContext>;
  /** Sandbox confinement captured at CREATE time from the invoking context
   *  (see SandboxOverride in lib/sandbox.ts). pollWatch's `sandboxExecRoot`
   *  calls live outside buildWatchTools so ctx is not in scope there — the
   *  override rides on the watch. Undefined = use the global sandbox (desktop
   *  behavior). The Telegram assistant stamps its scratch-dir workspaceOnly
   *  override here so recurring polls stay inside ~/.kai/assistant even if
   *  the user's desktop sandbox changes between polls. */
  sandboxOverride?: SandboxOverride | null;
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
  /** Fingerprint of the last FIRED result (match-mode dedup): a condition
   *  that keeps matching on IDENTICAL output must fire once, not once per
   *  poll — each re-fire injected a fresh 2000-char chunk and woke a full
   *  agent turn ("chat scrolling duplicates like a replay" + context fill). */
  lastFired: string | null;
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
 *  watch creation also (lazily) starts the Rust heartbeat. Exported for tests. */
export async function startWatch(config: WatchConfig): Promise<WatchState> {
  const state: WatchState = {
    ...config,
    nextDue: Date.now(),
    inFlight: false,
    consecutiveFailures: 0,
    lastError: null,
    lastResult: null,
    lastFired: null,
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
  const client = [...watches.values()].find((w) => w.sessionId === sessionId)?.native ?? native;
  for (const [id, w] of watches) {
    if (w.sessionId === sessionId) {
      w.active = false;
      watches.delete(id);
    }
  }
  const shellId = sessionShellIds.get(sessionId);
  if (shellId != null) {
    sessionShellIds.delete(sessionId);
    void client.shellSessionClose(shellId).catch(() => {});
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

/** Count one poll failure and trip the breaker when exhausted. Shared by the
 *  outer catch and the shell-reopen retry paths so failure accounting is
 *  identical everywhere. */
function countPollFailure(w: WatchState, msg: string): void {
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
}

/** Classify a poll result and fire/record accordingly. Shared by the normal
 *  poll path and the catch-path shell-reopen retry. Also resets the breaker
 *  counters on any successful run (shell-level success, regardless of exit
 *  code — the condition decides firing, not the exit code). */
/** Exported for tests: the poll-result classifier/state machine. */
export function handlePollResult(
  w: WatchState,
  result: { exit_code: number | null; stdout: string; stderr: string; timed_out: boolean },
): void {
  const fingerprint = `${result.exit_code}:${result.stdout}:${result.stderr}`;

  if (w.mode === "fire_on_match") {
    const check = evaluateConditionChecked(w.condition, result);
    if (!check.ok) {
      // The condition expression itself is broken — the watch can never
      // fire. Count it like a poll failure so the circuit breaker stops
      // and self-reports it instead of polling silently forever.
      w.lastError = `Condition expression failed to evaluate: ${w.condition}${check.reason ? ` (${check.reason})` : ""}`;
      w.consecutiveFailures++;
      if (w.consecutiveFailures >= WATCH_MAX_CONSECUTIVE_FAILURES) {
        injectWatchFailure(w);
        stopWatch(w.id);
      } else {
        console.warn(
          `[kai] watch ${w.id} condition failed to evaluate (${w.consecutiveFailures}/${WATCH_MAX_CONSECUTIVE_FAILURES}, condition: ${w.condition}${check.reason ? `, reason: ${check.reason}` : ""})`,
        );
      }
      return;
    }
    w.consecutiveFailures = 0;
    w.lastError = null;
    if (check.value) {
      // Replay dedup: a condition that keeps matching on IDENTICAL output
      // fires ONCE, not once per poll. Each re-fire used to inject a fresh
      // 2000-char chunk + trigger a full agent turn — every interval, forever
      // — which scrolled the chat with duplicates and filled the context.
      // Changed output still fires (log growth, new status lines). A
      // non-matching poll CLEARS the dedup below so a flapping state
      // (down → up → down with the same text) re-fires on re-entry.
      const firedKey = firedResultKey(result);
      if (w.lastFired !== firedKey) {
        w.lastFired = firedKey;
        injectWatchResult(w, result);
      }
      // Don't stop — the watch keeps running for subsequent (new) matches.
    } else {
      w.lastFired = null;
    }
  } else {
    // Change detection mode (no condition to evaluate).
    w.consecutiveFailures = 0;
    w.lastError = null;
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
}

async function poll(w: WatchState): Promise<void> {
  if (!w.active || w.inFlight) return;
  w.inFlight = true;
  w.polls++;
  try {
    const client = w.native ?? native;
    let result = await client.shellSessionRun(
      w.shellId,
      w.command,
      w.cwd,
      pollTimeoutSecsFor(w.intervalSecs),
      await sandboxExecRoot(w.sandboxOverride),
    );

    // Self-heal: the cached shell session can die while the chat session
    // stays alive (shell subsystem restart, PTY reap). One failure then
    // re-opens a fresh shell and retries the SAME poll once before any
    // breaker counting — instead of failing for 10 intervals and tripping
    // the breaker on something a fresh shell fixes.
    if (result.exit_code === null && !result.timed_out && isDeadShellError(result.stderr)) {
      const fresh = await reopenShell(w.sessionId);
      if (fresh != null) {
        w.shellId = fresh;
        try {
          result = await client.shellSessionRun(
            w.shellId,
            w.command,
            w.cwd,
            pollTimeoutSecsFor(w.intervalSecs),
            await sandboxExecRoot(w.sandboxOverride),
          );
        } catch (retryErr) {
          // Retry also failed — count it like any other poll failure (do NOT
          // run handlePollResult on the dead result: a condition like
          // `exit_code !== 0` would match null and report a bogus firing).
          countPollFailure(
            w,
            retryErr instanceof Error ? retryErr.message : String(retryErr),
          );
          return;
        }
      }
    }
    handlePollResult(w, result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Self-heal FIRST: a thrown "session not found / closed / exited" error
    // usually means the cached shell id went stale, not that the watch is
    // beyond saving. Re-open once and retry the same poll; only count a
    // breaker failure when the retry also fails.
    if (isDeadShellError(msg)) {
      const fresh = await reopenShell(w.sessionId);
      if (fresh != null) {
        w.shellId = fresh;
        try {
          const result = await (w.native ?? native).shellSessionRun(
            w.shellId,
            w.command,
            w.cwd,
            pollTimeoutSecsFor(w.intervalSecs),
            await sandboxExecRoot(w.sandboxOverride),
          );
          // Retry succeeded — treat this poll as clean (reset counters,
          // run the normal match/change logic once, no breaker count).
          w.consecutiveFailures = 0;
          w.lastError = null;
          handlePollResult(w, result);
          return;
        } catch (retryErr) {
          // Retry also failed — count it like any other poll failure.
          countPollFailure(
            w,
            retryErr instanceof Error ? retryErr.message : String(retryErr),
          );
          return;
        }
      }
    }
    countPollFailure(w, msg);
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
  return evaluateConditionChecked(condition, result).value;
}

/** Fingerprint of exactly what a firing would INJECT (trimmed stdout/stderr
 *  + exit code + timed-out): the conversation receives this content, so a
 *  change beyond the trim is invisible to the model and counts as a
 *  duplicate. Must mirror injectWatchResult's trim bounds. */
function firedResultKey(result: {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}): string {
  return [
    result.exit_code,
    result.timed_out ? 1 : 0,
    stripClixml(result.stdout ?? "").slice(0, 2000),
    stripClixml(result.stderr ?? "").slice(0, 500),
  ].join(":");
}

/**
 * Evaluate the condition and REPORT whether the expression itself is broken.
 * A typo'd condition (`resuls.exit_code`) used to throw, log a debug line,
 * and return false forever — the watch polled forever, never fired, and
 * never self-reported ("never fired and nobody knew"). The caller feeds
 * `ok: false` into the same circuit breaker that catches dead shells.
 *
 * Eval-free BY DESIGN: the packaged app's CSP (`script-src 'self'
 * 'wasm-unsafe-eval'`) has no 'unsafe-eval', so `new Function` throws
 * EvalError on EVERY poll — every conditional watch auto-stopped after 10
 * polls with a misleading "failed to evaluate" (tests passed because vitest
 * runs in Node, which has no CSP). This parser understands the documented
 * DSL — identifiers (exit_code/stdout/stderr/timed_out), numeric and quoted
 * literals, `.includes()` / `.length`, comparison operators, && || ! and
 * parentheses — which is everything the tool description advertises.
 * Anything outside the DSL reports ok:false with a parser reason, keeping
 * the typo'd-identifier trap detection intact.
 */
export function evaluateConditionChecked(
  condition: string | undefined,
  result: { exit_code: number | null; stdout: string; stderr: string; timed_out: boolean },
): { ok: boolean; value: boolean; reason?: string } {
  if (!condition) return { ok: true, value: true }; // No condition = always fire.

  const parser = new ConditionParser(condition);
  let ast: ConditionNode;
  try {
    ast = parser.parseOr();
    const leftover = parser.peek();
    if (leftover !== "") {
      return { ok: false, value: false, reason: `unexpected token after expression: ${leftover}` };
    }
  } catch (e) {
    return {
      ok: false,
      value: false,
      reason: e instanceof Error ? e.message : "parse error",
    };
  }
  try {
    return { ok: true, value: evalNode(ast, result) };
  } catch (e) {
    return {
      ok: false,
      value: false,
      reason: e instanceof Error ? e.message : "evaluation error",
    };
  }
}

// ── Tiny expression DSL (no eval; CSP-safe) ───────────────────────────────

type ConditionNode =
  | { kind: "const"; value: boolean }
  | { kind: "field"; name: string }
  | { kind: "not"; node: ConditionNode }
  | { kind: "and"; left: ConditionNode; right: ConditionNode }
  | { kind: "or"; left: ConditionNode; right: ConditionNode }
  | { kind: "cmp"; op: string; left: ConditionNode; right: ConditionNode }
  | { kind: "includes"; node: ConditionNode; needle: string }
  | { kind: "length"; node: ConditionNode };

const FIELD_TYPES: Record<string, "number" | "string" | "boolean"> = {
  exit_code: "number",
  stdout: "string",
  stderr: "string",
  timed_out: "boolean",
};

class ConditionParser {
  private i = 0;
  constructor(private src: string) {}

  peek(): string {
    this.skipWs();
    return this.src.slice(this.i);
  }
  private skipWs(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
  }
  private eatWord(): string {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.i));
    if (!m) return "";
    this.i += m[0].length;
    return m[0];
  }
  private eat(expected: string): boolean {
    this.skipWs();
    if (this.src.startsWith(expected, this.i)) {
      this.i += expected.length;
      return true;
    }
    return false;
  }

  parseOr(): ConditionNode {
    let left = this.parseAnd();
    while (this.eat("||")) left = { kind: "or", left, right: this.parseAnd() };
    return left;
  }
  private parseAnd(): ConditionNode {
    let left = this.parseUnary();
    while (this.eat("&&")) left = { kind: "and", left, right: this.parseUnary() };
    return left;
  }
  private parseUnary(): ConditionNode {
    if (this.eat("!")) return { kind: "not", node: this.parseUnary() };
    return this.parseComparison();
  }
  private parseComparison(): ConditionNode {
    const left = this.parsePrimary();
    this.skipWs();
    for (const op of ["!==", "===", "!=", "==", ">=", "<=", ">", "<"]) {
      if (this.src.startsWith(op, this.i)) {
        this.i += op.length;
        return { kind: "cmp", op, left, right: this.parsePrimary() };
      }
    }
    return left;
  }
  private parsePrimary(): ConditionNode {
    this.skipWs();
    // Parenthesized sub-expression — full expression grammar inside
    // (supports `((stdout || ""))` coalescing feeding `.includes`).
    if (this.eat("(")) {
      const node = this.parseOr();
      if (!this.eat(")")) throw new Error("missing ) in condition");
      return this.parseSuffixes(node);
    }
    const rest = this.src.slice(this.i);
    // Quoted string literal (single or double quotes).
    const str = /^"((?:[^"\\]|\\.)*)"|^'((?:[^'\\]|\\.)*)'/.exec(rest);
    if (str) {
      this.i += str[0].length;
      const raw = str[1] ?? str[2] ?? "";
      return { kind: "field", name: `"${raw.replace(/\\"/g, '"').replace(/\\'/g, "'")}"` };
    }
    // Numeric literal (including negative).
    const num = /^-?\d+(\.\d+)?/.exec(rest);
    if (num) {
      this.i += num[0].length;
      return { kind: "field", name: `#${num[0]}` };
    }
    // Identifier: field, `true`/`false`, or field.method(...)
    const word = this.eatWord();
    if (!word) throw new Error(`unexpected token: ${rest.slice(0, 12) || "end of expression"}`);
    if (word === "true") return { kind: "const", value: true };
    if (word === "false") return { kind: "const", value: false };
    if (!(word in FIELD_TYPES)) throw new Error(`unknown identifier: ${word}`);
    return this.parseSuffixes({ kind: "field", name: word });
  }
  /** Method suffixes: `.includes("...")` and `.length`, chained. */
  private parseSuffixes(node: ConditionNode): ConditionNode {
    for (;;) {
      if (this.eat(".includes(")) {
        const arg = this.parseStringLiteral();
        this.skipWs();
        if (!this.eat(")")) throw new Error("missing ) after .includes(...)");
        node = { kind: "includes", node, needle: arg };
        continue;
      }
      if (this.eat(".length")) {
        node = { kind: "length", node };
        continue;
      }
      break;
    }
    return node;
  }
  private parseStringLiteral(): string {
    this.skipWs();
    const rest = this.src.slice(this.i);
    const str = /^"((?:[^"\\]|\\.)*)"|^'((?:[^'\\]|\\.)*)'/.exec(rest);
    if (!str) throw new Error(".includes needs a quoted string argument");
    this.i += str[0].length;
    const raw = str[1] ?? str[2] ?? "";
    return raw.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }
}

/**
 * Value-preserving evaluation (JS semantics): `a && b` / `a || b` return the
 * VALUE of an operand, not just a boolean — `(stdout || "")` coalesces to the
 * stdout string (or "" when stdout is falsy), which `.includes` then uses.
 * Null (exit_code of a killed process) propagates only into explicit
 * comparisons, where it throws — same as `new Function` would have.
 */
function valueOf(
  node: ConditionNode,
  result: { exit_code: number | null; stdout: string; stderr: string; timed_out: boolean },
): string | number | boolean | null {
  switch (node.kind) {
    case "const":
      return node.value;
    case "field": {
      if (node.name.startsWith('"')) return node.name.slice(1, -1);
      if (node.name.startsWith("#")) return Number(node.name.slice(1));
      switch (node.name) {
        case "exit_code": return result.exit_code;
        case "stdout": return result.stdout;
        case "stderr": return result.stderr;
        case "timed_out": return result.timed_out;
        default: return null;
      }
    }
    case "not":
      return !valueOf(node.node, result);
    case "and": {
      const l = valueOf(node.left, result);
      return l ? valueOf(node.right, result) : l;
    }
    case "or": {
      const l = valueOf(node.left, result);
      return l ? l : valueOf(node.right, result);
    }
    case "includes": {
      const v = valueOf(node.node, result);
      if (typeof v !== "string") throw new Error(".includes is only valid on strings");
      return v.includes(node.needle);
    }
    case "length": {
      const v = valueOf(node.node, result);
      if (typeof v !== "string") throw new Error(".length is only valid on strings");
      return v.length;
    }
    case "cmp": {
      const l = valueOf(node.left, result);
      const r = valueOf(node.right, result);
      if (l === null || r === null) throw new Error("cannot compare null (killed process has no exit_code)");
      switch (node.op) {
        case "==":
        case "===":
          return l === r;
        case "!=":
        case "!==":
          return l !== r;
        case ">": return (l as number) > (r as number);
        case "<": return (l as number) < (r as number);
        case ">=": return (l as number) >= (r as number);
        case "<=": return (l as number) <= (r as number);
        default: throw new Error(`unsupported operator: ${node.op}`);
      }
    }
  }
}

function evalNode(
  node: ConditionNode,
  result: { exit_code: number | null; stdout: string; stderr: string; timed_out: boolean },
): boolean {
  return Boolean(valueOf(node, result));
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
  // Brevity directive riding along with the firing: watches that fire
  // repeatedly (CI/CD status polls) used to get a full narrated response
  // per firing — the model restated the whole history each time. One line
  // per firing is enough; the wake-up turn should evaluate and report the
  // DELTA, not replay the conversation.
  text += "\n\n(you created a watch for this — do not re-poll the command yourself, do not re-create watches, and keep your response to this firing brief: assess the result, act if needed, and end your turn)";

  // Inject as a system message so the model sees it as new information.
  // Mid-run fires are PASSIVE (see chatStore injectMessage): the message
  // rides the next request's history — no queued self-initiated wake to
  // hijack the user's conversation. Idle fires wake inline (injectMessage).
  const sessionId = w.sessionId;
  void useChatStore.getState().injectMessage(sessionId, text);

  // Optional Telegram ping: the same firing ALSO reaches the owner's phone
  // when the watch opted in. Fail-soft — no assistant → silent no-op.
  if (w.notifyTelegram) {
    void import("@/modules/assistant")
      .then(({ telegramPing }) =>
        telegramPing(
          `🔔 Watch fired: ${w.label ?? w.command}\n\n${stripClixml(result.stdout ?? "").slice(0, 3000)}`,
        ),
      )
      .catch(() => {
        /* assistant module not loadable — ignore */
      });
  }
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
}

// ── Tool implementations ──────────────────────────────────────────────────

export function buildWatchTools(ctx: ToolContext) {
  return {
    watch_create: tool({
      description:
        "Create a periodic watch on a shell command. The command is polled every N seconds. When the condition matches (or output changes, in change-detection mode), the result is injected into the conversation as new information. Use for CI/CD monitoring, build status polling, process watching, and git change detection. Watches are automatically stopped when the session ends. IMPORTANT: while the watch is active, DO NOT poll the same thing yourself with sleep loops or repeated manual runs — the watch fires by itself and your turn blocks; end your turn and wait for the injection. Use watch_list to see active watches, watch_kill to stop one.",
      inputSchema: z.object({
        command: z.string().describe("Shell command to run periodically."),
        interval_secs: z.number().min(5).max(300).describe("Polling interval in seconds (5-300)."),
        condition: z.string().optional().describe(
          "JavaScript expression evaluated against { exit_code, stdout, stderr, timed_out }. Must be boolean. E.g. 'exit_code !== 0', 'stdout.includes(\"MERGED\")'. If omitted, fires whenever the result differs from the last firing.",
        ),
        mode: z.enum(["fire_on_match", "fire_on_change"]).optional().default("fire_on_match").describe(
          "fire_on_match: fire when condition is true; a match on output identical to the last firing is suppressed (fires once per distinct result, not once per poll). fire_on_change: fire when command output differs from the previous poll.",
        ),
        label: z.string().optional().describe("Human-readable label for notifications."),
        notify_telegram: z.boolean().optional().describe(
          "ALSO send a Telegram ping to the user when this watch fires (requires the personal assistant to be enabled and bound). Use for long-running jobs the user walks away from.",
        ),
      }),
      needsApproval: true,
      execute: async ({ command, interval_secs, condition, mode, label, notify_telegram }, options) => {
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        // A watch runs its command repeatedly; a read-modify-write pipeline
        // would corrupt source files on every poll. Same guard as bash_run.
        const surgeryHint = IS_WINDOWS && ctx.workspaceEnv?.kind !== "wsl"
          ? powerShellFileSurgeryHint(command)
          : null;
        if (surgeryHint) return { error: surgeryHint };
        const sandbox = await checkShellSandbox(command, await sandboxOverrideForContext(ctx));
        if (!sandbox.ok) return { error: sandbox.reason };
        if (options?.abortSignal?.aborted) return { error: "Cancelled." };

        const sessionId = ctx.getSessionId();
        if (!sessionId) return { error: "No active chat session." };

        const existing = listWatches().filter((w) => w.sessionId === sessionId);
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
          notifyTelegram: notify_telegram === true,
          shellId,
          cwd: ctx.getCwd(),
          sessionId,
          sandboxOverride: await sandboxOverrideForContext(ctx),
          native: nativeForContext(ctx),
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
        const all = listWatches().filter((w) => w.sessionId === ctx.getSessionId());
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
        const sessionId = ctx.getSessionId();
        const owned = listWatches().some((w) => w.id === watch_id && w.sessionId === sessionId);
        const ok = owned && stopWatch(watch_id);
        if (!ok) return { error: `Watch not found: ${watch_id}` };
        return { ok: true, watch_id };
      },
    }),
  } as const;
}

// ── Shell session reuse + self-healing ────────────────────────────────────

const sessionShellIds = new Map<string, number>();

async function getOrCreateShell(ctx: ToolContext, sessionId: string): Promise<number> {
  const existing = sessionShellIds.get(sessionId);
  if (existing) return existing;
  const id = await nativeForContext(ctx).shellSessionOpen(ctx.getCwd());
  sessionShellIds.set(sessionId, id);
  return id;
}

/**
 * Open a replacement shell after the cached one died. A shell session can
 * vanish out from under a watch while the session itself stays open (shell
 * subsystem restart, PTY/SendTo reap, crash recovery). The watch would then
 * fail every poll for up to 10 intervals before the breaker declared it
 * dead — even though a fresh shell makes it work again. Self-heal instead:
 * on the first failure we drop the cache and re-open on the next poll.
 */
async function reopenShell(sessionId: string): Promise<number | null> {
  const old = sessionShellIds.get(sessionId);
  const client = [...watches.values()].find((w) => w.sessionId === sessionId)?.native ?? native;
  if (old != null) {
    // Best-effort close of the husk; ignore errors (it may already be gone).
    void client.shellSessionClose(old).catch(() => {});
    sessionShellIds.delete(sessionId);
  }
  try {
    const id = await client.shellSessionOpen(null);
    sessionShellIds.set(sessionId, id);
    return id;
  } catch (e) {
    console.warn(`[kai] watch shell reopen failed for session ${sessionId}:`, e);
    return null;
  }
}

/** Is this poll failure the kind a fresh shell can fix? */
function isDeadShellError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("no such session") ||
    m.includes("invalid session") ||
    m.includes("unknown session") ||
    m.includes("session not found") ||
    m.includes("not found") ||
    m.includes("dead") ||
    m.includes("closed") ||
    m.includes("process exited") ||
    m.includes("pty closed") ||
    m.includes("no process") ||
    m.includes("child process") ||
    m.includes("spawn") ||
    m.includes("pty") ||
    m.includes("shell")
  );
}

/** Close and release session shell (called on session close). */
export function closeWatchSessionShell(sessionId: string): void {
  const id = sessionShellIds.get(sessionId);
  if (id != null) {
    void native.shellSessionClose(id).catch(() => {});
    sessionShellIds.delete(sessionId);
  }
}