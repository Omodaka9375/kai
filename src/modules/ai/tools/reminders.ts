/**
 * Long-term reminder tools - persistent across restarts, passively
 * time-aware. Backed by lib/reminders.ts (see that file for the design:
 * store-is-truth, absolute instants, Rust-heartbeat tick, at-most-once
 * firing, three delivery surfaces).
 */

import { tool } from "ai";
import { z } from "zod";
import {
  createReminder,
  listReminders,
  cancelReminder,
  formatSpan,
  type Reminder,
} from "../lib/reminders";
import { type ToolContext } from "./context";

/** Compact human line for a reminder in list/creation output. */
function describeReminder(r: Reminder & { overdue?: true }, now = Date.now()): string {
  const dueMs = new Date(r.dueAt).getTime();
  const overdue = r.status === "pending" && dueMs <= now;
  const span = formatSpan(dueMs - now);
  const when = overdue ? `${span} overdue` : `in ${span}`;
  const parts = [
    `- [${r.status === "pending" ? (overdue ? "OVERDUE" : "pending") : "fired"}] ${r.message}`,
    `  due: ${r.dueLocal} (${r.dueAt}) - ${when}`,
  ];
  if (r.repeat) parts.push(`  repeats: ${r.repeat}`);
  parts.push(`  id: ${r.id}`);
  return parts.join("\n");
}

export function buildReminderTools(ctx: ToolContext) {
  return {
    reminder_create: tool({
      description:
        "Create a long-term reminder that fires at an absolute time - hours, days, weeks, or months from now. " +
        "Persistent: survives restarts (fires on next launch if overdue), works with the window closed, and " +
        "pings the owner's Telegram when the personal assistant is enabled. " +
        "RESOLVE THE DATE YOURSELF: dueAt must be an ABSOLUTE ISO-8601 timestamp with an explicit timezone offset " +
        '(e.g. "2026-11-02T09:00:00+01:00"). Compute the actual calendar date from your local_date env block first - ' +
        '"next Monday" means nothing to the scheduler. When the user says "remind me to pay bills by Monday", ' +
        "ask or infer the time of day (default to 09:00 local), resolve it to the concrete date+time, then create. " +
        "Use repeat for recurring obligations like bills (weekly/monthly). " +
        "LIMITATION: the reminder fires while the computer is on and KAI is running; if the machine is off at " +
        "due time it fires at next launch, marked overdue.",
      inputSchema: z.object({
        message: z
          .string()
          .describe("What to remind about - the user's words, verbatim when possible."),
        dueAt: z
          .string()
          .describe(
            "Absolute ISO-8601 timestamp WITH timezone offset, e.g. 2026-11-02T09:00:00+01:00. Never relative.",
          ),
        repeat: z
          .enum(["weekly", "monthly"])
          .optional()
          .describe("Recurrence: weekly or monthly. The due date rolls forward automatically after firing."),
      }),
      needsApproval: false,
      execute: async ({ message, dueAt, repeat }) => {
        const sessionId = ctx.getSessionId() ?? "";
        const result = await createReminder({
          message,
          dueAt,
          repeat: repeat ?? null,
          originSessionId: sessionId,
        });
        if ("error" in result) return result;
        return {
          ok: true,
          id: result.id,
          message: result.message,
          dueAt: result.dueAt,
          dueLocal: result.dueLocal,
          repeat: result.repeat,
          note:
            "The reminder is persistent - it fires by itself at the due time; you do not need to check on it. " +
            "Tell the user it is set.",
        };
      },
    }),
    reminder_list: tool({
      description:
        "List reminders: pending (with overdue flags) first, then fired history. Use this to check what " +
        "reminders exist before creating a similar one (avoid duplicates), or when the user asks what is scheduled.",
      inputSchema: z.object({}),
      needsApproval: false,
      execute: async () => {
        const all = await listReminders();
        const pending = all.filter((r) => r.status === "pending");
        if (all.length === 0) return { reminders: [], note: "No reminders exist." };
        return {
          count: all.length,
          pending: pending.length,
          reminders: all.map((r) => describeReminder(r)),
        };
      },
    }),
    reminder_cancel: tool({
      description:
        "Cancel (delete) a reminder by id - it will never fire. Get ids from reminder_list.",
      inputSchema: z.object({
        id: z.string().describe("Reminder id from reminder_list, e.g. rmd_a1b2c3."),
      }),
      needsApproval: false,
      execute: async ({ id }) => {
        const ok = await cancelReminder(id.trim());
        return ok
          ? { ok: true, id, note: "Reminder cancelled - it will not fire." }
          : { error: `No reminder with id "${id}" - use reminder_list to see current ids.` };
      },
    }),
  } as const;
}
