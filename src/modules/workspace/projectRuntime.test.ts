import { describe, expect, it, vi } from "vitest";
import { createProjectRuntime } from "./projectRuntime";
import { allocateWorkspaceTabIds } from "@/modules/tabs/lib/idAllocator";
import { scopedPath } from "@/modules/ai/lib/sessions";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("project runtime identity", () => {
  it("preserves case-sensitive execution roots while folding only identity", () => {
    const runtime = createProjectRuntime("/home/me/Foo", { kind: "wsl", distro: "Ubuntu" });
    expect(runtime.root).toBe("/home/me/Foo");
    expect(runtime.id).toContain("/home/me/foo");
  });

  it("includes local/WSL distro in identity and preserves local history paths", () => {
    const local = createProjectRuntime("D:\\Code\\Demo");
    const ubuntu = createProjectRuntime("/home/me/demo", { kind: "wsl", distro: "Ubuntu" });
    const debian = createProjectRuntime("/home/me/demo", { kind: "wsl", distro: "Debian" });
    expect(local.id).toBe("local:d:/code/demo");
    expect(ubuntu.id).not.toBe(debian.id);
    expect(scopedPath(ubuntu.root, ubuntu.env)).not.toBe(scopedPath(debian.root, debian.env));
    expect(scopedPath(local.root)).toBe(scopedPath(local.root, local.env));
  });

  it("binds native calls to the captured environment, not the visible project", async () => {
    const runtime = createProjectRuntime("/home/me/demo", { kind: "wsl", distro: "Ubuntu" });
    const { invoke } = await import("@tauri-apps/api/core");
    const mocked = vi.mocked(invoke);
    mocked.mockResolvedValueOnce({ kind: "text", content: "{}", mtime: 0, size: 2 });
    await runtime.native.readFile("/home/me/demo/package.json");
    expect(mocked).toHaveBeenLastCalledWith("fs_read_file", {
      path: "/home/me/demo/package.json",
      extract: false,
      workspace: { kind: "wsl", distro: "Ubuntu" },
    });
    await createProjectRuntime("D:/Other").native.readFile("D:/Other/package.json");
    // A later call from another project cannot mutate the first client's env.
    await runtime.native.readFile("/home/me/demo/package.json");
    expect(mocked).toHaveBeenLastCalledWith("fs_read_file", {
      path: "/home/me/demo/package.json",
      extract: false,
      workspace: { kind: "wsl", distro: "Ubuntu" },
    });
  });
});

describe("multi-project tab identity", () => {
  it("allocates process-wide terminal/leaf IDs", () => {
    const a = allocateWorkspaceTabIds();
    const b = allocateWorkspaceTabIds();
    expect(b).toBeGreaterThan(a);
  });
});
