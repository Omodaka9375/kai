/**
 * batch_edit CONTRACT SUITE — the consolidated multi-edit tool.
 *
 * History: the retired multi_edit had a top-level `path` + strict schema
 * that REJECTED per-edit paths — the exact shape models reach for by
 * default and the one batch_edit uses. Every natural call bounced with a
 * schema-validation error; models burned retries and fell back to other
 * tools. The consolidation keeps batch_edit's per-edit-path shape and
 * ports multi_edit's engine (fuzzy matcher, replace_all, line_hint,
 * stale-read guard) into it.
 *
 * This suite pins:
 *   1. The canonical shape: edits[] with per-edit path — several files or
 *      several edits to one file, both valid.
 *   2. Cross-file atomicity: any failure writes NOTHING (no in-memory
 *      "rollback" that writes partial compounds).
 *   3. Same-file compounding: sequential edits to one path apply in order.
 *   4. line_hint + replace_all survive the schema (were silently dropped
 *      in the old batch_edit schema).
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

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
      deleteFile: vi.fn(async (p: string) => {
        files.delete(p);
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
vi.mock("../store/planStore", () => ({
  usePlanStore: { getState: () => ({ active: false }) },
  newQueuedEditId: () => "qe-test",
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
import { buildBatchEditTools } from "./batchEdit";

const files = (native as unknown as { __files: Map<string, string> }).__files;

function freshCtx() {
  return {
    getCwd: () => "/ws",
    getWorkspaceRoot: () => "/ws",
    getSessionId: () => "test-batch-edit-shapes",
    readCache: new Map<string, { size: number; hash: number }>(),
    fileTracker: { markModified: () => {}, markRead: () => {} },
  } as never;
}

type Edit = {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  line_hint?: number;
};

async function tryShape(input: { edits: Edit[] }) {
  const tools = buildBatchEditTools(freshCtx());
  const schema = tools.batch_edit.inputSchema as unknown as {
    safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { message: string } };
  };
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { valid: false, error: parsed.error?.message ?? "schema rejected input", result: null as never };
  }
  const execute = tools.batch_edit.execute as unknown as (
    a: unknown,
  ) => Promise<Record<string, unknown>>;
  const result = await execute(parsed.data);
  return { valid: true, result };
}

describe("batch_edit canonical schema and atomic failures", () => {
  beforeEach(() => {
    files.clear();
    files.set("/ws/scratch.txt", "alpha\nbeta\ngamma\n");
    files.set("/ws/other.txt", "one\ntwo\n");
  });

  it("several files, one edit each — the canonical multi-file shape", async () => {
    const { valid, result } = await tryShape({
      edits: [
        { path: "/ws/scratch.txt", old_string: "alpha", new_string: "ALPHA" },
        { path: "/ws/other.txt", old_string: "one", new_string: "ONE" },
      ],
    });
    expect(valid).toBe(true);
    expect(result.ok).toBe(true);
    expect(files.get("/ws/scratch.txt")).toContain("ALPHA");
    expect(files.get("/ws/other.txt")).toContain("ONE");
  });

  it("several edits to ONE file — the retired multi_edit's job, same tool", async () => {
    const { valid, result } = await tryShape({
      edits: [
        { path: "/ws/scratch.txt", old_string: "alpha", new_string: "A1" },
        { path: "/ws/scratch.txt", old_string: "beta", new_string: "B2" },
        { path: "/ws/scratch.txt", old_string: "gamma", new_string: "C3" },
      ],
    });
    expect(valid).toBe(true);
    expect(result.ok).toBe(true);
    expect(files.get("/ws/scratch.txt")).toBe("A1\nB2\nC3\n");
  });

  it("same-file edits compound in order (later edit sees earlier result)", async () => {
    const { valid, result } = await tryShape({
      edits: [
        { path: "/ws/scratch.txt", old_string: "alpha", new_string: "ALPHA" },
        { path: "/ws/scratch.txt", old_string: "ALPHA\nbeta", new_string: "DONE" },
      ],
    });
    expect(valid).toBe(true);
    expect(result.ok).toBe(true);
    expect(files.get("/ws/scratch.txt")).toBe("DONE\ngamma\n");
  });

  it("replace_all and line_hint survive the schema (were stripped pre-consolidation)", async () => {
    const { valid, result } = await tryShape({
      edits: [
        { path: "/ws/scratch.txt", old_string: "a", new_string: "z", replace_all: true, line_hint: 1 },
      ],
    });
    expect(valid).toBe(true);
    // 'a' appears in alpha/beta/gamma — replace_all rewrites EVERY
    // occurrence (both a's in alpha too).
    expect(result.ok).toBe(true);
    expect(files.get("/ws/scratch.txt")).toBe("zlphz\nbetz\ngzmmz\n");
  });

  it("rejects an empty edits array", async () => {
    const { valid } = await tryShape({ edits: [] });
    expect(valid).toBe(false);
  });

  it("rejects an edit missing its path (path lives INSIDE each edit)", async () => {
    const tools = buildBatchEditTools(freshCtx());
    const schema = tools.batch_edit.inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    const parsed = schema.safeParse({
      edits: [{ old_string: "alpha", new_string: "A" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("cross-file atomicity: failure on file 2 writes NEITHER file", async () => {
    const { valid, result } = await tryShape({
      edits: [
        { path: "/ws/scratch.txt", old_string: "alpha", new_string: "ALPHA" },
        { path: "/ws/other.txt", old_string: "NO SUCH TEXT", new_string: "X" },
      ],
    });
    expect(valid).toBe(true);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("No changes were written");
    expect(files.get("/ws/scratch.txt")).toBe("alpha\nbeta\ngamma\n");
    expect(files.get("/ws/other.txt")).toBe("one\ntwo\n");
  });
});
