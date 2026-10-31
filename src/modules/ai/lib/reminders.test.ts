import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Long-term reminder contract tests.
 *
 * Two layers:
 *  1. PURE time math (parseDueAt, nextOccurrence, formatSpan) - the
 *     restart-safety core: absolute instants only, monthly clamped,
 *     no timer anywhere.
 *  2. SCHEDULER behavior with a mocked store + delivery surfaces: boot
 *     catch-up, at-most-once firing (mark-first), recurrence roll,
 *     cancel-race safety.
 */

// Mocks before the module loads (Node has no Tauri).
const storeData = new Map<string, unknown>();
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    constructor() {}
    async get(key: string) {
      return storeData.get(key);
    }
    async set(key: string, value: unknown) {
      storeData.set(key, value);
    }
  },
}));
const injected: { sessionId: string; text: string }[] = [];
vi.mock("../store/chatStore", () => ({
  useChatStore: { getState: () => ({ injectMessage: async (id: string, text: string) => {
    injected.push({ sessionId: id, text });
  } }) },
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  sendNotification: vi.fn(),
}));
vi.mock("@/modules/assistant", () => ({
  telegramPing: vi.fn(async () => {}),
}));

import {
  parseDueAt,
  nextOccurrence,
  formatSpan,
  createReminder,
  listReminders,
  cancelReminder,
  fireReminder,
  reminderTick,
  resetRemindersForTests,
} from "./reminders";

const NOW = new Date("2026-10-31T12:00:00+01:00");

beforeEach(() => {
  storeData.clear();
  injected.length = 0;
  resetRemindersForTests();
});

describe("suite zone pin (runner must be Europe/Budapest)", () => {
  it("renders +01:00 wall clock as-is — fails loudly if vite.config.ts drops the TZ pin", () => {
    // dueLocal is the NAIVE LOCAL rendering of an instant. Tests below
    // assert wall-clock strings ("2026-11-02 09:00" for 09:00+01:00), so
    // the runner's zone must match the zone those expectations were
    // authored in. Without the vite.config.ts test.env.TZ pin, a UTC
    // runner (CI) renders that instant as 08:00 and every wall-clock
    // expectation drifts. Guard here = a clear failure message instead
    // of a cryptic "expected 09:00, received 08:00" one file away.
    const offset = new Date("2026-11-02T09:00:00+01:00").getTimezoneOffset();
    expect(offset).toBe(-60);
  });
});

describe("parseDueAt - absolute instants only (restart-safety contract)", () => {
  it("accepts explicit ISO-8601 with timezone offset", () => {
    expect(parseDueAt("2026-11-02T09:00:00+01:00")!.getTime())
      .toBe(new Date("2026-11-02T09:00:00+01:00").getTime());
  });

  it("accepts a space-separated local form with offset", () => {
    expect(parseDueAt("2026-11-02 09:00:00+01:00")).not.toBeNull();
  });

  it("REJECTS relative words - the model must resolve the date itself", () => {
    expect(parseDueAt("Monday")).toBeNull();
    expect(parseDueAt("next week")).toBeNull();
    expect(parseDueAt("in 2 days")).toBeNull();
  });

  it("REJECTS ambiguous month/day forms (timezone-ambiguous)", () => {
    expect(parseDueAt("11/02/2026")).toBeNull();
  });

  it("REJECTS unparseable strings", () => {
    expect(parseDueAt("not a date")).toBeNull();
  });
});

describe("nextOccurrence - recurrence math", () => {
  it("weekly adds 7 days, preserving the clock time", () => {
    const next = nextOccurrence(new Date("2026-11-02T09:00:00+01:00"), "weekly");
    expect(next.toISOString()).toBe(new Date("2026-11-09T09:00:00+01:00").toISOString());
  });

  it("monthly clamps Jan 31 to Feb 28 (non-leap)", () => {
    const next = nextOccurrence(new Date("2027-01-31T09:00:00Z"), "monthly");
    expect(next.getUTCFullYear()).toBe(2027);
    expect(next.getUTCMonth()).toBe(1); // February
    expect(next.getUTCDate()).toBe(28);
  });

  it("monthly clamps to Feb 29 in a leap year", () => {
    const next = nextOccurrence(new Date("2028-01-31T09:00:00Z"), "monthly");
    expect(next.getUTCDate()).toBe(29);
  });

  it("monthly keeps mid-month days unchanged", () => {
    const next = nextOccurrence(new Date("2026-11-15T10:30:00Z"), "monthly");
    expect(next.getUTCMonth()).toBe(11); // December
    expect(next.getUTCDate()).toBe(15);
  });
});

describe("formatSpan", () => {
  it("renders days+hours", () => {
    expect(formatSpan(2 * 86_400_000 + 3 * 3_600_000)).toBe("2d 3h");
  });
  it("renders hours+minutes", () => {
    expect(formatSpan(5 * 3_600_000 + 12 * 60_000)).toBe("5h 12m");
  });
  it("renders minutes, floored at 1", () => {
    expect(formatSpan(45 * 60_000)).toBe("45m");
    expect(formatSpan(3_000)).toBe("1m");
  });
});

