import { beforeEach, describe, expect, it, vi } from "vitest";
import { readCacheEntry } from "../lib/hash";

// The truncation guard spans fs.ts read_file + write_file. Both run real
// logic through mocked Tauri/native modules (same harness pattern as
// edit.test.ts): an in-memory file store, identity canonicalize, and
// permissive security gates — the guard under test is coverage tracking,
// not the safety deny-lists.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../lib/native", () => ({
  native: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    canonicalize: vi.fn(async (p: string) => p),
    createDir: vi.fn(async () => {}),
  },
}));
vi.mock("../lib/security", () => ({
  checkReadableCanonical: vi.fn(async (p: string) => ({ ok: true as const, canonical: p })),
  checkWritableCanonical: vi.fn(async (p: string) => ({ ok: true as const, canonical: p })),
}));

// write_file dispatches a `Kai:fs-changed` CustomEvent on window; Node has
// neither. Stub both before any tool runs. (plan store import chain needs
// window too.)
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

const fsToolsModule = await import("./fs");
const nativeMod = await import("../lib/native");

type FileStore = Map<string, string>;
const files: FileStore = new Map();

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

function makeCtx(): import("./context").ToolContext {
  return {
    getCwd: () => "/ws",
    getWorkspaceRoot: () => "/ws",
    getSessionId: () => "test-session",
    readCache: new Map(),
    fileTracker: { markRead: () => {}, markModified: () => {} },
  } as unknown as import("./context").ToolContext;
}

type LooseResult = { ok?: boolean; error?: string; truncated?: boolean };

// AI SDK Tool types are invariant in their input; erase them like edit.test.ts.
type AnyTool = { execute: (input: never, opts: never) => Promise<unknown> };
const exec = (tool: unknown, input: unknown) =>
  (tool as AnyTool).execute(input as never, {} as never) as Promise<LooseResult>;

describe("write_file partial-view truncation guard", () => {
  it("REFUSES to overwrite after a truncated full-read (line cap)", async () => {
    const ctx = makeCtx();
    const path = "/ws/big.ts";
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    files.set(path, big);
    const tools = fsToolsModule.buildFsTools(ctx);

    const read = await exec(tools.read_file, { path });
    expect(read.truncated).toBe(true); // line cap hit → partial view

    const write = await exec(tools.write_file, {
      path,
      content: "replaced with partial view",
    });
    expect(write.ok).toBeFalsy();
    expect(write.error).toContain("truncated");
    expect(files.get(path)).toBe(big); // disk untouched — data preserved
  });

  it("REFUSES to overwrite after the unchanged-preview path", async () => {
    const ctx = makeCtx();
    const path = "/ws/medium.ts";
    const medium = Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n");
    files.set(path, medium);
    const tools = fsToolsModule.buildFsTools(ctx);

    await exec(tools.read_file, { path }); // establishes cache
    const reread = await exec(tools.read_file, { path }); // unchanged preview
    expect((reread as { unchanged?: boolean }).unchanged).toBe(true);

    const write = await exec(tools.write_file, { path, content: "x" });
    expect(write.ok).toBeFalsy();
    expect(write.error).toContain("truncated");
  });

  it("ALLOWS overwrite after a full (non-truncated) read", async () => {
    const ctx = makeCtx();
    const path = "/ws/small.ts";
    files.set(path, "a\nb\nc\n");
    const tools = fsToolsModule.buildFsTools(ctx);

    await exec(tools.read_file, { path });
    const write = await exec(tools.write_file, {
      path,
      content: "new content\n",
    });
    expect(write.ok).toBe(true);
    expect(files.get(path)).toBe("new content\n");
  });

  it("ALLOWS overwrite of a file the model never read (new-file case)", async () => {
    const ctx = makeCtx();
    const path = "/ws/brand-new.ts";
    const tools = fsToolsModule.buildFsTools(ctx);

    const write = await exec(tools.write_file, {
      path,
      content: "fresh\n",
    });
    expect(write.ok).toBe(true);
    expect(files.get(path)).toBe("fresh\n");
  });

  it("ALLOWS overwrite after paged reads cover the whole file", async () => {
    const ctx = makeCtx();
    const path = "/ws/paged.ts";
    // > READ_LINE_CAP so paging is required; pages then cover the file.
    const lines = Array.from({ length: 60 }, (_, i) => `p${i}`);
    files.set(path, lines.join("\n"));
    const tools = fsToolsModule.buildFsTools(ctx);

    // Page through: page 1 = [0, 30), page 2 = [30, 60).
    await exec(tools.read_file, { path, offset: 0, limit: 30 });
    await exec(tools.read_file, { path, offset: 30, limit: 30 });
    const write = await exec(tools.write_file, {
      path,
      content: lines.map((l) => l.toUpperCase()).join("\n"),
    });
    expect(write.ok).toBe(true);
    expect(files.get(path)).toContain("P0");
  });

  it("ALLOWS overwrite after an out-of-band full cache entry (mutation path)", async () => {
    const ctx = makeCtx();
    const path = "/ws/after-edit.ts";
    files.set(path, "one\ntwo\n");
    const tools = fsToolsModule.buildFsTools(ctx);

    // edit/multi_edit/applyEdits write full-content cache entries (no
    // coverage field) — write_file must stay allowed after them.
    ctx.readCache.set(path, readCacheEntry("one\ntwo\n"));
    const write = await exec(tools.write_file, {
      path,
      content: "three\n",
    });
    expect(write.ok).toBe(true);
  });
});
