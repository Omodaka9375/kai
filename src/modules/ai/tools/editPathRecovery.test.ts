import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../lib/native", () => {
  const files = new Map<string, string>();
  return {
    native: {
      readFile: vi.fn(async (p: string) => {
        const content = files.get(p);
        if (content === undefined) throw new Error("ENOENT");
        return { kind: "text", content, size: content.length };
      }),
      writeFile: vi.fn(async (p: string, content: string) => {
        files.set(p, content);
      }),
      canonicalize: vi.fn(async (p: string) => p),
      __files: files,
    },
  };
});
vi.mock("../lib/security", () => ({
  checkReadableCanonical: vi.fn(async (p: string) => ({ ok: true as const, canonical: p })),
  checkWritableCanonical: vi.fn(async (p: string) => ({ ok: true as const, canonical: p })),
}));
vi.stubGlobal("window", { dispatchEvent: () => true });
vi.stubGlobal(
  "CustomEvent",
  class {
    constructor(
      public type: string,
      public init: { detail?: unknown } = {},
    ) {}
  },
);

import { native } from "../lib/native";
import {
  buildEditTools,
  getEditFailures,
  recoverEditTargetPath,
  recoverEditTargetPathByContent,
  repairEditToolCallInput,
} from "./edit";
import type { ToolContext } from "./context";

const diskFiles = (native as unknown as { __files: Map<string, string> }).__files;

/**
 * PATH-RECOVERY + PRE-VALIDATION REPAIR behavioral tests:
 *  1. `edit` keeps `path` strictly REQUIRED in its wire JSON Schema so
 *     models never learn that omitting `path` is valid.
 *  2. `repairEditToolCallInput` (`experimental_repairToolCall` in agent.ts)
 *     repairs dropped `path` and drifted shapes (`file_path`, top-level
 *     `path` on `batch_edit`, single-edit object on `batch_edit`) BEFORE Zod
 *     validation, writing `path` FIRST into the canonical `toolCall.input`
 *     so diff tabs, approval cards, compaction, and conversation history all
 *     see a well-formed `{ path, ... }` call.
 *  3. `recoverEditTargetPathByContent` verifies `old_string` against cached
 *     files, resolving parallel read-burst ties and preventing edits from
 *     landing on a side-read file that doesn't contain the anchor.
 *  4. `edit` increments `getEditFailures` on `old_string not found` (regression
 *     guard for the `"ok" in retry` bug that wiped the failure counter and
 *     permanently blocked `replace_exact`).
 */

function ctxWithReads(
  reads: Array<{ path: string; at: number; content?: string }>,
): ToolContext {
  const readCache = new Map<
    string,
    { size: number; hash: number; lastReadAt?: number }
  >();
  for (const r of reads) {
    readCache.set(r.path, { size: 1, hash: 1, lastReadAt: r.at });
    if (r.content !== undefined) diskFiles.set(r.path, r.content);
  }
  return {
    getCwd: () => "D:/p",
    getWorkspaceRoot: () => "D:/p",
    getSessionId: () => "test-path-recovery",
    readCache,
    fileTracker: { markModified: vi.fn(), markRead: vi.fn() },
  } as unknown as ToolContext;
}

beforeEach(() => {
  diskFiles.clear();
});

