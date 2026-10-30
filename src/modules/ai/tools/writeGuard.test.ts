import { describe, expect, it, vi, beforeEach } from "vitest";
import { readCacheEntry, READ_BYTE_CAP } from "../lib/hash";

// Same stub contract as edit.test.ts: no Tauri IPC in Node; the pure
// guard/coverage paths under test never touch real native code.
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

const fsModule = await import("./fs");
const nativeMod = await import("../lib/native");

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

// In-memory file store backing the native stubs.
const files = new Map<string, string>();

const ctx = {
  getCwd: () => "/ws",
  getWorkspaceRoot: () => "/ws",
  getRealWorkspaceRoot: () => "/ws",
  getSessionId: () => "test-session",
  readCache: new Map(),
  fileTracker: { markRead: () => {}, markModified: () => {} },
} as unknown as import("./context").ToolContext;

beforeEach(() => {
  files.clear();
  ctx.readCache.clear();
  (nativeMod.native.readFile as ReturnType<typeof vi.fn>).mockImplementation(
    async (p: string) => {
      const content = files.get(p);
      if (content === undefined) throw new Error("ENOENT");
      return { kind: "text" as const, content, size: content.length };
    },
  );
  (nativeMod.native.writeFile as ReturnType<typeof vi.fn>).mockImplementation(
    async (p: string, content: string) => {
      files.set(p, content);
    },
  );
});

describe("read_file page coverage converges for files over the 25KB cap", () => {
  // ~30KB: every FULL read is byte-capped, so the model must page. Build
  // lines ~60 bytes so a 25KB page holds roughly 420 of them.
  const lineCount = 500;
  const bigFile = Array.from(
    { length: lineCount },
    (_, i) => `line ${i} ${"x".repeat(55)}`,
  ).join("\n");

  it("full read of an over-cap file records partial coverage with a resume offset", async () => {
    files.set("/ws/big.ts", bigFile);
    const tools = fsModule.buildFsTools(ctx);
    const r = (await tools.read_file.execute!(
      { path: "/ws/big.ts" },
      {} as never,
    )) as { truncated?: boolean; hint?: string; total_lines?: number };

    expect(r.truncated).toBe(true);
    expect(r.hint).toContain("offset:");
    // The hint must name a REAL resume point (a number), not just "offset".
    const m = r.hint?.match(/offset:\s*(\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(0);

    const entry = ctx.readCache.get("/ws/big.ts") as {
      coverage?: { full: boolean; lines: number; seenThrough: number };
    };
    expect(entry.coverage?.full).toBe(false);
    expect(entry.coverage!.seenThrough).toBeGreaterThan(0);
  });

  it("paging through the file accumulates coverage to full and then allows write_file", async () => {
    files.set("/ws/big.ts", bigFile);
    const tools = fsModule.buildFsTools(ctx);
    // Page with explicit offset+limit until untruncated; each page's hint
    // carries the next offset. Cap iterations so a regression can't hang.
    let offset: number | undefined = undefined;
    let pages = 0;
    for (;;) {
      const r = (await tools.read_file.execute!(
        { path: "/ws/big.ts", ...(offset !== undefined ? { offset } : {}), limit: 200 },
        {} as never,
      )) as { truncated?: boolean; hint?: string };
      pages++;
      if (!r.truncated) break;
      expect(pages).toBeLessThan(50);
      const m = r.hint?.match(/offset:\s*(\d+)/) ?? null;
      // Paged branch returns start_line/end_line; compute next from either.
      if (m) offset = Number(m[1]);
      else break;
    }
    const entry = ctx.readCache.get("/ws/big.ts") as {
      coverage?: { full: boolean };
    };
    expect(entry.coverage?.full).toBe(true);

    // THE DEADLOCK REGRESSION: with full coverage, write_file must now be
    // allowed to replace the file (it used to refuse forever).
    const w = (await tools.write_file.execute!(
      { path: "/ws/big.ts", content: "replaced entirely" },
      {} as never,
    )) as { ok?: boolean; error?: string; bytesWritten?: number };
    expect(w.ok).toBe(true);
    expect(files.get("/ws/big.ts")).toBe("replaced entirely");
  });
});

describe("write_file partial-view guard vs deleted files", () => {
  it("refuses to overwrite from a truncated view while the file exists", async () => {
    files.set("/ws/partial.ts", "a\n".repeat(3000));
    const tools = fsModule.buildFsTools(ctx);
    await tools.read_file.execute!({ path: "/ws/partial.ts" }, {} as never);
    const w = (await tools.write_file.execute!(
      { path: "/ws/partial.ts", content: "new" },
      {} as never,
    )) as { ok?: boolean; error?: string };
    expect(w.ok).toBeFalsy();
    expect(w.error).toContain("truncated");
    // The refusal must now name WHERE to resume - the model's escape route.
    expect(w.error).toMatch(/offset:\s*\d+/);
    expect(w.error).toContain("3001 lines"); // trailing \n adds one line
  });

  it("allows writing a file that was deleted after the last (partial) read", async () => {
    // THE MISSING-FILE DEADLOCK: file read (capped), then deleted on disk.
    // A brand-new write to the same path must NOT be blocked by the stale
    // cache entry - there is no unseen portion to destroy anymore.
    files.set("/ws/gone.ts", "z\n".repeat(3000));
    const tools = fsModule.buildFsTools(ctx);
    await tools.read_file.execute!({ path: "/ws/gone.ts" }, {} as never);
    const entryBefore = ctx.readCache.get("/ws/gone.ts");
    expect((entryBefore as { coverage?: { full: boolean } }).coverage?.full).toBe(false);

    files.delete("/ws/gone.ts"); // external deletion
    const w = (await tools.write_file.execute!(
      { path: "/ws/gone.ts", content: "fresh content" },
      {} as never,
    )) as { ok?: boolean; error?: string };
    expect(w.ok).toBe(true);
    expect(files.get("/ws/gone.ts")).toBe("fresh content");
    // The stale entry was dropped, not left behind to wedge the next write.
    expect(ctx.readCache.has("/ws/gone.ts")).toBe(true); // replaced by the write
    const entryAfter = ctx.readCache.get("/ws/gone.ts") as { coverage?: unknown };
    expect(entryAfter.coverage).toBeUndefined();
  });
});

describe("hash exports one shared byte cap", () => {
  it("READ_BYTE_CAP is the 25KB read page size", () => {
    expect(READ_BYTE_CAP).toBe(25 * 1024);
    expect(readCacheEntry("x")).toEqual({ size: 1, hash: expect.any(Number) });
  });
});
