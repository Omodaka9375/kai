/**
 * Whitespace-tolerant edit fallback (Aider-style).
 *
 * Exact-match-first stays the contract; these pin what happens when the
 * model's old_string differs from the file ONLY in whitespace:
 *   - trailing whitespace, tab-vs-space indent, collapsed inner runs
 * are now absorbed instead of burning a retry — AND the splice must
 * replace the file's TRUE region. The predecessor mapped a relaxed match
 * back to a start offset but spliced needle-length bytes, so a
 * 2-space-indented needle against a tab-indented line ate the newline and
 * the next line's head (silent corruption through the fallback path).
 * Multi-hit relaxed matches bounce (never a coin flip) with line numbers;
 * line_hint picks nearest; replace_all replaces every relaxed hit.
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

const files = (native as unknown as { __files: Map<string, string> }).__files;

function freshCtx() {
  return {
    getCwd: () => "/ws",
    getWorkspaceRoot: () => "/ws",
    getSessionId: () => "test-fuzzy-edit",
    readCache: new Map<string, { size: number; hash: number }>(),
    fileTracker: { markModified: () => {}, markRead: () => {} },
  } as never;
}

async function runEdit(input: {
  path?: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  line_hint?: number;
}) {
  const tools = buildEditTools(freshCtx());
  const execute = tools.edit.execute as unknown as (
    a: unknown,
  ) => Promise<Record<string, unknown>>;
  return execute(input);
}

describe("whitespace-tolerant fallback", () => {
  beforeEach(() => {
    files.clear();
  });

  it("trailing-whitespace drift: 2-space needle matches 4-space file line", async () => {
    // Tab/space depth differs → level 2 (tabs→2sp) or level 3 (collapse).
    files.set("/ws/a.ts", "function f() {\n\t\treturn 1;\n}\n");
    const r = await runEdit({
      path: "/ws/a.ts",
      old_string: "  return 1;", // two spaces, file has two tabs
      new_string: "  return 2;",
    });
    expect(r.ok).toBe(true);
    // The splice consumed the FILE's line (both tab chars), not the
    // needle's length — the brace line after must be intact.
    expect(files.get("/ws/a.ts")).toBe("function f() {\n  return 2;\n}\n");
  });

  it("inner-whitespace drift: collapsed needle matches spread-out file line", async () => {
    files.set("/ws/b.ts", "const x   =   1;\nnext();\n");
    const r = await runEdit({
      path: "/ws/b.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    });
    expect(r.ok).toBe(true);
    expect(files.get("/ws/b.ts")).toBe("const x = 2;\nnext();\n");
  });

  it("relaxed multi-hit BOUNCES with line numbers (no coin flip, no writes)", async () => {
    files.set(
      "/ws/c.ts",
      "if (a) {\n\tfoo();\n}\nif (b) {\n\tfoo();\n}\n",
    );
    const before = files.get("/ws/c.ts");
    const r = await runEdit({
      path: "/ws/c.ts",
      old_string: "  foo();", // 2 spaces — matches BOTH tab lines loosely
      new_string: "  bar();",
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("matched 2 locations");
    expect(String(r.error)).toContain("line_hint");
    expect(files.get("/ws/c.ts")).toBe(before); // untouched
  });

  it("relaxed multi-hit + line_hint picks the NEAREST occurrence", async () => {
    files.set(
      "/ws/d.ts",
      "if (a) {\n\tfoo();\n}\nif (b) {\n\tfoo();\n}\n",
    );
    const r = await runEdit({
      path: "/ws/d.ts",
      old_string: "  foo();",
      new_string: "  bar();",
      line_hint: 6,
    });
    expect(r.ok).toBe(true);
    const out = files.get("/ws/d.ts")!;
    // Only the SECOND foo() (line 5) changed; the first stays a tab line.
    expect(out).toBe("if (a) {\n\tfoo();\n}\nif (b) {\n  bar();\n}\n");
  });

  it("replace_all with drift relaxes across ALL hits (no exact match present)", async () => {
    // Every line has a DRIFTED run (double space) so the exact pass finds
    // zero and replace_all falls through to the relaxed multi-replace.
    // (When an exact match DOES exist it takes priority — relaxation is a
    // not-found fallback, never a way to mix exact + fuzzy in one call.)
    files.set("/ws/e.ts", "x =  1;\ny =  1;\nz =  1;\n");
    const tools = buildEditTools(freshCtx());
    const execute = tools.edit.execute as unknown as (
      a: unknown,
    ) => Promise<Record<string, unknown>>;
    const r = await execute({
      path: "/ws/e.ts",
      old_string: "= 1;", // single space — drifts against all three "=  1;"
      new_string: "= 2;",
      replace_all: true,
    });
    expect(r.ok).toBe(true);
    expect(r.replacements).toBe(3);
    expect(files.get("/ws/e.ts")).toBe("x = 2;\ny = 2;\nz = 2;\n");
  });

  it("exact match still preferred: no relaxation shadowing", async () => {
    // Both a tab line and a space line exist; the needle EXACTLY equals the
    // space line. Level-order must not silently prefer the earlier tab hit —
    // exact indexOf runs first and wins unambiguously.
    files.set("/ws/f.ts", "\tgo();\n  go();\n");
    const r = await runEdit({
      path: "/ws/f.ts",
      old_string: "  go();",
      new_string: "  stay();",
    });
    expect(r.ok).toBe(true);
    expect(files.get("/ws/f.ts")).toBe("\tgo();\n  stay();\n");
  });

  it("genuinely absent old_string still errors with did-you-mean", async () => {
    files.set("/ws/g.ts", "hello world\n");
    const r = await runEdit({
      path: "/ws/g.ts",
      old_string: "completely different",
      new_string: "x",
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("not found");
  });
});