describe("recoverEditTargetPath (recency fallback)", () => {
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

  it("refuses a near-tie (two files read seconds apart is ambiguous without content)", () => {
    const ctx = ctxWithReads([
      { path: "D:/p/src/a.ts", at: NOW - 5_000 },
      { path: "D:/p/src/b.ts", at: NOW - 1_000 },
    ]);
    expect(recoverEditTargetPath(ctx)).toBeNull();
  });

  it("accepts the newest when the runner-up is far older", () => {
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

describe("recoverEditTargetPathByContent (content-verified)", () => {
  const NOW = 1_700_000_000_000;

  it("resolves a parallel read-burst tie when old_string uniquely matches one file", async () => {
    const ctx = ctxWithReads([
      { path: "D:/p/src/a.ts", at: NOW - 1_000, content: "export const alpha = 1;\n" },
      { path: "D:/p/src/b.ts", at: NOW - 800, content: "export const beta = 2;\n" },
      { path: "D:/p/src/c.ts", at: NOW - 600, content: "export const gamma = 3;\n" },
    ]);
    // Pure recency refuses this burst; content match picks b.ts cleanly.
    expect(recoverEditTargetPath(ctx)).toBeNull();
    expect(await recoverEditTargetPathByContent(ctx, "export const beta = 2;")).toBe(
      "D:/p/src/b.ts",
    );
  });

  it("prevents editing a side-read file when old_string belongs to an earlier read", async () => {
    const ctx = ctxWithReads([
      { path: "D:/p/src/target.ts", at: NOW - 45_000, content: "function computeTotal() { return 0; }\n" },
      { path: "D:/p/src/types.ts", at: NOW - 2_000, content: "export type Total = number;\n" },
    ]);
    // Recency would have picked types.ts; content check routes to target.ts.
    expect(
      await recoverEditTargetPathByContent(ctx, "function computeTotal() { return 0; }"),
    ).toBe("D:/p/src/target.ts");
  });

  it("refuses when old_string matches MULTIPLE cached files", async () => {
    const ctx = ctxWithReads([
      { path: "D:/p/src/a.ts", at: NOW - 60_000, content: 'import { z } from "zod";\n' },
      { path: "D:/p/src/b.ts", at: NOW - 1_000, content: 'import { z } from "zod";\n' },
    ]);
    expect(
      await recoverEditTargetPathByContent(ctx, 'import { z } from "zod";'),
    ).toBeNull();
  });
});

describe("repairEditToolCallInput (pre-schema repair)", () => {
  const NOW = 1_700_000_000_000;

  it("edit schema strictly requires non-empty path on the wire", () => {
    const tools = buildEditTools(ctxWithReads([]));
    const schema = tools.edit.inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ old_string: "a", new_string: "b" }).success).toBe(false);
    expect(schema.safeParse({ path: "", old_string: "a", new_string: "b" }).success).toBe(false);
    expect(schema.safeParse({ path: "src/a.ts", old_string: "a", new_string: "b" }).success).toBe(true);
  });

  it("repairs a path-less edit call and emits `path` as the FIRST JSON key", async () => {
    const ctx = ctxWithReads([
      { path: "D:/p/src/app.ts", at: NOW - 1_000, content: "const port = 3000;\n" },
    ]);
    const repaired = await repairEditToolCallInput(
      ctx,
      "edit",
      JSON.stringify({ old_string: "const port = 3000;", new_string: "const port = 8080;" }),
    );
    expect(repaired).not.toBeNull();
    expect(repaired!.startsWith('{"path":"D:/p/src/app.ts"')).toBe(true);
    expect(JSON.parse(repaired!)).toEqual({
      path: "D:/p/src/app.ts",
      old_string: "const port = 3000;",
      new_string: "const port = 8080;",
    });
  });

  it("repairs batch_edit with top-level path (retired multi_edit shape)", async () => {
    const ctx = ctxWithReads([]);
    const repaired = await repairEditToolCallInput(
      ctx,
      "batch_edit",
      JSON.stringify({
        path: "src/app.ts",
        edits: [
          { old_string: "a", new_string: "A" },
          { old_string: "b", new_string: "B", line_hint: 10 },
        ],
      }),
    );
    expect(JSON.parse(repaired!)).toEqual({
      edits: [
        { path: "src/app.ts", old_string: "a", new_string: "A" },
        { path: "src/app.ts", old_string: "b", new_string: "B", line_hint: 10 },
      ],
    });
  });

  it("repairs batch_edit with per-entry missing path via content match or shared sibling path", async () => {
    const ctx = ctxWithReads([
      { path: "D:/p/src/x.ts", at: NOW - 1_000, content: "const x = 1;\nconst y = 2;\n" },
      { path: "D:/p/src/z.ts", at: NOW - 900, content: "const z = 3;\n" },
    ]);
    const repaired = await repairEditToolCallInput(
      ctx,
      "batch_edit",
      JSON.stringify({
        edits: [
          { old_string: "const x = 1;", new_string: "const x = 10;" },
          { old_string: "const z = 3;", new_string: "const z = 30;" },
        ],
      }),
    );
    expect(JSON.parse(repaired!)).toEqual({
      edits: [
        { path: "D:/p/src/x.ts", old_string: "const x = 1;", new_string: "const x = 10;" },
        { path: "D:/p/src/z.ts", old_string: "const z = 3;", new_string: "const z = 30;" },
      ],
    });
  });

  it("normalizes file_path / old_str / new_str aliases onto canonical keys", async () => {
    const ctx = ctxWithReads([]);
    const repaired = await repairEditToolCallInput(
      ctx,
      "edit",
      JSON.stringify({ file_path: "src/main.ts", old_str: "foo", new_str: "bar" }),
    );
    expect(JSON.parse(repaired!)).toEqual({
      path: "src/main.ts",
      old_string: "foo",
      new_string: "bar",
    });
  });
});

describe("edit not-found retry increments failure counter (regression: `\"ok\" in retry` bug)", () => {
  it("counts not-found failures so 3 strikes latch and unlock replace_exact", async () => {
    const ctx = ctxWithReads([
      { path: "D:/p/src/ target.ts".replace(" ", ""), at: Date.now(), content: "const real = 1;\n" },
    ]);
    const tools = buildEditTools(ctx);
    const exec = tools.edit.execute as unknown as (
      a: unknown,
    ) => Promise<{ ok?: boolean; error?: string }>;

    const r1 = await exec({
      path: "D:/p/src/target.ts",
      old_string: "DOES_NOT_EXIST",
      new_string: "x",
    });
    expect(r1.ok).toBe(false);
    expect(getEditFailures(ctx).get("D:/p/src/target.ts")).toBe(1);
    expect(ctx.fileTracker.markModified).not.toHaveBeenCalled();
  });
});

describe("path-recovery wiring (source pins)", () => {
  const edit = readFileSync(new URL("./edit.ts", import.meta.url), "utf8");
  const batchEdit = readFileSync(
    new URL("./batchEdit.ts", import.meta.url),
    "utf8",
  );
  const agent = readFileSync(new URL("../lib/agent.ts", import.meta.url), "utf8");

  it("edit falls back to content-verified recovery before erroring, and discloses it", () => {
    expect(edit).toContain("recoverEditTargetPathByContent(ctx, old_string)");
    const recoverIdx = edit.indexOf("recoverEditTargetPathByContent(ctx, old_string)");
    const errIdx = edit.indexOf("path is required and could not be inferred");
    expect(recoverIdx).toBeGreaterThan(-1);
    expect(recoverIdx).toBeLessThan(errIdx);
    expect(edit).toContain("path field was missing from the call");
  });

  it("batch_edit inherits content-verified or recency target for truncated entries", () => {
    expect(batchEdit).toContain("recoverEditTargetPathByContent(ctx, edit.old_string)");
    expect(batchEdit).toContain("recoverEditTargetPath(ctx)");
  });

  it("agent.ts wires experimental_repairToolCall -> repairEditToolCallInput", () => {
    expect(agent).toContain("experimental_repairToolCall");
    expect(agent).toContain("repairEditToolCallInput");
  });

  it("readCacheEntry stamps lastReadAt on every cache write", () => {
    const hash = readFileSync(new URL("../lib/hash.ts", import.meta.url), "utf8");
    expect(hash).toContain("lastReadAt: Date.now()");
  });
});
