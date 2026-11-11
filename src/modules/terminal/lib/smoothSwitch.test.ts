import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DormantRing } from "./dormantRing";

/**
 * Smooth-switch contract (2026-10-31): switching into/out of a BUSY project
 * must not freeze the frame. Three fixes, pinned here:
 *
 *  A. bindSlot replays the dormant ring in per-frame slices instead of one
 *     synchronous 256KB write burst (source pins).
 *  B. drainChunked drops backlog beyond a display budget, keeping the tail
 *     + overflow notice (behavior pins).
 *  C. The eviction scorer protects leaves that produced output recently
 *     (source pins — the pool needs no DOM to verify wiring).
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8") as string;
const enc = (n: number) => new TextEncoder().encode("x".repeat(n));

describe("DormantRing.drainChunked (budget tail-trim)", () => {
  it("replays everything when within budget", () => {
    const ring = new DormantRing();
    ring.push(enc(10));
    ring.push(enc(10));
    const out: number[] = [];
    for (const { bytes, remaining } of ring.drainChunked(1000)) {
      out.push(bytes.length);
      expect(remaining).toBeLessThanOrEqual(20);
    }
    expect(out).toEqual([10, 10]);
    expect(ring.byteLength()).toBe(0);
  });

  it("drops the HEAD beyond budget, keeps the tail", () => {
    const ring = new DormantRing();
    ring.push(enc(1000)); // old head - dropped
    ring.push(enc(100)); // tail - kept
    let total = 0;
    let sawNotice = false;
    for (const { bytes } of ring.drainChunked(200)) {
      if (new TextDecoder().decode(bytes).includes("dropped output")) sawNotice = true;
      else total += bytes.length;
    }
    expect(sawNotice).toBe(true);
    expect(total).toBe(100);
    expect(ring.byteLength()).toBe(0);
  });

  it("spending is one-shot: a fully consumed iterator empties the ring", () => {
    const ring = new DormantRing();
    ring.push(enc(10));
    ring.push(enc(10));
    const iter = ring.drainChunked(1000);
    while (!iter.next().done) { /* consume all */ }
    expect(ring.byteLength()).toBe(0);
    expect(ring.drainChunked(1000).next().done).toBe(true);
  });

  it("yields a monotonically decreasing remaining count", () => {
    const ring = new DormantRing();
    ring.push(enc(30));
    ring.push(enc(30));
    ring.push(enc(30));
    const remainings: number[] = [];
    for (const { remaining } of ring.drainChunked(1000)) remainings.push(remaining);
    expect(remainings).toEqual([60, 30, 0]);
  });

  it("plain drain() behavior is unchanged (single-shot contract intact)", () => {
    const ring = new DormantRing();
    ring.push(enc(10));
    ring.push(enc(10));
    let total = 0;
    ring.drain((b) => { total += b.length; });
    expect(total).toBe(20);
    expect(ring.byteLength()).toBe(0);
  });
});

