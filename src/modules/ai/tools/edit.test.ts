import { describe, expect, it, vi, beforeEach } from "vitest";

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

const applyEditsModule = await import("./edit");

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

// applyEdits is module-private; reach it through the exported tools. The
// multi_edit execute is driven through a minimal ToolContext with an
// in-memory file store so the identical-edit path runs end to end.
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

describe("multi_edit identical-edit hardening", () => {
  it("skips an identical old/new edit and applies the rest atomically", async () => {
    const path = "/ws/a.ts";
    files.set(path, "const a = 1;\nconst b = 2;\n");
    const tools = applyEditsModule.buildEditTools(ctx);
    // AI SDK v6 tool execute signature is (input, options) — pass an empty
    // second arg, and type the result loosely since execute returns unknown.
    const result = (await tools.multi_edit.execute!(
      {
        path,
        edits: [
          { old_string: "const a = 1;", new_string: "const a = 1;" }, // no-op
          { old_string: "const b = 2;", new_string: "const b = 20;" },
        ],
      },
      {} as never,
    )) as { ok?: boolean; replacements?: number; applied?: number; error?: string };
    expect(result.ok).toBe(true);
    expect(files.get(path)).toBe("const a = 1;\nconst b = 20;\n");
  });

  it("errors when the ENTIRE batch is identical no-ops", async () => {
    const path = "/ws/b.ts";
    files.set(path, "hello\n");
    const tools = applyEditsModule.buildEditTools(ctx);
    const result = (await tools.multi_edit.execute!(
      {
        path,
        edits: [{ old_string: "hello", new_string: "hello" }],
      },
      {} as never,
    )) as { ok?: boolean; error?: string };
    expect(result.ok).toBeFalsy();
    expect(result.error).toContain("no-ops");
    expect(files.get(path)).toBe("hello\n"); // untouched
  });
});
