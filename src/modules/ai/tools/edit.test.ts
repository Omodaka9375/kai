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

describe("edit punctuation near-miss diagnosis", () => {
  // The em-dash trap: files use em-dashes in comments/prose, but terminal
  // output renders them as "-", so a model copying an anchor FROM TERMINAL
  // OUTPUT sends "-" where the file has U+2014. The fuzzy tier only relaxes
  // WHITESPACE, so historically the edit bounced with a generic "not found"
  // naming a visually identical block - the model retried the same anchor
  // forever, and 3 bounces latched the file into the write_file-only path.
  // Now the THIRD matching tier auto-applies punctuation-equivalent matches,
  // and the diagnosis only fires when even that tier can't act (ambiguity).
  it("APPLIES an em-dash vs hyphen near-miss via the punct tier (carry-over preserves the file's dash)", async () => {
    const path = "/ws/dash.ts";
    // File contains a REAL em-dash (U+2014) in BOTH lines.
    files.set(
      path,
      "// group panel \u2014 the AI mini window's twin\n// note \u2014 keep me\n",
    );
    ctx.readCache.set(path, readCacheEntry(files.get(path)!));
    const tools = batchEditModule.buildBatchEditTools(ctx);
    // Model's anchor uses a plain hyphen where the file has the em-dash.
    const result = (await tools.batch_edit.execute!(
      {
        edits: [
          {
            path,
            old_string: "// group panel - the AI mini window's twin",
            new_string: "// group panel - docked twin",
          },
        ],
      },
      {} as never,
    )) as { ok?: boolean; replacements?: number; error?: string };
    expect(result.ok).toBe(true);
    expect(result.replacements).toBe(1);
    const out = files.get(path)!;
    // The REPLACED line keeps the file's em-dash (carry-over harmonized the
    // model's hyphen to the file's variant), and the untouched line is
    // byte-identical.
    expect(out).toContain("// group panel \u2014 docked twin");
    expect(out).toContain("// note \u2014 keep me");
  });

  it("APPLIES curly vs straight quotes the same way", async () => {
    const path = "/ws/quote.ts";
    files.set(path, "const s = \u201Cdouble\u201D;\nconst t = 1;\n");
    ctx.readCache.set(path, readCacheEntry(files.get(path)!));
    const tools = batchEditModule.buildBatchEditTools(ctx);
    const result = (await tools.batch_edit.execute!(
      {
        edits: [{ path, old_string: 'const s = "double";', new_string: "const s = 1;" }],
      },
      {} as never,
    )) as { ok?: boolean; replacements?: number };
    expect(result.ok).toBe(true);
    expect(result.replacements).toBe(1);
    expect(files.get(path)).toBe("const s = 1;\nconst t = 1;\n");
  });

  it("still bounces when even the punct tier is ambiguous (multi-hit, no line_hint)", async () => {
    const path = "/ws/amb.ts";
    // TWO IDENTICAL lines that both differ from the anchor only by the
    // dash - the punct tier finds 2 hits and no line_hint: refuse.
    files.set(
      path,
      "// panel \u2014 twin\n// panel \u2014 twin\n",
    );
    ctx.readCache.set(path, readCacheEntry(files.get(path)!));
    const tools = batchEditModule.buildBatchEditTools(ctx);
    const result = (await tools.batch_edit.execute!(
      {
        edits: [{ path, old_string: "// panel - twin", new_string: "// panel x" }],
      },
      {} as never,
    )) as { ok?: boolean; error?: string };
    expect(result.ok).toBe(false);
    // Ambiguous multi-hit, not a silent write.
    expect(result.error).toContain("punctuation relaxation");
    expect(files.get(path)).toContain("\u2014");
  });

  it("multi-char variants (-> vs U+2192) match and splice the full region", async () => {
    const path = "/ws/arrow.ts";
    files.set(path, "const flow = a \u2192 b;\n");
    ctx.readCache.set(path, readCacheEntry(files.get(path)!));
    const tools = batchEditModule.buildBatchEditTools(ctx);
    // Model sends ASCII "->" where the file has the real arrow.
    const result = (await tools.batch_edit.execute!(
      {
        edits: [{ path, old_string: "const flow = a -> b;", new_string: "const flow = a \u2192 b;" }],
      },
      {} as never,
    )) as { ok?: boolean; replacements?: number };
    expect(result.ok).toBe(true);
    expect(result.replacements).toBe(1);
    expect(files.get(path)).toBe("const flow = a \u2192 b;\n");
  });

  // ── Session-evidence classes (2026-10-31 tuning) ──────────────────────────

  it("REGRESSION: a 2-char needle member vs 1-char file variant never splices leftovers (\u2192>)", async () => {
    // The old carry guard checked the FILE side's length only: needle "->"
    // matching file "\u2192" harmonized just the "-" into "\u2192" and left
    // the ">" behind, splicing "\u2192>" when the model REPEATED its own
    // variant in new_string. The both-sides guard now skips the member
    // entirely (multi-char variants never harmonize) - the edit still
    // APPLIES with the model's ASCII form, and no corruption is possible.
    const path = "/ws/arrow-repeat.ts";
    files.set(path, "// flow \u2192 here\n");
    ctx.readCache.set(path, readCacheEntry(files.get(path)!));
    const tools = batchEditModule.buildBatchEditTools(ctx);
    const result = (await tools.batch_edit.execute!(
      {
        edits: [
          {
            path,
            old_string: "// flow -> here",
            // Model repeats its own ASCII variant in the replacement.
            new_string: "// flow -> onward",
          },
        ],
      },
      {} as never,
    )) as { ok?: boolean; replacements?: number; error?: string };
    expect(result.ok).toBe(true);
    const out = files.get(path)!;
    // The corruption signature: "\u2192>" (half-harmonized arrow) must
    // never appear. The safe outcome is the model's own form, unharmonized.
    expect(out).not.toContain("\u2192>");
    expect(out).toBe("// flow -> onward\n");
  });

  it("minus sign and en-dash match the bar cluster (terminal renders them identically)", async () => {
    const path = "/ws/minus.ts";
    // U+2212 minus sign - the glyph math text uses, rendered as "-" by the
    // terminal. A hyphen needle must MATCH it (single-char members carry,
    // so the file's minus sign survives).
    files.set(path, "// temp = 25\u2212C cold\n");
    ctx.readCache.set(path, readCacheEntry(files.get(path)!));
    const tools = batchEditModule.buildBatchEditTools(ctx);
    const result = (await tools.batch_edit.execute!(
      {
        edits: [
          { path, old_string: "// temp = 25-C cold", new_string: "// temp = 25-C chilly" },
        ],
      },
      {} as never,
    )) as { ok?: boolean; replacements?: number; error?: string };
    expect(result.ok).toBe(true);
    expect(result.replacements).toBe(1);
    // Single-char member: carry harmonizes the model's hyphen to the
    // file's REAL minus sign.
    expect(files.get(path)).toContain("25\u2212C chilly");
  });

  it("ellipsis (\u2026 vs ... vs .) matches", async () => {
    const path = "/ws/ellip.ts";
    files.set(path, "// waiting\u2026 done\n");
    ctx.readCache.set(path, readCacheEntry(files.get(path)!));
    const tools = batchEditModule.buildBatchEditTools(ctx);
    const result = (await tools.batch_edit.execute!(
      {
        edits: [{ path, old_string: "// waiting... done", new_string: "// waiting... finished" }],
      },
      {} as never,
    )) as { ok?: boolean; replacements?: number };
    expect(result.ok).toBe(true);
    expect(result.replacements).toBe(1);
    // Applied; the multi-char member lands as typed (no corruption).
    expect(files.get(path)).toBe("// waiting... finished\n");
  });

  it("left-right arrow (\u2194 vs <->) matches - group names use it", async () => {
    const path = "/ws/lr.ts";
    // The group-chat default name format is "a \u2194 b" - a model reading
    // it from terminal output often sends "<->".
    files.set(path, "// alpha \u2194 beta\n");
    ctx.readCache.set(path, readCacheEntry(files.get(path)!));
    const tools = batchEditModule.buildBatchEditTools(ctx);
    const result = (await tools.batch_edit.execute!(
      {
        edits: [{ path, old_string: "// alpha <-> beta", new_string: "// alpha <-> gamma" }],
      },
      {} as never,
    )) as { ok?: boolean; replacements?: number };
    expect(result.ok).toBe(true);
    expect(result.replacements).toBe(1);
    expect(files.get(path)).toBe("// alpha <-> gamma\n");
    // Never a half-harmonized arrow.
    expect(files.get(path)).not.toContain("\u2194>");
  });

  it("middle dot vs em-dash cross-match (both render as the same ambiguous glyph)", async () => {
    const path = "/ws/dotdash.ts";
    // AiChat.tsx uses \u00B7 in real content ("3L" separator); terminal
    // output shows it as an em-dash-looking glyph. A needle carrying "-"
    // must match the file's "\u00B7", and the single-char carry keeps the
    // FILE's variant.
    files.set(path, "// stats \u00B7 3L\n");
    ctx.readCache.set(path, readCacheEntry(files.get(path)!));
    const tools = batchEditModule.buildBatchEditTools(ctx);
    const result = (await tools.batch_edit.execute!(
      {
        edits: [{ path, old_string: "// stats - 3L", new_string: "// stats - 3L total" }],
      },
      {} as never,
    )) as { ok?: boolean; replacements?: number };
    expect(result.ok).toBe(true);
    expect(result.replacements).toBe(1);
    // Single-char members on both sides: carry harmonizes the needle's
    // hyphen to the file's middle dot.
    expect(files.get(path)).toContain("\u00B7 3L total");
  });
});
