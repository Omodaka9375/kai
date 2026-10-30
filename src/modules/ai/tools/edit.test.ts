import { describe, expect, it, vi, beforeEach } from "vitest";
import { readCacheEntry } from "../lib/hash";

// applyEdits imports these transitively; the native bridge must be a stub
// because Node has no Tauri IPC. The pure-function behavior under test
// (identical-edit skipping) never touches native code on its path.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../lib/native", () => ({
  native: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    canonicalize: vi.fn(async (p: string) => p),
  },
}));
vi.mock("../lib/security", () => ({
  checkReadableCanonical: vi.fn(async (p: string) => ({ ok: true as const, canonical: p })),
  checkWritableCanonical: vi.fn(async (p: string) => ({ ok: true as const, canonical: p })),
}));

const batchEditModule = await import("./batchEdit");

// applyEdits dispatches a `Kai:fs-changed` CustomEvent on window after
// writing; Node has neither. Stub both before any edit runs.
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

// The edit/batch_edit executes are driven through a minimal ToolContext
// with an in-memory file store so the identical-edit path runs end to end.
type FileStore = Map<string, string>;
const files: FileStore = new Map();

const nativeMod = await import("../lib/native");

beforeEach(() => {
  files.clear();
  (nativeMod.native.readFile as ReturnType<typeof vi.fn>).mockImplementation(
    async (p: string) => {
      const content = files.get(p);
      if (content === undefined) throw new Error("ENOENT");
      return { kind: "text", content, size: content.length };
    },
  );
  (nativeMod.native.writeFile as ReturnType<typeof vi.fn>).mockImplementation(
    async (p: string, content: string) => {
      files.set(p, content);
    },
  );
});

const ctx = {
  getCwd: () => "/ws",
  getWorkspaceRoot: () => "/ws",
  getSessionId: () => "test-session",
  readCache: new Map(),
  fileTracker: { markRead: () => {}, markModified: () => {} },
} as unknown as import("./context").ToolContext;

describe("batch_edit identical-edit hardening", () => {
  it("skips an identical old/new edit and applies the rest atomically", async () => {
    const path = "/ws/a.ts";
    files.set(path, "const a = 1;\nconst b = 2;\n");
    const tools = batchEditModule.buildBatchEditTools(ctx);
    // AI SDK v6 tool execute signature is (input, options) — pass an empty
    // second arg, and type the result loosely since execute returns unknown.
    const result = (await tools.batch_edit.execute!(
      {
        edits: [
          { path, old_string: "const a = 1;", new_string: "const a = 1;" }, // no-op
          { path, old_string: "const b = 2;", new_string: "const b = 20;" },
        ],
      },
      {} as never,
    )) as { ok?: boolean; replacements?: number; files?: number; error?: string };
    expect(result.ok).toBe(true);
    expect(files.get(path)).toBe("const a = 1;\nconst b = 20;\n");
  });

  it("errors when the ENTIRE batch is identical no-ops", async () => {
    const path = "/ws/b.ts";
    files.set(path, "hello\n");
    const tools = batchEditModule.buildBatchEditTools(ctx);
    const result = (await tools.batch_edit.execute!(
      {
        edits: [{ path, old_string: "hello", new_string: "hello" }],
      },
      {} as never,
    )) as { ok?: boolean; error?: string };
    expect(result.ok).toBeFalsy();
    expect(result.error).toContain("no-ops");
    expect(files.get(path)).toBe("hello\n"); // untouched
  });
});

