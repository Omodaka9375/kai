import { describe, expect, it, vi } from "vitest";

/**
 * Session event journal client tests. `buildTurnEvent` is pure (the whole
 * point — it must never throw on the run path and is trivially assertable);
 * the append functions are fire-and-forget over `invoke`, mocked here so the
 * "never blocks, never throws" contract is pinned.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import type { SessionEvent, SessionJournalEntry } from "./sessionEvents";

const {
  buildTurnEvent,
  appendSessionEvent,
  appendSessionEvents,
  sessionEventsClear,
  summarizeJournal,
} = await import("./sessionEvents");
const { invoke } = await import("@tauri-apps/api/core");

describe("buildTurnEvent", () => {
  it("reduces the system prompt to hash+length (never embeds it)", () => {
    const ev = buildTurnEvent({
      modelId: "claude-x",
      provider: "anthropic",
      canSee: true,
      planMode: false,
      autoApprove: "off",
      thinkingMode: "low",
      systemPrompt: "a".repeat(5000),
      toolNames: ["read_file", "edit"],
      mcpServerCount: 1,
      messageCount: 12,
    });
    expect(ev.kind).toBe("turn");
    if (ev.kind !== "turn") return;
    expect(ev.systemLength).toBe(5000);
    expect(typeof ev.systemHash).toBe("number");
    // The prompt text itself must NOT leak into the event.
    expect(JSON.stringify(ev)).not.toContain("aaaa");
    // buildTurnEvent preserves order; the CALLER (agent.ts) sorts so the
    // hash-free tool-name list is deterministic across runs.
    expect(ev.toolNames).toEqual(["read_file", "edit"]);
  });

  it("hash is stable for identical input, differs on change", () => {
    const base = {
      modelId: "m",
      provider: "p",
      canSee: true,
      planMode: false,
      autoApprove: "off",
      thinkingMode: "off",
      toolNames: [],
      mcpServerCount: 0,
      messageCount: 0,
    };
    const a = buildTurnEvent({ ...base, systemPrompt: "hello" });
    const b = buildTurnEvent({ ...base, systemPrompt: "hello" });
    const c = buildTurnEvent({ ...base, systemPrompt: "hellO" });
    if (a.kind !== "turn" || b.kind !== "turn" || c.kind !== "turn") return;
    expect(a.systemHash).toBe(b.systemHash);
    expect(a.systemHash).not.toBe(c.systemHash);
  });
});

describe("append plumbing (fire-and-forget)", () => {
  it("appendSessionEvent invokes session_events_append with sessionId + JSON", () => {
    vi.mocked(invoke).mockClear();
    appendSessionEvent("s-9", { kind: "compact", droppedCount: 2, contextLimit: 100 });
    expect(invoke).toHaveBeenCalledWith(
      "session_events_append",
      expect.objectContaining({ sessionId: "s-9" }),
    );
    const [, args] = vi.mocked(invoke).mock.calls[0]!;
    const parsed = JSON.parse((args as { eventsJson: string }).eventsJson);
    expect(parsed[0].kind).toBe("compact");
  });

  it("skips the unknown/empty session id (no journal for a session-less run)", () => {
    vi.mocked(invoke).mockClear();
    appendSessionEvent("unknown", { kind: "retry", reason: "x", attempt: 1 });
    appendSessionEvents("", []);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("never throws even if invoke rejects", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("ipc down"));
    // Fire-and-forget: the caller sees no throw; the rejection is swallowed.
    expect(() =>
      appendSessionEvent("s-1", { kind: "loop-nudge", toolName: "edit", repeatCount: 2 }),
    ).not.toThrow();
    // Let the microtask queue drain the .catch.
    await Promise.resolve();
  });

  it("sessionEventsClear routes to the clear command", () => {
    vi.mocked(invoke).mockClear();
    sessionEventsClear("s-del");
    expect(invoke).toHaveBeenCalledWith(
      "session_events_clear",
      expect.objectContaining({ sessionId: "s-del" }),
    );
  });
});

describe("sessionJournalList (client)", () => {
  it("invokes session_journal_list with no args", async () => {
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce([]);
    const { sessionJournalList } = await import("./sessionEvents");
    await sessionJournalList();
    expect(invoke).toHaveBeenCalledWith("session_journal_list");
  });
});

describe("summarizeJournal (pure roll-up)", () => {
  // The on-disk entry type carries the server-stamped `ts` (the writer
  // never sets it, the reader always sees it), so fixtures use it here.
  const turn = (
    over: Partial<Extract<SessionEvent, { kind: "turn" }>> & { ts?: number },
  ): SessionJournalEntry => ({
    kind: "turn",
    modelId: "gpt-5.5",
    provider: "openai",
    canSee: false,
    planMode: false,
    autoApprove: "off",
    thinkingMode: "off",
    systemHash: 1,
    systemLength: 100,
    toolNames: [],
    mcpServerCount: 0,
    messageCount: 1,
    ts: 1000,
    ...over,
  });

  it("counts turns, context events and anomalies, dedup-sorts models", () => {
    const s = summarizeJournal([
      turn({ modelId: "b-model", ts: 3 }),
      turn({ modelId: "a-model", ts: 2 }),
      turn({ modelId: "b-model", ts: 1 }),
      { kind: "compact", droppedCount: 1, contextLimit: 10, ts: 4 },
      { kind: "retry", reason: "x", attempt: 1, ts: 5 },
      { kind: "loop-nudge", toolName: "edit", repeatCount: 3, ts: 6 },
    ]);
    expect(s.events).toBe(6);
    expect(s.turns).toBe(3);
    expect(s.contextEvents).toBe(1);
    expect(s.anomalies).toBe(2);
    expect(s.models).toEqual(["a-model", "b-model"]);
    expect(s.lastTs).toBe(6);
  });

  it("takes lastAutoApprove from the NEWEST turn even when input is unsorted", () => {
    // sessionEventsRecent returns newest-first, but the roll-up must not
    // depend on that ordering to pick the current mode.
    const s = summarizeJournal([
      turn({ autoApprove: "all", ts: 500 }),
      turn({ autoApprove: "off", ts: 100 }),
    ]);
    expect(s.lastAutoApprove).toBe("all");
    const s2 = summarizeJournal([
      turn({ autoApprove: "off", ts: 100 }),
      turn({ autoApprove: "all", ts: 500 }),
    ]);
    expect(s2.lastAutoApprove).toBe("all");
  });

  it("empty journal summarizes to zeros with no model and null mode", () => {
    const s = summarizeJournal([]);
    expect(s).toMatchObject({
      events: 0,
      turns: 0,
      contextEvents: 0,
      anomalies: 0,
      models: [],
      lastAutoApprove: null,
      lastTs: 0,
    });
  });
});