describe("paced replay wiring (rendererPool source pins)", () => {
  const pool = read("./rendererPool.ts");
  const session = read("./useTerminalSession.ts");

  it("bindSlot paces the backlog across frames, not one write burst", () => {
    expect(pool).toContain("function replayBacklog");
    expect(pool).toMatch(/REPLAY_CHUNK_BYTES = 32 \* 1024/);
    // setTimeout, not rAF - rAF is throttled while the OS window is hidden.
    expect(pool).toMatch(/replayTimer = setTimeout/);
    expect(pool).not.toMatch(/replayTimer = requestAnimationFrame/);
    // Hard fuse so the backlog can never dribble forever.
    expect(pool).toMatch(/REPLAY_FUSE_MS/);
  });

  it("the paced replay is cancelled on unbind and rebind", () => {
    expect(pool).toMatch(/if \(slot\.replayTimer\) clearTimeout\(slot\.replayTimer\)/);
  });

  it("AcquireParams.drainRing is the chunked iterator", () => {
    expect(pool).toContain("drainRing: () => Generator<{ bytes: Uint8Array; remaining: number }>;");
  });

  it("live output flushes the backlog before writing (ordering)", () => {
    // Live bytes appended into the MIDDLE of a paced replay put pre-bind
    // history on top of what the user is watching: the line jumps back and
    // the caret blinks above the newest line. writeLiveToSlot flushes first.
    const fn = pool.slice(pool.indexOf("export function writeLiveToSlot"));
    expect(fn).toContain("if (slot.finishReplay) slot.finishReplay();");
    // ...and the term.write must come AFTER that flush.
    expect(fn.indexOf("slot.finishReplay()")).toBeLessThan(
      fn.indexOf("slot.term.write(bytes)"),
    );
    // The session layer must route through the helper, never write directly.
    expect(session).toContain("writeLiveToSlot(slot, bytes)");
    expect(session).not.toMatch(/if \(slot\) slot\.term\.write\(/);
  });

  it("the cursor-show lands AFTER the last backlog byte, not mid-replay", () => {
    // Pre-fix order: replayBacklog(...) then term.write("\x1b[?25h") — the
    // show-cursor was queued behind the FIRST slice only, so the caret was
    // painted on an intermediate history line for the rest of the drain.
    const epilogue = pool.slice(pool.indexOf("replayBacklog(slot, p, () =>"));
    expect(epilogue).toContain('slot.term.write("\\x1b[?25h")');
    expect(pool).toMatch(/function replayBacklog\(\s*slot: Slot,\s*p: AcquireParams,\s*onDone: \(\) => void,?\s*\)/);
    // replayBacklog must call onDone exactly on completion paths.
    const body = pool.slice(
      pool.indexOf("function replayBacklog("),
      pool.indexOf("export function writeLiveToSlot"),
    );
    expect(body).toMatch(/if \(next\.done\) \{\s*if \(slot\.finishReplay === finish\) slot\.finishReplay = null;\s*onDone\(\);/);
    expect(body).toContain("    onDone();\n  };");
  });

  it("an in-flight replay handle is dropped on unbind and rebind", () => {
    // A straggler live write must not flush a replay that belongs to the
    // previous leaf.
    const detach = pool.slice(
      pool.indexOf("function detachSlotFromLeaf"),
      pool.indexOf("function destroySlot"),
    );
    expect(detach).toContain("slot.finishReplay = null;");
    // bindSlot clears the handle right where it cancels the replay timer
    // (replayBacklog is defined ABOVE bindSlot, so slice forwards from bind).
    const bindStart = pool.indexOf("function bindSlot(slot: Slot");
    expect(bindStart).toBeGreaterThan(-1);
    const bind = pool.slice(bindStart, bindStart + 600);
    expect(bind).toContain("slot.finishReplay = null;");
    expect(bind).toMatch(
      /clearTimeout\(slot\.replayTimer\);\s*slot\.replayTimer = null;\s*slot\.finishReplay = null;/,
    );
  });

  it("the forced cursor-show is skipped in the alternate buffer", () => {
    // Full-screen apps (vim/less/htop) hide the cursor deliberately.
    const epilogue = pool.slice(pool.indexOf("replayBacklog(slot, p, () =>"));
    expect(epilogue).toContain("if (isAltScreen(slot)) return;");
    expect(epilogue.indexOf("isAltScreen")).toBeLessThan(
      epilogue.indexOf('slot.term.write("\\x1b[?25h")'),
    );
  });
});

describe("activity-aware eviction (source pins)", () => {
  const pool = read("./rendererPool.ts");
  const session = read("./useTerminalSession.ts");

  it("the scorer protects leaves that produced output recently", () => {
    expect(pool).toMatch(/leafProducedRecently\?\.\(/);
    expect(pool).toMatch(/\(hot \? 100 : 0\)/);
  });

  it("the session layer stamps lastOutputAt on every PTY byte", () => {
    expect(session).toContain("s.lastOutputAt = performance.now();");
    expect(session).toMatch(/LEAF_HOT_WINDOW_MS = 5_000/);
    expect(session).toContain("drainChunked(REPLAY_BACKLOG_BUDGET_BYTES)");
  });
});
