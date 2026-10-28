import { describe, expect, it } from "vitest";
import { withExclusiveLock, withFileMutationLock } from "./mutationLock";

/**
 * Locking tests. The AI SDK runs sibling tool calls from one assistant step
 * CONCURRENTLY; these locks are what keep shared stateful resources (the
 * per-session agent shell, a file being read-modified-written) from
 * interleaving.
 */

describe("withExclusiveLock", () => {
  it("serializes calls on the same key in arrival order", async () => {
    const order: string[] = [];
    const make = (label: string, hold: number) =>
      withExclusiveLock("shared", async () => {
        order.push(`start:${label}`);
        await new Promise((r) => setTimeout(r, hold));
        order.push(`end:${label}`);
      });
    // B is scheduled while A is still holding the lock.
    const a = make("A", 20);
    const b = make("B", 1);
    await Promise.all([a, b]);
    // No interleave: A fully completes before B starts.
    expect(order).toEqual(["start:A", "end:A", "start:B", "end:B"]);
  });

  it("runs different keys in parallel", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const make = (key: string) =>
      withExclusiveLock(key, async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
      });
    await Promise.all([make("x", ), make("y"), make("z")]);
    // Different keys overlap freely.
    expect(maxConcurrent).toBe(3);
  });

  it("releases the key on a thrown error so the next caller is not blocked", async () => {
    await expect(
      withExclusiveLock("boom", async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    // A subsequent holder must run, not wait on the crashed tail forever.
    let ran = false;
    await withExclusiveLock("boom", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("returns the callback's value", async () => {
    expect(await withExclusiveLock("v", async () => 42)).toBe(42);
  });

  it("does not collide with the file-lock map (separate tails)", async () => {
    // The same string used as both an exclusive key and a file path must not
    // serialize against each other (independent maps by design).
    let concurrent = 0;
    let maxConcurrent = 0;
    const bump = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
    };
    await Promise.all([
      withExclusiveLock("same", bump),
      withFileMutationLock(["same"], bump),
    ]);
    expect(maxConcurrent).toBe(2);
  });
});

describe("withFileMutationLock (regression guard)", () => {
  it("serializes overlapping paths", async () => {
    const order: string[] = [];
    await Promise.all([
      withFileMutationLock(["a.ts"], async () => {
        order.push("A-start");
        await new Promise((r) => setTimeout(r, 10));
        order.push("A-end");
      }),
      withFileMutationLock(["a.ts", "b.ts"], async () => {
        order.push("B-start");
        await new Promise((r) => setTimeout(r, 1));
        order.push("B-end");
      }),
    ]);
    expect(order).toEqual(["A-start", "A-end", "B-start", "B-end"]);
  });
});

/** bash_run shared-shell wiring is a source contract (no shell runtime in unit tests). */
describe("bash_run serializes on the shared agent shell", () => {
  it("wraps shellSessionRun in withExclusiveLock keyed by the session shell", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../tools/shell.ts", import.meta.url), "utf8");
    expect(src).toMatch(
      /const r = await withExclusiveLock\(shellKey, \(\) =>[\s\S]*?native\.shellSessionRun\(/,
    );
    // The elevated one-shot path must NOT be inside the lock (separate
    // process). runElevatedCommand appears, and that branch RETURNS, before
    // the shared-shell lock is reached — assert the elevated return precedes
    // the withExclusiveLock call site.
    const elevatedIdx = src.indexOf("runElevatedCommand(command, cwd, effectiveTimeout)");
    const lockIdx = src.indexOf("const r = await withExclusiveLock(shellKey");
    expect(elevatedIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeGreaterThan(elevatedIdx);
  });
});
