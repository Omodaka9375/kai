import { beforeEach, describe, expect, it, vi } from "vitest";
import { readCacheEntry } from "../lib/hash";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../lib/native", () => ({
  native: {
    readFile: vi.fn(),
    replaceExact: vi.fn(),
    writeFile: vi.fn(),
    canonicalize: vi.fn(async (path: string) => path),
  },
}));
vi.mock("../lib/security", () => ({
  checkReadableCanonical: vi.fn(async (path: string) => ({ ok: true, canonical: path })),
  checkWritableCanonical: vi.fn(async (path: string) => ({ ok: true, canonical: path })),
}));
vi.mock("../lib/checkpoints", () => ({
  createCheckpointBatch: vi.fn(() => ({})),
  snapshotFileForBatch: vi.fn(async () => {}),
  commitCheckpointBatch: vi.fn(async () => {}),
}));
const { planState, planEnqueue } = vi.hoisted(() => ({
  planState: { active: false },
  planEnqueue: vi.fn(),
}));
vi.mock("../store/planStore", () => ({
  newQueuedEditId: () => "q-test",
  usePlanStore: {
    getState: () => ({ active: planState.active, enqueue: planEnqueue }),
  },
}));

vi.stubGlobal("window", { dispatchEvent: () => true });
vi.stubGlobal("CustomEvent", class {
  constructor(
    public type: string,
    public init: { detail?: unknown } = {},
  ) {}
});

const nativeModule = await import("../lib/native");
const checkpoints = await import("../lib/checkpoints");
const { buildReplaceExactTools } = await import("./replaceExact");
const { getEditFailures } = await import("./edit");
const native = nativeModule.native as unknown as {
  readFile: ReturnType<typeof vi.fn>;
  replaceExact: ReturnType<typeof vi.fn>;
  canonicalize: ReturnType<typeof vi.fn>;
};

function context(root = "/ws") {
  return {
    getCwd: () => root,
    getWorkspaceRoot: () => root,
    getSessionId: () => "test-replace-exact",
    readCache: new Map(),
    fileTracker: { markRead: vi.fn(), markModified: vi.fn() },
  } as unknown as import("./context").ToolContext;
}

function call(
  tool: ReturnType<typeof buildReplaceExactTools>["replace_exact"],
  input: {
    path: string;
    old_string: string;
    new_string: string;
    expected_occurrences?: number;
  },
): Promise<Record<string, unknown>> {
  return (tool.execute as unknown as (
    args: typeof input,
    options: { toolCallId: string; messages: never[] },
  ) => Promise<Record<string, unknown>>)(input, { toolCallId: "test", messages: [] });
}

beforeEach(() => {
  vi.clearAllMocks();
  planState.active = false;
  native.readFile.mockImplementation(async () => ({
    kind: "text",
    content: "first\r\nold\r\nlast",
    size: 20,
  }));
  native.replaceExact.mockResolvedValue({ replacements: 1, bytesWritten: 20 });
});

