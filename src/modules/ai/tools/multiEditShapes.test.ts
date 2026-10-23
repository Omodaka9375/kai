/**
 * REGRESSION (agent token burn, filed by the user): the agent's own pasted
 * transcript shows THREE consecutive multi_edit retries burning tokens:
 *
 *   1. "The tool drops path on multi_edit.. path must live inside each edit object."
 *   2. "Stray line_hint breaks multi_edit in this harness — drop it entirely and put path in each edit."
 *   3. "multi_edit takes path inside each edit object (no outer path param) and line_hint breaks it."
 *
 * The working theory in those notes (path-per-edit required, line_hint
 * forbidden) contradicts the SOURCE schema, which accepts ALL shapes:
 * top-level path, path-per-edit, and line_hint. If the source passes every
 * shape, the failure came from a STALE RUNNING BUILD, not the code — and
 * the correct fix is a rebuild, not agent folklore. This suite pins every
 * shape so a future schema regression fails here instead of in a live
 * session where it burns tokens on retries.
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
import { buildEditTools } from "./edit";

// The mock's in-memory store, shared per test file instance.
const files = (native as unknown as { __files: Map<string, string> }).__files;

/** Fresh ctx per test — the read cache is the stale-read guard's input, and
 * carrying one test's post-write hash into the next (whose beforeEach reset
 * the file) is exactly the external-change shape the guard exists to bounce. */
function freshCtx() {
  return {
    getCwd: () => "/ws",
    getWorkspaceRoot: () => "/ws",
    getSessionId: () => "test-multi-edit-shapes",
    readCache: new Map<string, { size: number; hash: number }>(),
    fileTracker: { markModified: () => {}, markRead: () => {} },
  } as never;
}

type Edit = {
  old_string: string;
  new_string: string;
  path?: string;
  line_hint?: number;
};

/** Validate against the real zod schema, report stripped fields, execute. */
async function tryShape(input: { path?: string; edits: Edit[] }) {
  const tools = buildEditTools(freshCtx());
  const schema = tools.multi_edit.inputSchema as unknown as {
    safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { message: string } };
  };
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { valid: false, error: parsed.error?.message ?? "schema rejected input", stripped: [], result: null as never };
  }
  // Stripped-field diff: present in input, absent from parsed output.
  const stripped: string[] = [];
  for (const k of Object.keys(input)) {
    if ((parsed.data as Record<string, unknown> | undefined)?.[k] === undefined) stripped.push(k);
  }
  input.edits.forEach((e, i) => {
    const pe = ((parsed.data as { edits?: Record<string, unknown>[] } | undefined)?.edits ?? [])[i];
    for (const k of Object.keys(e)) if (pe?.[k] === undefined) stripped.push(`edits[${i}].${k}`);
  });
  const execute = tools.multi_edit.execute as unknown as (
    a: unknown,
  ) => Promise<Record<string, unknown>>;
  const result = await execute(parsed.data);
  return { valid: true, stripped, result };
}

describe("multi_edit accepts every path/line_hint call shape (no token-burn retries)", () => {
  beforeEach(() => {
    files.clear();
    files.set("/ws/scratch.txt", "alpha\nbeta\ngamma\n");
  });

  it("shape A: top-level path + line_hint per edit", async () => {
    const { valid, stripped, result } = await tryShape({
      path: "/ws/scratch.txt",
      edits: [{ old_string: "alpha", new_string: "ALPHA", line_hint: 1 }],
    });
    expect(valid).toBe(true);
    expect(stripped).toEqual([]);
    expect(result.ok).toBe(true);
    expect(files.get("/ws/scratch.txt")).toContain("ALPHA");
  });

  it("shape B: path INSIDE each edit + line_hint", async () => {
    const { valid, stripped, result } = await tryShape({
      edits: [
        { old_string: "beta", new_string: "BETA", path: "/ws/scratch.txt", line_hint: 2 },
      ],
    });
    expect(valid).toBe(true);
    expect(stripped).toEqual([]);
    expect(result.ok).toBe(true);
    expect(files.get("/ws/scratch.txt")).toContain("BETA");
  });

  it("shape C: path inside each edit, no line_hint (the folklore-required shape)", async () => {
    const { valid, stripped, result } = await tryShape({
      edits: [{ old_string: "gamma", new_string: "GAMMA", path: "/ws/scratch.txt" }],
    });
    expect(valid).toBe(true);
    expect(stripped).toEqual([]);
    expect(result.ok).toBe(true);
    expect(files.get("/ws/scratch.txt")).toContain("GAMMA");
  });

  it("shape D: BOTH top-level path AND path-per-edit (redundant)", async () => {
    const { valid, stripped, result } = await tryShape({
      path: "/ws/scratch.txt",
      edits: [{ old_string: "alpha", new_string: "A1", path: "/ws/scratch.txt" }],
    });
    expect(valid).toBe(true);
    expect(stripped).toEqual([]);
    expect(result.ok).toBe(true);
    expect(files.get("/ws/scratch.txt")).toContain("A1");
  });

  it("gives the precise 'path is required' error when NO path is given anywhere", async () => {
    const { result } = await tryShape({
      edits: [{ old_string: "x", new_string: "y" }],
    });
    expect(result.ok).toBeUndefined();
    expect(result.error).toBe("path is required");
  });
});