describe("createReminder - validation", () => {
  it("creates with resolved absolute date and echoes it", async () => {
    const r = await createReminder({
      message: "Pay the electricity bill",
      dueAt: "2026-11-02T09:00:00+01:00",
      originSessionId: "s-1",
    });
    expect("error" in r && r.error).toBeFalsy();
    if ("error" in r) return;
    expect(r.id).toMatch(/^rmd_/);
    expect(r.status).toBe("pending");
    expect(r.repeat).toBeNull();
    expect(r.dueLocal).toBe("2026-11-02 09:00");
  });

  it("errors on a relative date instead of guessing (the model re-derives)", async () => {
    const r = await createReminder({
      message: "test",
      dueAt: "Monday",
      originSessionId: "s-1",
    });
    expect("error" in r && /ISO-8601/.test(r.error)).toBe(true);
  });

  it("errors on an empty message", async () => {
    const r = await createReminder({ message: "  ", dueAt: "2026-11-02T09:00:00+01:00", originSessionId: "s" });
    expect("error" in r && r.error).toContain("empty");
  });
});

describe("scheduler - at-most-once firing and delivery", () => {
  it("boot catch-up fires an overdue reminder and marks it fired", async () => {
    const r = await createReminder({
      message: "Pay bills",
      dueAt: "2026-10-30T09:00:00+01:00", // two days overdue
      originSessionId: "s-1",
    });
    if ("error" in r) throw new Error("create failed");
    const firedCount = await reminderTick(NOW);
    expect(firedCount).toBe(1);
    const all = await listReminders();
    expect(all[0]!.status).toBe("fired");
    expect(all[0]!.firedAt).toBeTruthy();
    // Delivery: injected into the origin session with an overdue note.
    expect(injected).toHaveLength(1);
    expect(injected[0]!.sessionId).toBe("s-1");
    expect(injected[0]!.text).toContain("<reminder");
    expect(injected[0]!.text).toContain("overdue");
    expect(injected[0]!.text).toContain("Pay bills");
  });

  it("does not fire future reminders", async () => {
    await createReminder({
      message: "far future",
      dueAt: "2027-06-01T09:00:00+01:00",
      originSessionId: "s-1",
    });
    const firedCount = await reminderTick(NOW);
    expect(firedCount).toBe(0);
    expect(injected).toHaveLength(0);
  });

  it("a second tick does not double-fire (at-most-once)", async () => {
    await createReminder({
      message: "once only",
      dueAt: "2026-10-30T09:00:00+01:00",
      originSessionId: "s-1",
    });
    await reminderTick(NOW);
    await reminderTick(NOW);
    await reminderTick(NOW);
    expect(injected).toHaveLength(1);
  });

  it("recurring reminders roll forward instead of completing", async () => {
    await createReminder({
      message: "Weekly report",
      dueAt: "2026-10-26T09:00:00+01:00", // Monday, overdue
      repeat: "weekly",
      originSessionId: "s-1",
    });
    await reminderTick(NOW);
    const all = await listReminders();
    expect(all[0]!.status).toBe("pending"); // still pending
    expect(new Date(all[0]!.dueAt).toISOString()).toBe(
      new Date("2026-11-02T09:00:00+01:00").toISOString(), // next Monday
    );
    expect(injected).toHaveLength(1);
    expect(injected[0]!.text).toContain("Weekly report");
    // And the NEXT occurrence is out of reach for the same tick window.
    expect(await reminderTick(NOW)).toBe(0);
  });

  it("a reminder cancelled before its tick never fires", async () => {
    const r = await createReminder({
      message: "cancel me",
      dueAt: "2026-10-30T09:00:00+01:00",
      originSessionId: "s-1",
    });
    if ("error" in r) throw new Error("create failed");
    const ok = await cancelReminder(r.id);
    expect(ok).toBe(true);
    expect(await reminderTick(NOW)).toBe(0);
    expect(injected).toHaveLength(0);
  });

  it("cancel of an unknown id reports not-found", async () => {
    expect(await cancelReminder("rmd_nonexistent")).toBe(false);
  });

  it("fireReminder no-ops when the reminder vanished mid-flight (cancel race)", async () => {
    const r = await createReminder({
      message: "race",
      dueAt: "2026-10-30T09:00:00+01:00",
      originSessionId: "s-1",
    });
    if ("error" in r) throw new Error("create failed");
    await cancelReminder(r.id);
    await fireReminder(r, NOW);
    expect(injected).toHaveLength(0);
  });
});

describe("listReminders - ordering and overdue flags", () => {
  it("pending come first by due order; fired after; overdue is flagged", async () => {
    await createReminder({ message: "future", dueAt: "2026-12-01T09:00:00+01:00", originSessionId: "s" });
    await createReminder({ message: "overdue", dueAt: "2026-10-30T09:00:00+01:00", originSessionId: "s" });
    const before = await listReminders();
    expect(before.map((x) => x.message)).toEqual(["overdue", "future"]);
    expect((before[0] as { overdue?: true }).overdue).toBe(true);
    expect((before[1] as { overdue?: true }).overdue).toBeUndefined();
    await reminderTick(NOW);
    const after = await listReminders();
    // The fired one moved to the end of the list.
    expect(after.map((x) => x.message)).toEqual(["future", "overdue"]);
    expect(after[1]!.status).toBe("fired");
  });
});
