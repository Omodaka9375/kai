import { describe, expect, it } from "vitest";
import { confineToWorkspace } from "./checkpoints";

// `confineToWorkspace` is the guard that makes `checkpoint_undo` safe. Checkpoint
// records are plain JSON sitting inside the workspace, so the paths they name are
// attacker-controllable: a hand-planted `.kai/checkpoints/1-x.json` naming
// `~/.ssh/authorized_keys` would previously be written verbatim, with no approval
// and no deny-list check.
//
// NOTE: `IS_WINDOWS` resolves to false under vitest (`platform()` throws outside
// Tauri), so these assertions use exactly-matching case and hold on both the
// case-sensitive and case-insensitive code paths.

describe("confineToWorkspace — escapes are rejected", () => {
  it("rejects a sibling directory reached by prefix similarity", () => {
    // `/proj` vs `/proj-evil` — naive startsWith() would let this through.
    expect(confineToWorkspace("/proj", "/proj-evil/x.ts")).toBeNull();
  });

  it("rejects parent traversal", () => {
    expect(confineToWorkspace("/proj", "/proj/../etc/passwd")).toBeNull();
    expect(confineToWorkspace("/proj", "/proj/a/../../etc/passwd")).toBeNull();
  });

  it("rejects home-directory and system targets outright", () => {
    expect(confineToWorkspace("/proj", "/home/me/.ssh/authorized_keys")).toBeNull();
    expect(confineToWorkspace("/proj", "/etc/cron.d/evil")).toBeNull();
    expect(confineToWorkspace("/proj", "/usr/local/bin/evil")).toBeNull();
  });

  it("rejects relative paths (no anchor to resolve against)", () => {
    expect(confineToWorkspace("/proj", "src/index.ts")).toBeNull();
    expect(confineToWorkspace("/proj", "./x.ts")).toBeNull();
  });

  it("rejects empty, non-string, and NUL-bearing input", () => {
    expect(confineToWorkspace("/proj", "")).toBeNull();
    expect(
      confineToWorkspace("/proj", "/proj/good.ts\0.png"),
    ).toBeNull();
    expect(
      confineToWorkspace("/proj", undefined as unknown as string),
    ).toBeNull();
  });

  it("rejects attempts to overwrite the checkpoint store itself", () => {
    // Restoring into .kai/checkpoints is how a payload re-seeds itself.
    expect(confineToWorkspace("/proj", "/proj/.kai/checkpoints/9-evil.json")).toBeNull();
    expect(confineToWorkspace("/proj", "/proj/.kai/checkpoints/nested/deep.json")).toBeNull();
  });
});

describe("confineToWorkspace — legitimate paths are preserved", () => {
  it("accepts nested workspace files", () => {
    expect(confineToWorkspace("/proj", "/proj/src/index.ts")).toBe("/proj/src/index.ts");
  });

  it("accepts sibling project config that merely shares a prefix", () => {
    expect(confineToWorkspace("/proj", "/proj/package.json")).toBe("/proj/package.json");
    expect(confineToWorkspace("/proj", "/proj/proj-notes.md")).toBe("/proj/proj-notes.md");
  });

  it("normalizes backslashes to the canonical forward-slash form", () => {
    expect(confineToWorkspace("/proj", "/proj\\src\\a.ts")).toBe("/proj/src/a.ts");
  });

  it("preserves trailing-slash variance on the root", () => {
    expect(confineToWorkspace("/proj/", "/proj/src/a.ts")).toBe("/proj/src/a.ts");
  });

  it("accepts other dot-dirs under the workspace, including .kai siblings", () => {
    // Only `.kai/checkpoints` is off-limits — `.kai/memory` is real project state
    // that checkpoint undo must be able to restore.
    expect(confineToWorkspace("/proj", "/proj/.kai/memory/MEMORY.md")).toBe(
      "/proj/.kai/memory/MEMORY.md",
    );
    expect(confineToWorkspace("/proj", "/proj/.github/workflows/ci.yml")).toBe(
      "/proj/.github/workflows/ci.yml",
    );
    expect(confineToWorkspace("/proj", "/proj/.env.example")).toBe("/proj/.env.example");
  });

  it("accepts Windows drive-letter workspaces", () => {
    expect(
      confineToWorkspace("D:/Code/proj", "D:/Code/proj/src/a.ts"),
    ).toBe("D:/Code/proj/src/a.ts");
    // Backslash input, the form OSC 7 and `homeDir()` hand us on Windows.
    expect(
      confineToWorkspace("D:/Code/proj", "D:\\Code\\proj\\src\\a.ts"),
    ).toBe("D:/Code/proj/src/a.ts");
  });

  it("rejects a different drive entirely", () => {
    expect(confineToWorkspace("D:/Code/proj", "C:/Windows/win.ini")).toBeNull();
  });

  it("refuses to restore the workspace root itself", () => {
    expect(confineToWorkspace("/proj", "/proj")).toBeNull();
  });
});
