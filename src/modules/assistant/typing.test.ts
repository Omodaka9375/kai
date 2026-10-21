import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-contract pins: the Telegram "typing…" indicator during long turns.
 *
 * The class this guards: a multi-minute assistant run (tools, media) goes
 * dark after Telegram's ~5s sendChatAction window — the owner can't tell a
 * slow turn from a dead bot. The fix is a repeating typing action for the
 * whole turn, best-effort everywhere (a missing hint must never fail or
 * delay the turn, and must never leak an interval timer).
 */

const idxSrc = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const prefsSrc = readFileSync(new URL("./prefs.ts", import.meta.url), "utf8");
const rustSrc = readFileSync(
  new URL("../../../src-tauri/src/modules/telegram.rs", import.meta.url),
  "utf8",
);

describe("Telegram typing indicator", () => {
  it("the bridge exposes sendChatAction against the allowlisted command", () => {
    expect(prefsSrc).toContain("sendChatAction");
    expect(prefsSrc).toContain('"telegram_set_chat_action"');
  });

  it("Rust allowlists the action and never rejects on failure", () => {
    expect(rustSrc).toContain("sendChatAction");
    expect(rustSrc).toMatch(/"typing" \| "upload_document" \| "upload_video"/);
    // Failure path: warn + Ok(()), never Err — a status hint can't fail a turn.
    const body = rustSrc.split("telegram_set_chat_action")[1] ?? "";
    expect(body).toContain("Ok(()) // never fail the turn over a status hint");
  });

  it("drainQueue starts typing on dequeue and ALWAYS stops on settle", () => {
    const body = idxSrc.split("async function drainQueue")[1] ?? "";
    expect(body).toContain("startTypingIndicator(token, next.chatId);");
    // The finally block is the only place settle happens — stop must live
    // there, before turnInFlight is released.
    const fin = body.split("} finally {")[1] ?? "";
    expect(fin.indexOf("stopTypingIndicator();")).toBeGreaterThanOrEqual(0);
    expect(fin.indexOf("stopTypingIndicator();")).toBeLessThan(
      fin.indexOf("turnInFlight = false;"),
    );
  });

  it("the indicator is idempotent + interval-backed (no leaked timers)", () => {
    expect(idxSrc).toContain("stopTypingIndicator();");
    expect(idxSrc).toContain("typingStop = null;");
    expect(idxSrc).toMatch(/setInterval/);
    expect(idxSrc).toMatch(/TYPING_INTERVAL_MS = 4_000/);
    // Every send is fire-and-forget with a swallowed rejection.
    expect(idxSrc.match(/sendChatAction\(token, chatId, "typing"\)\.catch\(\(\) => \{\}\)/g)?.length).toBe(2);
  });
});