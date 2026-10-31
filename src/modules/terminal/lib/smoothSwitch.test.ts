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