describe("replace_exact recovery and byte-preserving native contract", () => {
  it("refuses normal editing before edit/batch_edit has failed", async () => {
    const ctx = context();
    const tools = buildReplaceExactTools(ctx);
    const result = await call(tools.replace_exact, {
      path: "/ws/a.ts",
      old_string: "old",
      new_string: "new",
    });
    expect(result.error).toContain("recovery-only");
    expect(native.replaceExact).not.toHaveBeenCalled();
  });

  it("passes literal strings and the exact count to Rust after a failure", async () => {
    const ctx = context();
    getEditFailures(ctx).set("/ws/a.ts", 3);
    const tools = buildReplaceExactTools(ctx);
    const result = await call(tools.replace_exact, {
      path: "/ws/a.ts",
      old_string: "old\r\n",
      new_string: "new\r\n",
      expected_occurrences: 1,
    });
    expect(native.replaceExact).toHaveBeenCalledWith(
      "/ws/a.ts",
      "old\r\n",
      "new\r\n",
      1,
    );
    expect(result.ok).toBe(true);
    expect(result.bytesWritten).toBe(20);
    expect(getEditFailures(ctx).has("/ws/a.ts")).toBe(false);
    expect(ctx.fileTracker.markModified).toHaveBeenCalledWith("/ws/a.ts");
    expect(checkpoints.commitCheckpointBatch).toHaveBeenCalled();
  });

  it("refreshes the read cache from disk after the byte write", async () => {
    const ctx = context();
    getEditFailures(ctx).set("/ws/a.ts", 1);
    const updated = "new\r\n";
    native.readFile
      .mockResolvedValueOnce({ kind: "text", content: "old\r\n", size: 5 })
      .mockResolvedValueOnce({ kind: "text", content: "old\r\n", size: 5 })
      .mockResolvedValueOnce({ kind: "text", content: updated, size: 5 });
    const tools = buildReplaceExactTools(ctx);
    await call(tools.replace_exact, {
      path: "/ws/a.ts",
      old_string: "old",
      new_string: "new",
    });
    expect(ctx.readCache.get("/ws/a.ts")).toEqual(readCacheEntry(updated));
  });

  it("returns the native ambiguity diagnostic without committing", async () => {
    const ctx = context();
    getEditFailures(ctx).set("/ws/a.ts", 1);
    native.replaceExact.mockRejectedValue(
      "old_string matched 2 exact UTF-8 byte occurrence(s) (byte offsets: 0, 4); expected 1. Nothing was changed.",
    );
    const tools = buildReplaceExactTools(ctx);
    const result = await call(tools.replace_exact, {
      path: "/ws/a.ts",
      old_string: "old",
      new_string: "new",
    });
    expect(result.changed).toBe(false);
    expect(result.error).toContain("matched 2");
    expect(checkpoints.commitCheckpointBatch).not.toHaveBeenCalled();
  });

  it("refuses a no-op without touching native code", async () => {
    const ctx = context();
    const tools = buildReplaceExactTools(ctx);
    const result = await call(tools.replace_exact, {
      path: "/ws/a.ts",
      old_string: "same",
      new_string: "same",
    });
    expect(result.changed).toBe(false);
    expect(result.error).toContain("identical");
    expect(native.replaceExact).not.toHaveBeenCalled();
  });

  it("enforces a 1..1000 occurrence bound in the schema", async () => {
    const tools = buildReplaceExactTools(context());
    const schema = tools.replace_exact.inputSchema as unknown as {
      safeParse: (input: unknown) => { success: boolean };
    };
    const base = { path: "a.ts", old_string: "x", new_string: "y" };
    expect(schema.safeParse({ ...base, expected_occurrences: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...base, expected_occurrences: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ ...base, expected_occurrences: 1001 }).success).toBe(false);
    expect(schema.safeParse({ ...base, expected_occurrences: 1000 }).success).toBe(true);
  });

  it("queues plan review without writing and preserves exact replacement args", async () => {
    const ctx = context();
    getEditFailures(ctx).set("/ws/a.ts", 1);
    native.readFile.mockResolvedValue({
      kind: "text",
      content: "x\r\nx\r\n",
      size: 8,
    });
    planState.active = true;
    const tools = buildReplaceExactTools(ctx);
    const result = await call(tools.replace_exact, {
      path: "/ws/a.ts",
      old_string: "x\r\n",
      new_string: "y\r\n",
      expected_occurrences: 2,
    });
    expect(result.queued).toBe(true);
    expect(planEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: "replace_exact",
      exactReplacement: {
        oldString: "x\r\n",
        newString: "y\r\n",
        expectedOccurrences: 2,
      },
    }));
    // Plan mode NEVER calls the native byte mutation — no write path runs
    // until the user accepts the review.
    expect(native.replaceExact).not.toHaveBeenCalled();
    expect(getEditFailures(ctx).has("/ws/a.ts")).toBe(true);
    expect(checkpoints.commitCheckpointBatch).not.toHaveBeenCalled();
  });

  it("plan mode bounces on an occurrence-count mismatch without queuing", async () => {
    const ctx = context();
    getEditFailures(ctx).set("/ws/a.ts", 1);
    native.readFile.mockResolvedValue({
      kind: "text",
      content: "x\r\nx\r\n",
      size: 8,
    });
    planState.active = true;
    const tools = buildReplaceExactTools(ctx);
    const result = await call(tools.replace_exact, {
      path: "/ws/a.ts",
      old_string: "x\r\n",
      new_string: "y\r\n",
      expected_occurrences: 3,
    });
    expect(result.changed).toBe(false);
    expect(result.error).toContain("matched 2");
    expect(planEnqueue).not.toHaveBeenCalled();
    expect(native.replaceExact).not.toHaveBeenCalled();
  });

  it("requires explicit approval and has presentation metadata", async () => {
    const tools = buildReplaceExactTools(context());
    expect(tools.replace_exact.needsApproval).toBe(true);
    const { presentationFor } = await import("../lib/toolPresentations");
    expect(presentationFor("replace_exact").approvalLabel).toContain("recovery");
  });
});