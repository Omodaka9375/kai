import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Source contracts for external-deletion refresh behavior. The actual IPC
 *  read is native; these pins keep the refresh from regressing to root-only
 *  or letting a late response from a previous project resurrect its tree. */
describe("file tree external deletion refresh", () => {
  const tree = readFileSync(new URL("./useFileTree.ts", import.meta.url), "utf8");
  const explorer = readFileSync(new URL("../FileExplorer.tsx", import.meta.url), "utf8");

  it("reloads every already-loaded directory, including expanded children", () => {
    const refresh = tree.slice(
      tree.indexOf("const refreshAll = useCallback"),
      tree.indexOf("// --- mutations ---"),
    );
    expect(refresh).toContain("Object.entries(nodesRef.current)");
    expect(refresh).toContain('state.status === "loaded"');
    expect(refresh).toContain("Promise.all");
    expect(refresh).toContain('invoke<DirEntry[]>("fs_read_dir"');
  });

  it("discards stale reads after a root switch or newer refresh", () => {
    expect(tree).toContain("refreshGenerationRef.current");
    expect(tree).toContain("generation !== refreshGenerationRef.current");
    expect(tree).toContain("rootRef.current = rootPath");
  });

  it("uses full refresh from both refresh controls", () => {
    expect(explorer).toContain("onClick={() => tree.refreshAll()}");
    expect(explorer).toContain("onSelect={() => tree.refreshAll()}");
    expect(explorer.match(/tree\.refreshAll\(\)/g)).toHaveLength(2);
  });

  it("coalesces external focus/terminal/visibility refresh triggers", () => {
    for (const event of ["focus", "Kai:term-command-end", "visibilitychange"]) {
      expect(explorer).toContain(event);
    }
    expect(explorer).toContain("window.clearTimeout(timer)");
  });
});
