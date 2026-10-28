import { describe, expect, it } from "vitest";
import { presentationFor, type ToolPresentation } from "./toolPresentations";
import { EFFECT_LABELS } from "./effectStatus";

/**
 * The toolPresentations registry is the SINGLE source of truth for per-tool
 * display + fence/effect/remote classification (B3 — it replaced four
 * string-keyed tables in agent.ts / tool.tsx / toolFencing.ts /
 * AiToolApproval.tsx). These tests pin the contract a consumer relies on:
 * every registered row is well-formed, and an unknown tool resolves to the
 * safe default (fence, no side effects, MCP-namespaced ⇒ remote).
 */

describe("presentationFor — known tools", () => {
  it("resolves a full row for core tools", () => {
    const wr = presentationFor("write_file");
    expect(wr.label).toBe("Write");
    expect(wr.approvalLabel).toBe("Write file");
    expect(wr.effect).toBe("COMMITTED");
    expect(wr.fence).toBe(true);
    expect(wr.status?.({ path: "src/a.ts" })).toBe("Writing a.ts");
    expect(wr.summary?.({ path: "src/a.ts" })).toBe("src/a.ts");
  });

  it("bash_run reports COMMITTED + a command summary; bash_background is UNKNOWN + unfenced", () => {
    const run = presentationFor("bash_run");
    expect(run.effect).toBe("COMMITTED");
    expect(run.summary?.({ command: "pnpm test" })).toBe("pnpm test");
    const bg = presentationFor("bash_background");
    expect(bg.effect).toBe("UNKNOWN");
    expect(bg.fence).toBe(false);
  });

  it("edit/multi_edit summary is the path; status handles Windows backslashes", () => {
    expect(presentationFor("edit").summary?.({ path: "x/y.ts" })).toBe("x/y.ts");
    expect(presentationFor("edit").status?.({ path: "C:\\a\\b.ts" })).toBe(
      "Editing b.ts",
    );
  });

  it("checkpoint_undo is ROLLED_BACK, todo_write is COMMIT+unfenced", () => {
    expect(presentationFor("checkpoint_undo").effect).toBe("ROLLED_BACK");
    const todo = presentationFor("todo_write");
    expect(todo.effect).toBe("COMMITTED");
    expect(todo.fence).toBe(false);
    expect(todo.summary?.({ todos: [1, 2] })).toBe("2 items");
  });

  it("web tools are remote surfaces (drive provenance stamping)", () => {
    for (const t of ["web_browse", "web_fetch", "web_search"]) {
      expect(presentationFor(t).remoteSurface).toBe(true);
      expect(presentationFor(t).fence).toBe(true);
    }
  });

  it("every registered status/summary fn is total: handles empty/garbage args without throwing", () => {
    const names = [
      "read_file", "write_file", "edit", "multi_edit", "batch_edit",
      "create_directory", "grep", "glob", "bash_run", "bash_background",
      "bash_logs", "bash_kill", "todo_write", "checkpoint_undo",
      "run_subagent", "save_memory", "suggest_command", "open_preview",
      "display_image", "look_at_screen",
    ];
    for (const n of names) {
      const p = presentationFor(n);
      expect(() => p.status?.({}), `status ${n}`).not.toThrow();
      expect(() => p.summary?.({}), `summary ${n}`).not.toThrow();
      expect(() => p.status?.({ path: null, command: 3 }), `${n} garbage`).not.toThrow();
    }
  });
});

describe("presentationFor — safe defaults for unknown tools", () => {
  it("an unregistered tool: fence=true, effect=NONE, not remote", () => {
    const p = presentationFor("some_future_tool");
    expect(p.fence).toBe(true);
    expect(p.effect).toBe("NONE");
    expect(p.remoteSurface).toBe(false);
    expect(p.label).toBeUndefined();
    expect(p.status).toBeUndefined();
    expect(p.summary).toBeUndefined();
  });

  it("an MCP tool (server__name) defaults to a remote surface", () => {
    expect(presentationFor("ugnas__files_find").remoteSurface).toBe(true);
    expect(presentationFor("netexpert__net_ping").remoteSurface).toBe(true);
  });
});

describe("registry well-formedness", () => {
  // Walk the registry directly via known names is not exported; instead
  // assert the invariants hold for a broad sample by checking each resolved
  // presentation's effect is a legal EffectStatus.
  it("every sampled row's effect is a valid EffectStatus", () => {
    const sample = [
      "read_file", "write_file", "edit", "multi_edit", "batch_edit",
      "create_directory", "fs_delete", "bash_run", "bash_background",
      "bash_logs", "bash_kill", "shell_session_run", "grep", "glob",
      "web_browse", "web_fetch", "web_search", "todo_write", "save_memory",
      "run_subagent", "display_image", "generate_image", "generate_video",
      "open_preview", "suggest_command", "look_at_screen", "get_terminal_output",
      "checkpoint_undo", "fs_search", "fs_grep", "fs_rename", "fs_create_file",
    ];
    const legal = new Set<string>(Object.keys(EFFECT_LABELS));
    for (const n of sample) {
      const p: ToolPresentation = presentationFor(n);
      expect(legal.has(p.effect), `${n}.effect=${p.effect}`).toBe(true);
      expect(typeof p.fence).toBe("boolean");
      expect(typeof p.remoteSurface).toBe("boolean");
    }
  });

  it("registry rows match the OLD toolFencing NO_FENCE set (fence=false)", () => {
    // The tools that were in NO_FENCE must still be unfenced, or fencing
    // would start applying to structural results it must not touch.
    const previouslyUnfenced = [
      "bash_background", "bash_list", "bash_kill", "todo_write",
      "checkpoint_undo", "run_subagent", "generate_image", "generate_video",
    ];
    for (const n of previouslyUnfenced) {
      expect(presentationFor(n).fence, `${n} must stay unfenced`).toBe(false);
    }
  });
});
