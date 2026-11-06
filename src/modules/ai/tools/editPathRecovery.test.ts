import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { recoverEditTargetPath } from "./edit";
import type { ToolContext } from "./context";

/**
 * PATH-RECOVERY behavioral tests (2026-11-06 report: "The edit tool keeps
 * dropping the path field mid-message" - GLM 5.3 Flash on a local server
 * alphabetizes tool arguments and stream-truncates the tail, so `path` -
 * the LAST key - vanished while line_hint/old_string/new_string survived).
 *
 * recoverEditTargetPath infers the intended file from the most recently
 * read entry of the session readCache, refusing near-ties (a paged
 * multi-file read burst) rather than guessing wrong.
 */

function ctxWithReads(
  reads: Array<{ path: string; at: number }>,
): ToolContext {
  const readCache = new Map<
    string,
    { size: number; hash: number; lastReadAt?: number }
  >();
  for (const r of reads) readCache.set(r.path, { size: 1, hash: 1, lastReadAt: r.at });
  return {
    readCache,
  } as unknown as ToolContext;
}

describe("recoverEditTargetPath", () => {
  const NOW = 1_700_000_000_000;

  it("picks the most recently read file", () => {
    const ctx = ctxWithReads([
      { path: "D:/p/src/old.ts", at: NOW - 60_000 },
      { path: "D:/p/src/new.ts", at: NOW - 1_000 },
    ]);
    expect(recoverEditTargetPath(ctx)).toBe("D:/p/src/new.ts");
  });

  it("returns null when no read has a timestamp (legacy cache entries)", () => {
    const ctx = ctxWithReads([]);
    (ctx as unknown as { readCache: Map<string, unknown> }).readCache.set(
      "D:/p/a.ts",
      { size: 1, hash: 1 },
    );
    expect(recoverEditTargetPath(ctx)).toBeNull();
  });

  it("refuses a near-tie (two files read seconds apart is ambiguous)", () => {
    const ctx = ctxWithReads([
      { path: "D:/p/src/a.ts", at: NOW - 5_000 },
      { path: "D:/p/src/b.ts", at: NOW - 1_000 },
    ]);
    expect(recoverEditTargetPath(ctx)).toBeNull();
  });

  it("accepts the newest when the runner-up is far older (paged read of one file finished long ago)", () => {
    const ctx = ctxWithReads([
      { path: "D:/p/src/earlier.ts", at: NOW - 120_000 },
      { path: "D:/p/src/current.ts", at: NOW - 30_000 },
    ]);
    expect(recoverEditTargetPath(ctx)).toBe("D:/p/src/current.ts");
  });

  it("returns null for an empty cache", () => {
    expect(recoverEditTargetPath(ctxWithReads([]))).toBeNull();
  });
});

describe("path-recovery wiring (source pins)", () => {
  const edit = readFileSync(new URL("./edit.ts", import.meta.url), "utf8");
  const batchEdit = readFileSync(
    new URL("./batchEdit.ts", import.meta.url),
    "utf8",
  );

  it("edit falls back to the recovered target before erroring, and discloses it", () => {
    expect(edit).toContain("recoverEditTargetPath(ctx)");
    // The recovery is BEFORE the hard error (only errors when nothing recovered).
    const recoverIdx = edit.indexOf("const recovered = recoverEditTargetPath(ctx)");
    const errIdx = edit.indexOf("path is required and could not be inferred");
    expect(recoverIdx).toBeGreaterThan(-1);
    expect(recoverIdx).toBeLessThan(errIdx);
    // Success result tells the model which file was targeted.
    expect(edit).toContain("path field was missing from the call");
  });

  it("batch_edit inherits the recovered target for truncated edit entries", () => {
    expect(batchEdit).toContain("recoverEditTargetPath(ctx)");
    expect(batchEdit).toContain("const editPath = edit.path || recoveredTarget");
  });

  it("readCacheEntry stamps lastReadAt on every cache write", () => {
    const hash = readFileSync(new URL("../lib/hash.ts", import.meta.url), "utf8");
    expect(hash).toContain("lastReadAt: Date.now()");
  });
});
