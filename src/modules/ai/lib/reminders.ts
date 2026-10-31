/**
 * Long-term reminders - persistent, restart-safe, passively time-aware.
 *
 * USER CONTRACT: "remind me to pay bills by Monday" must work whether said
 * to a project agent or the Telegram assistant, survive restarts, and never
 * depend on a timer counting seconds. Design (2026-10-31):
 *
 *  - STORAGE IS TRUTH: reminders live in `~/.kai/reminders.json` via
 *    tauri-plugin-store (same file class as kai-assistant.json). The
 *    scheduler holds NO state that matters - it is a stateless pass over
 *    the store. A restart loses nothing; a machine that was OFF all weekend
 *    doesn't "miss" the deadline, it fires at next boot, overdue-annotated.
 *
 *  - ABSOLUTE INSTANTS: `dueAt` is an ISO-8601 timestamp resolved by the
 *    MODEL at creation ("Monday" -> the actual date, from its local_date
 *    env). The scheduler only ever compares `dueAt <= Date.now()` - epoch
 *    math, immune to sleeps, restarts, and wall-clock drift while off.
 *    `dueLocal` (naive wall-clock) is stored beside it so a DST flip
 *    re-resolves to the same LOCAL time on load.
 *
 *  - PASSIVE TICK: the scheduler subscribes its own channel to the Rust
 *    heartbeat (1s native tick, immune to WebView2 hidden-page throttling -
 *    same mechanism watches use). Each tick is a cheap compare. There is
 *    also a BOOT CATCH-UP pass so an overdue reminder fires the moment KAI
 *    launches, not a second later.
 *
 *  - AT-MOST-ONCE FIRING: status flips to "fired" (or the recurrence
 *    rolls forward) and PERSISTS FIRST; only then do the notification and
 *    assistant injection run. A crash mid-fire cannot double-fire.
 *
 *  - DELIVERY: (1) OS notification - visible with the window closed to
 *    tray; (2) injectMessage into the ORIGIN session (idle wakes the agent
 *    inline, busy rides along - the watch contract); (3) if the Telegram
 *    bot is enabled, telegramPing carries it to the owner's phone.
 *
 * LIMITATION (stated in the tool description): KAI is a running app, not
 * an OS service. If the machine is powered off (or KAI fully quit) at due
 * time, the reminder fires at next launch. Close-to-tray + autostart keep
 * the process alive, shrinking that window to "the computer was off".
 */

import { LazyStore } from "@tauri-apps/plugin-store";
import { useChatStore } from "../store/chatStore";

// ── Store ──────────────────────────────────────────────────────────────

const REMINDERS_STORE = "kai-reminders.json";
const KEY_REMINDERS = "reminders";

const store = new LazyStore(REMINDERS_STORE, { defaults: {}, autoSave: 200 });

export type ReminderRepeat = "weekly" | "monthly";

export type Reminder = {
  id: string;
  /** What to remind about - the user's words, ideally verbatim. */
  message: string;
  /** ISO-8601 ABSOLUTE instant (timezone-explicit). The scheduler only
   *  compares this against Date.now(). */
  dueAt: string;
  /** Naive local wall-clock ("2026-11-02 09:00") for DST re-resolution. */
  dueLocal: string;
  /** Recurrence: roll the due date forward instead of completing. */
  repeat: ReminderRepeat | null;
  /** pending | fired (one-shot done) - recurring reminders stay pending. */
  status: "pending" | "fired";
  createdAt: string;
  /** Session that created it - delivery target for the injection. */
  originSessionId: string;
  firedAt: string | null;
};

type ReminderFile = { reminders: Reminder[] };

/** In-memory cache; the store is the durable copy. Boot catch-up and the
 *  tools both go through this, so reads are sync after the first load. */
let cache: Reminder[] | null = null;
let loading: Promise<void> | null = null;

export async function loadReminders(): Promise<Reminder[]> {
  if (cache) return cache;
  loading ??= (async () => {
    const file = (await store.get<ReminderFile>(KEY_REMINDERS)) ?? { reminders: [] };
    cache = Array.isArray(file.reminders) ? file.reminders : [];
  })();
  await loading;
  return cache!;
}

