import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../lib/native", () => ({
  native: {
    writeFile: vi.fn(),
    replaceExact: vi.fn(),
    createDir: vi.fn(),
  },
}));

const { native } = await import("../lib/native");
const { usePlanStore } = await import("./planStore");

beforeEach(() => {
  vi.clearAllMocks();
  usePlanStore.setState({ active: false, queue: [] });
});

describe("plan review byte-exact apply", () => {
  it("applies replace_exact through Rust, not a decoded-content rewrite", async () => {
    usePlanStore.getState().enqueue({
      id: "exact-1",
      kind: "replace_exact",
      path: "/ws/a.ts",
      originalContent: "a\r\n",
      proposedContent: "b\r\n",
      isNewFile: false,
      exactReplacement: {
        oldString: "a\r\n",
        newString: "b\r\n",
        expectedOccurrences: 1,
      },
    });
    const results = await usePlanStore.getState().applyAll();
    expect(results).toEqual([{ id: "exact-1", ok: true }]);
    expect(native.replaceExact).toHaveBeenCalledWith(
      "/ws/a.ts",
      "a\r\n",
      "b\r\n",
      1,
    );
    expect(native.writeFile).not.toHaveBeenCalled();
  });

  it("runs recovery completion only after a successful native apply", async () => {
    const onApplied = vi.fn();
    usePlanStore.getState().enqueue({
      id: "exact-2",
      kind: "replace_exact",
      path: "/ws/a.ts",
      originalContent: "a\r\n",
      proposedContent: "b\r\n",
      isNewFile: false,
      exactReplacement: {
        oldString: "a\r\n",
        newString: "b\r\n",
        expectedOccurrences: 1,
      },
      onApplied,
    });
    await usePlanStore.getState().applyAll();
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it("does not fall back to a decoded rewrite when exact args are absent", async () => {
    usePlanStore.setState({
      queue: [{
        id: "invalid",
        kind: "replace_exact",
        path: "/ws/a.ts",
        originalContent: "a",
        proposedContent: "b",
        isNewFile: false,
      }],
    });
    const results = await usePlanStore.getState().applyAll();
    expect(results[0]?.ok).toBe(false);
    expect(native.replaceExact).not.toHaveBeenCalled();
    expect(native.writeFile).not.toHaveBeenCalled();
  });
});