describe("batch_edit stale guard (hash-only, self-write immune)", () => {
  // The tool's OWN writes must never trip the stale-read guard. The old
  // guard compared cache size (UTF-16 chars) against the disk read size
  // (bytes) — any non-ASCII file made them disagree, so the second
  // batch_edit after a successful first one bounced with "file changed
  // since your last read", looping models into single edit calls.
  it("accepts a second batch_edit after its own write on a non-ASCII file", async () => {
    const path = "/ws/uni.ts";
    files.set(path, 'const s = "héllo → wörld — ünïcode";\nconst a = 1;\n');
    const tools = batchEditModule.buildBatchEditTools(ctx);
    // Simulate the model's read_file: seed the cache from the same string.
    ctx.readCache.set(path, readCacheEntry(files.get(path)!));

    const first = (await tools.batch_edit.execute!(
      {
        edits: [{ path, old_string: "const a = 1;", new_string: "const a = 2;" }],
      },
      {} as never,
    )) as { ok?: boolean; error?: string };
    expect(first.ok).toBe(true);

    // Second batch_edit against the content the tool itself wrote.
    const second = (await tools.batch_edit.execute!(
      {
        edits: [{ path, old_string: "const a = 2;", new_string: "const a = 3;" }],
      },
      {} as never,
    )) as { ok?: boolean; error?: string };
    expect(second.error).toBeUndefined();
    expect(second.ok).toBe(true);
    expect(files.get(path)).toBe(
      'const s = "héllo → wörld — ünïcode";\nconst a = 3;\n',
    );
  });

  it("bounces on a GENUINE external change and counts it toward the escape hatch", async () => {
    const path = "/ws/ext.ts";
    files.set(path, "externally modified content\n");
    const tools = batchEditModule.buildBatchEditTools(ctx);
    // Cache claims a different content than disk — a real external edit.
    ctx.readCache.set(path, { size: 5, hash: 1 });

    for (let i = 0; i < 3; i++) {
      const r = (await tools.batch_edit.execute!(
        {
          edits: [{ path, old_string: "x", new_string: "y" }],
        },
        {} as never,
      )) as { error?: string };
      expect(r.error).toContain("file changed since your last read");
    }
    // Fourth consecutive resubmission (no re-read between) hits the hatch.
    const last = (await tools.batch_edit.execute!(
      {
        edits: [{ path, old_string: "x", new_string: "y" }],
      },
      {} as never,
    )) as { error?: string };
    expect(last.error).toContain("failed 3 times");
  });

  it("accepts line_hint in the batch_edit schema (was silently stripped)", async () => {
    const path = "/ws/dup.ts";
    files.set(path, "flag = 0\n// midpoint\nflag = 0\n");
    const tools = batchEditModule.buildBatchEditTools(ctx);
    ctx.readCache.set(path, readCacheEntry(files.get(path)!));
    // Sanity: schema now parses line_hint instead of dropping it.
    const parsed = (
      tools.batch_edit.inputSchema as unknown as {
        safeParse: (v: unknown) => {
          success: boolean;
          data?: { edits: { line_hint?: number }[] };
        };
      }
    ).safeParse({
      edits: [{ path, old_string: "flag = 0", new_string: "flag = 1", line_hint: 3 }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.edits[0]?.line_hint).toBe(3);

    // End to end: line_hint picks the occurrence near line 3.
    const r = (await tools.batch_edit.execute!(
      {
        edits: [{ path, old_string: "flag = 0", new_string: "flag = 1", line_hint: 3 }],
      },
      {} as never,
    )) as { ok?: boolean; replacements?: number };
    expect(r.ok).toBe(true);
    expect(r.replacements).toBe(1);
    expect(files.get(path)).toBe("flag = 0\n// midpoint\nflag = 1\n");
  });
});

describe("batch_edit atomic failure contract", () => {
  it("writes nothing when a later edit fails and identifies its index", async () => {
    const path = "/ws/atomic.ts";
    const original = "alpha\nbeta\ngamma\n";
    files.set(path, original);
    ctx.readCache.set(path, readCacheEntry(original));
    const tools = batchEditModule.buildBatchEditTools(ctx);
    const result = (await tools.batch_edit.execute!(
      {
        edits: [
          { path, old_string: "alpha", new_string: "ALPHA" },
          { path, old_string: "DOES NOT EXIST", new_string: "x" },
        ],
      },
      {} as never,
    )) as {
      ok?: boolean;
      changed?: boolean;
      failedEdit?: number;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.failedEdit).toBe(1);
    expect(result.error).toContain("No changes were written");
    expect(files.get(path)).toBe(original);
  });

  it("edits multiple files in one batch and rolls back nothing on success", async () => {
    const p1 = "/ws/m1.ts";
    const p2 = "/ws/m2.ts";
    files.set(p1, "one\n");
    files.set(p2, "two\n");
    const tools = batchEditModule.buildBatchEditTools(ctx);
    const result = (await tools.batch_edit.execute!(
      {
        edits: [
          { path: p1, old_string: "one", new_string: "ONE" },
          { path: p2, old_string: "two", new_string: "TWO" },
        ],
      },
      {} as never,
    )) as { ok?: boolean; files?: number; replacements?: number };
    expect(result.ok).toBe(true);
    expect(result.files).toBe(2);
    expect(result.replacements).toBe(2);
    expect(files.get(p1)).toBe("ONE\n");
    expect(files.get(p2)).toBe("TWO\n");
  });

  it("cross-file failure writes NEITHER file", async () => {
    const p1 = "/ws/x1.ts";
    const p2 = "/ws/x2.ts";
    files.set(p1, "one\n");
    files.set(p2, "two\n");
    const tools = batchEditModule.buildBatchEditTools(ctx);
    const result = (await tools.batch_edit.execute!(
      {
        edits: [
          { path: p1, old_string: "one", new_string: "ONE" },
          { path: p2, old_string: "MISSING", new_string: "X" },
        ],
      },
      {} as never,
    )) as { ok?: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No changes were written");
    expect(files.get(p1)).toBe("one\n");
    expect(files.get(p2)).toBe("two\n");
  });
});

describe("batch_edit validation failures leave disk untouched", () => {
  // Regression: a mid-batch validation failure used to call rollback(),
  // which WROTE the in-memory snapshots (including same-file compounds —
  // partially applied content) to disk while claiming a rollback.
  it("does not write partial content when a later edit fails to match", async () => {
    const path = "/ws/be.ts";
    const original = "line1\nline2\nline3\n";
    files.set(path, original);
    const tools = batchEditModule.buildBatchEditTools(ctx);
    const result = (await tools.batch_edit.execute!(
      {
        edits: [
          { path, old_string: "line1", new_string: "line1-edit" },
          { path, old_string: "NO SUCH LINE", new_string: "x" },
        ],
      },
      {} as never,
    )) as { ok?: boolean; error?: string };
    expect(result.ok).toBeFalsy();
    expect(result.error).toContain("not found");
    // THE assertion: disk still holds the original, not the compound.
    expect(files.get(path)).toBe(original);
  });

  it("rejects an identical old/new edit without touching disk", async () => {
    const path = "/ws/be2.ts";
    const original = "alpha\nbeta\n";
    files.set(path, original);
    const tools = batchEditModule.buildBatchEditTools(ctx);
    const result = (await tools.batch_edit.execute!(
      {
        edits: [{ path, old_string: "alpha", new_string: "alpha" }],
      },
      {} as never,
    )) as { ok?: boolean; error?: string };
    expect(result.ok).toBeFalsy();
    // The consolidated engine reports a lone no-op as a no-op batch (the
    // old pre-engine batch_edit said "identical" — same contract, clearer
    // wording).
    expect(result.error).toContain("no-ops");
    expect(files.get(path)).toBe(original);
  });
});
