import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * SOURCE PINS (2026-11-06 report): "if I toggle from Allow to Ask in the
 * middle of some command it doesn't work anymore - no matter if I later
 * change to allow/ask it just auto allows all. Toggle loses all power."
 *
 * Two defects, both traced from source:
 *
 * 1. DEFERRED-AUTO-APPROVE FIRE-TIME GAP: under Allow, each pending card is
 *    approved via setTimeout(0). A multi-tool step (batch_edit's many
 *    calls, chained commands) schedules SEVERAL; switching to Ask mid-step
 *    cancelled none of them - the timers only latched DENIALS at fire time,
 *    never re-read the mode, so everything still auto-approved and the
 *    toggle read as broken.
 * 2. FROZEN APPROVAL CARD: AiToolApproval's memo comparator ignored the
 *    auto-approve mode, so a card that rendered as the flat
 *    "auto-approved" row under Allow stayed memo-frozen after switching to
 *    Ask - no buttons ever appeared, and the pending call could not be
 *    answered manually either. The toggle looked dead even for FUTURE
 *    calls because the first frozen card pins the whole sequential
 *    approval queue (every later card renders as a "queued" chip behind
 *    it).
 */
describe("allow/ask mid-run toggle (source pins)", () => {
  const bridge = readFileSync(
    new URL("../components/AgentRunBridge.tsx", import.meta.url),
    "utf8",
  );
  const card = readFileSync(
    new URL("../components/AiToolApproval.tsx", import.meta.url),
    "utf8",
  );

  it("the deferred auto-approve re-checks the CURRENT mode at fire time", () => {
    // The fire-time gate: a timer scheduled under Allow dies if the user
    // has since switched the session to Ask. Must read the session-scoped
    // map, not the presentation-only store field.
    // 2026-11-16 fix: the gate is grant-aware — an ALWAYS-ALLOW grant
    // survives the mode toggle (the user's decision is per-tool, not
    // per-mode) but is re-read from the LIVE prefs at fire time, so a
    // Settings revocation landing between schedule and fire cancels it.
    // 2026-11-25 TRUST GATE: the read is effectiveSessionAutoApprove - an
    // untrusted project forces Ask at fire time too, so trusting/untrusting
    // mid-step takes effect on the next timer just like a mode toggle.
    expect(bridge).toContain(
      'if (effectiveSessionAutoApprove(sessionId) !== "all" && !stillGranted) {',
    );
    // And the gate sits INSIDE the setTimeout callback (fire time), not
    // before it (schedule time).
    const timerIdx = bridge.indexOf("setTimeout(() => {");
    const gateIdx = bridge.indexOf(
      'if (effectiveSessionAutoApprove(sessionId) !== "all" && !stillGranted) {',
    );
    expect(timerIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(timerIdx);
  });

  it("the approval card's memo comparator treats the mode as an input", () => {
    // The card must re-render when the auto-approve version bumps, or a
    // flat auto-approved row stays frozen after Allow -> Ask.
    expect(card).toContain("modeVersionA === modeVersionB");
    expect(card).toContain("getSessionAutoApproveVersion()");
    // The REAL reactivity is the impl's own subscription: the comparator
    // above reads the same counter twice and can never differ, so only
    // useSyncExternalStore can re-render a memoized card on a mode flip.
    expect(card).toContain("subscribeSessionAutoApprove,");
    expect(card).toContain("useSyncExternalStore(");
  });

  it("a card reads the mode of the session that OWNS it, not the foreground", () => {
    // 2026-11-21 report: "in Workspaces tool calls just writing green
    // approved but it's stuck there until I toggle Allow to Ask and Allow
    // again". Every Workspaces card shows a BACKGROUND project's chat, but
    // the card read the FOREGROUND session's Ask/Allow mode: with the
    // active project on Allow every other card painted the buttonless flat
    // "auto-approved" row while its own bridge (correctly) asked - a
    // parked run nobody could answer. Toggling the card's pill bumped the
    // version, the prediction re-read the same wrong session... and only
    // the second flip landed on "all" for the right session.
    expect(card).toContain("const ownerSessionId = sessionId ?? activeSessionId ?? \"\";");
    // 2026-11-25 TRUST GATE: the prediction reads the trust-gated effective
    // mode so an untrusted project never paints the flat auto-approved row.
    expect(card).toContain("effectiveSessionAutoApprove(ownerSessionId)");
    expect(card).not.toContain('getSessionAutoApprove(s.activeSessionId ?? "")');
    // Surfaces that show a non-foreground session must pass it down.
    const grid = readFileSync(
      new URL("../components/ProjectChatGrid.tsx", import.meta.url),
      "utf8",
    );
    expect(grid).toContain("sessionId={sessionId}");
    const chat = readFileSync(
      new URL("../components/AiChat.tsx", import.meta.url),
      "utf8",
    );
    expect(chat).toContain("sessionId?: string;");
    expect(chat).toContain("sessionId={sessionId}");
  });

  it("green means the decision landed - a predicted approval says approving", () => {
    // The flat row used to be solid green with "auto-approved" from a
    // PREDICTION alone, so a wrong prediction looked exactly like a
    // finished decision. Predictions now read "approving…" muted; only a
    // resolved id (or an Always-Allow grant) goes green.
    expect(card).toContain('"approving…"');
    expect(card).toContain("const resolved = wasAutoApproved || hasGrant;");
    expect(card).toContain('resolved ? "bg-emerald-500" : "animate-pulse bg-amber-500"');
  });

  it("a background project resolved on demand restores its persisted Allow mode", () => {
    // The map is memory-only and hydrateSessions seeds it ONLY for the
    // project being visited, so a Workspaces card for a background project
    // always fell back to "off" - even a project the user left on Allow
    // showed a waiting card. resolveBackgroundProjectSession reads the
    // project's own sessions file, so it seeds the same modes there.
    const store = readFileSync(
      new URL("../store/chatStore.ts", import.meta.url),
      "utf8",
    );
    const fn = store.slice(
      store.indexOf("export async function resolveBackgroundProjectSession("),
      store.indexOf("setProjectActiveSession(projectId, persistedActiveId);"),
    );
    expect(fn).toContain("for (const s of loaded.sessions) {");
    expect(fn).toContain('sessionAutoApprove.set(s.id, s.autoApprove);');
    expect(fn).toContain("bumpAutoApproveVersion();");
    // Seeded BEFORE the bind (the bridge re-renders the moment the project
    // session is set, so a late seed would paint one wrong-mode frame).
    const seedIdx = store.indexOf("bumpAutoApproveVersion();", store.indexOf("export async function resolveBackgroundProjectSession("));
    const bindIdx = store.indexOf("setProjectActiveSession(projectId, persistedActiveId);");
    expect(seedIdx).toBeGreaterThan(-1);
    expect(seedIdx).toBeLessThan(bindIdx);
  });
});
