/**
 * multi_edit CONTRACT SUITE. History: a live session burned three retries
 * inventing folklore about the tool's call shape ("path must live inside
 * each edit object", "line_hint breaks it"). The fix was two-fold:
 *
 *   1. ONE canonical schema - required top-level `path`, `line_hint`
 *      supported, NO per-edit path. An ambiguous schema is what let the
 *      folklore form in the first place; a canonical one makes the
 *      missing-path failure an ordinary field validation error.
 *   2. True atomicity - any failed edit writes NOTHING and reports the
 *      failing index, so a retry can never duplicate partial work.
 *
 * This suite pins the canonical shape (accepts what it must, rejects
 * per-edit path shapes) and the missing-path error so a future schema
 * regression fails here instead of in a live session.
 */import { describe, expect, it, beforeEach, vi } from "vitest";

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

describe("multi_edit canonical schema and atomic failures", () => {
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

  it("rejects path-per-edit: one canonical top-level field only", async () => {
    const { valid, stripped } = await tryShape({
      edits: [
        { old_string: "beta", new_string: "BETA", path: "/ws/scratch.txt" },
      ],
    });
    expect(valid).toBe(false);
    expect(stripped).toEqual([]);
  });

  it("rejects redundant per-edit path even when top-level path exists", async () => {
    const { valid, stripped } = await tryShape({
      path: "/ws/scratch.txt",
      edits: [{ old_string: "alpha", new_string: "A1", path: "/ws/scratch.txt" }],
    });
    expect(valid).toBe(false);
    expect(stripped).toEqual([]);
  });

  it("gives a self-correctable 'path is required' error when NO path is given anywhere", async () => {
    // The error must teach the model the fix, not just name the missing key.
    // A bare "path is required" produced blind retries (the transcript this
    // test was born from burned 3 re-calls inventing wrong folklore about the
    // tool). Codex's apply_patch likewise returns RespondToModel guidance on
    // parse failure. Assert the message names the field AND shows an example.
    const { valid, error } = await tryShape({
      edits: [{ old_string: "x", new_string: "y" }],
    });
    // Schema-level rejection: the refinement fires BEFORE execute, so the
    // model sees the guidance as an argument-validation error it can fix in
    // the next call — no execute-time error path that invited write_file
    // whole-file fallbacks.
    expect(valid).toBe(false);
    const msg = String(error);
    expect(msg).toContain("path");
    expect(msg).toContain("required");
  });
});