async function persist(): Promise<void> {
  if (!cache) return;
  await store.set(KEY_REMINDERS, { reminders: cache } satisfies ReminderFile);
}

// ── Time helpers ───────────────────────────────────────────────────────

/** Format a Date as a naive local wall-clock string (DST re-resolution). */
export function formatDueLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Human-readable overdue/until span ("2d 3h overdue", "in 5h"). */
export function formatSpan(ms: number): string {
  const abs = Math.abs(ms);
  const mins = Math.floor(abs / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${Math.max(mins, 1)}m`;
}

/** Validate + normalize a dueAt the model supplied. Returns null if the
 *  string cannot be parsed as an absolute instant (the caller errors and
 *  the model re-derives it - relative dates must be resolved by the model). */
export function parseDueAt(raw: string): Date | null {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  // Reject non-explicit forms that JS happens to parse but the tool
  // contract forbids ("Monday" is NOT accepted here - the model resolves
  // it; a bare month-day like "11/02" is timezone-ambiguous).
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw.trim())) return null;
  return d;
}

/** Roll a due date forward for recurring reminders. Monthly clamps to the
 *  target month's last day (Jan 31 -> Feb 28/29). */
export function nextOccurrence(due: Date, repeat: ReminderRepeat): Date {
  const next = new Date(due.getTime());
  if (repeat === "weekly") {
    next.setDate(next.getDate() + 7);
  } else {
    const day = next.getDate();
    next.setDate(1);
    next.setMonth(next.getMonth() + 1);
    // Clamp to the last day of the new month.
    const last = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, last));
  }
  return next;
}

// ── Create / list / cancel ──────────────────────────────────────────────

function newId(): string {
  return `rmd_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

export async function createReminder(input: {
  message: string;
  dueAt: string;
  repeat?: ReminderRepeat | null;
  originSessionId: string;
}): Promise<Reminder | { error: string }> {
  const message = input.message.trim();
  if (!message) return { error: "empty message - nothing to remind about" };
  const due = parseDueAt(input.dueAt);
  if (!due) {
    return {
      error:
        `dueAt must be an absolute ISO-8601 timestamp (e.g. "2026-11-02T09:00:00+01:00"). ` +
        `Resolve relative dates yourself first: use your local_date env (today) to compute ` +
        `the actual calendar date, then pass it with an explicit time and timezone offset.`,
    };
  }
  await loadReminders();
  const r: Reminder = {
    id: newId(),
    message,
    dueAt: due.toISOString(),
    dueLocal: formatDueLocal(due),
    repeat: input.repeat ?? null,
    status: "pending",
    createdAt: new Date().toISOString(),
    originSessionId: input.originSessionId,
    firedAt: null,
  };
  cache!.push(r);
  await persist();
  return r;
}

export async function listReminders(): Promise<Reminder[]> {
  const all = await loadReminders();
  const now = Date.now();
  return [...all].sort((a, b) => {
    // Pending first by due order; fired after, newest first.
    const pa = a.status === "pending" ? 0 : 1;
    const pb = b.status === "pending" ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const da = new Date(a.dueAt).getTime();
    const db = new Date(b.dueAt).getTime();
    return pa === 0 ? da - db : db - da;
  }).map((r) => ({ ...r, ...(r.status === "pending" && new Date(r.dueAt).getTime() <= now ? { overdue: true } as const : {}) }));
}

export async function cancelReminder(id: string): Promise<boolean> {
  await loadReminders();
  const before = cache!.length;
  cache! = cache!.filter((r) => r.id !== id);
  if (cache!.length === before) return false;
  await persist();
  return true;
}

// ── Scheduler ──────────────────────────────────────────────────────────

let schedulerStarted = false;
let fireInFlight = false;

/** Fire one due reminder. Mark-first (at-most-once), then deliver on three
 *  surfaces. Exported for tests. */
export async function fireReminder(r: Reminder, now = new Date()): Promise<void> {
  const dueMs = new Date(r.dueAt).getTime();
  const overdueBy = now.getTime() - dueMs;

  // AT-MOST-ONCE: flip status (or roll the recurrence) and persist BEFORE
  // any delivery. A crash here cannot double-fire.
  await loadReminders();
  const rec = cache!.find((x) => x.id === r.id);
  if (!rec || rec.status !== "pending") return; // cancelled meanwhile
  if (rec.repeat) {
    const next = nextOccurrence(new Date(rec.dueAt), rec.repeat);
    rec.dueAt = next.toISOString();
    rec.dueLocal = formatDueLocal(next);
    // status stays "pending"
  } else {
    rec.status = "fired";
    rec.firedAt = now.toISOString();
  }
  await persist();

  const overdueNote =
    overdueBy > 60_000 ? ` (overdue by ${formatSpan(overdueBy)})` : "";
  const dueLocalNote = rec.repeat
    ? `${rec.dueLocal} (next occurrence)`
    : r.dueLocal;

  // 1) OS notification - visible with the window closed to tray.
  try {
    const mod = await import("@tauri-apps/plugin-notification");
    if (await mod.isPermissionGranted()) {
      mod.sendNotification({
        title: "KAI reminder",
        body: r.message.slice(0, 180),
      });
    }
  } catch {
    /* notification unavailable (tests, plain web) - fail soft */
  }

  // 2) Inject into the origin session - idle wakes the agent inline, busy
  //    rides along (same contract as watch fires). The message tells the
  //    model what this is and what to do; if the session died the store
  //    still holds the reminder (marked fired) and the OS toast fired.
  const text =
    `<reminder due="${dueLocalNote}"${overdueNote} id="${r.id}">${r.message}</reminder>\n` +
    `(a reminder you or the user created just came due - tell the user about it now, ` +
    `briefly and in their language. If it is recurring it will fire again on its own; ` +
    `do not re-create it.)`;
  try {
    await useChatStore.getState().injectMessage(r.originSessionId, text);
  } catch {
    /* session gone - the OS notification + Telegram ping still fired */
  }

  // 3) Telegram ping - the phone path when the owner is away. Fail-soft.
  try {
    const { telegramPing } = await import("@/modules/assistant");
    await telegramPing(`⏰ Reminder${overdueNote}: ${r.message}`);
  } catch {
    /* assistant module unavailable - ignore */
  }
}

/** One scheduler pass: fire every pending reminder whose instant passed.
 *  Also the BOOT CATCH-UP entry point. */
export async function reminderTick(now = new Date()): Promise<number> {
  const all = await loadReminders();
  const due = all.filter(
    (r) => r.status === "pending" && new Date(r.dueAt).getTime() <= now.getTime(),
  );
  for (const r of due) {
    if (fireInFlight) break; // one delivery pipeline at a time
    fireInFlight = true;
    try {
      await fireReminder(r, now);
    } finally {
      fireInFlight = false;
    }
  }
  return due.length;
}

/** Start the passive scheduler: subscribe to the Rust 1s heartbeat (each
 *  subscriber gets its own tick channel - the heartbeat thread drops dead
 *  channels individually). Falls back to a 30s local timer when the
 *  heartbeat is unavailable (tests, plain web). Idempotent - call freely. */
export async function startReminderScheduler(): Promise<void> {
  if (schedulerStarted) return;
  schedulerStarted = true;
  // Boot catch-up: fire everything already overdue the moment we load.
  void reminderTick().catch(() => {});
  try {
    const { Channel } = await import("@tauri-apps/api/core");
    const { native } = await import("./native");
    const channel = new Channel<void>();
    channel.onmessage = () => {
      void reminderTick().catch(() => {});
    };
    await native.watchHeartbeat(channel);
  } catch {
    setInterval(() => {
      void reminderTick().catch(() => {});
    }, 30_000);
  }
}

/** Test seam: reset module state (cache + scheduler flag). */
export function resetRemindersForTests(): void {
  cache = null;
  loading = null;
  schedulerStarted = false;
  fireInFlight = false;
}
