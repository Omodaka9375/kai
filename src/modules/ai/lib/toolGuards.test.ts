import { describe, expect, it, vi } from "vitest";
import {
  collectCommandArgs,
  collectPathArgs,
  evaluateToolGuards,
  pathReadFloorGuard,
  shellFloorGuard,
  withCentralToolGuards,
  type ToolGuard,
} from "./toolGuards";

/**
 * Central deny-only guard tests. The security-critical property is
 * MONOTONICITY: a guard can deny or stay silent, never allow — so guard
 * ORDER must never turn a denial into permission. These are adversarial on
 * purpose (mirrors allowlist.test.ts).
 */

describe("collectPathArgs", () => {
  it("pulls path-shaped string args, recursing through edits[]", () => {
    expect(
      collectPathArgs({ path: "a.ts" }),
    ).toEqual(["a.ts"]);
    expect(
      collectPathArgs({
        edits: [{ path: "x.ts" }, { path: "y.ts" }],
      }),
    ).toEqual(["x.ts", "y.ts"]);
    expect(collectPathArgs({ file_path: "/etc/passwd" })).toEqual([
      "/etc/passwd",
    ]);
  });

  it("ignores non-string values and survives garbage without throwing", () => {
    expect(collectPathArgs({ path: 123 })).toEqual([]);
    expect(collectPathArgs(null)).toEqual([]);
    expect(collectPathArgs("string")).toEqual([]);
    // deeply nested beyond the visit depth is simply not collected (no crash)
    expect(() => collectPathArgs({ a: { b: { c: { d: { e: { path: "p" } } } } } })).not.toThrow();
  });

  it("caps recursion so a crafted deep object can't hang the guard", () => {
    let deep: Record<string, unknown> = { path: "reachable" };
    for (let i = 0; i < 50; i++) deep = { nested: deep };
    // Deeper than the visit cap → not collected, and it terminates.
    expect(collectPathArgs(deep)).toEqual([]);
  });
});

describe("collectCommandArgs", () => {
  it("pulls command/cmd/script string fields", () => {
    expect(collectCommandArgs({ command: "ls" })).toEqual(["ls"]);
    expect(collectCommandArgs({ cmd: "dir", other: 1 })).toEqual(["dir"]);
    expect(collectCommandArgs({ command: ["x"] })).toEqual([]);
  });
});

describe("pathReadFloorGuard", () => {
  it("denies a secret path on ANY tool, even one with no inline check", () => {
    const reason = pathReadFloorGuard({
      name: "mcp_server__do_thing",
      args: { path: "/home/me/.ssh/id_rsa" },
    });
    expect(reason).toMatch(/Blocked by central tool guard/);
    expect(reason).toMatch(/id_rsa|ssh|sensitive/i);
  });

  it("allows an innocuous path", () => {
    expect(
      pathReadFloorGuard({ name: "read_file", args: { path: "src/app.ts" } }),
    ).toBeUndefined();
  });
});

describe("shellFloorGuard", () => {
  it("denies a destructive command smuggled in a command field", () => {
    expect(
      shellFloorGuard({
        name: "mcp_run",
        args: { command: "rm -rf / --no-preserve-root" },
      }),
    ).toMatch(/Blocked by central tool guard/);
  });

  it("allows a benign command", () => {
    expect(
      shellFloorGuard({ name: "bash_run", args: { command: "pnpm test" } }),
    ).toBeUndefined();
  });
});

describe("evaluateToolGuards — monotonicity", () => {
  it("first denial wins and a later permissive guard cannot undo it", () => {
    const deny: ToolGuard = () => "nope";
    const ignoreEverything: ToolGuard = () => undefined;
    // Order matters only for WHICH reason surfaces, never for the outcome:
    expect(evaluateToolGuards({ name: "t", args: {} }, [deny, ignoreEverything])).toBe("nope");
    expect(evaluateToolGuards({ name: "t", args: {} }, [ignoreEverything, deny])).toBe("nope");
  });

  it("a crashing guard is treated as silence, not a grant — later guards still run", () => {
    const boom: ToolGuard = () => {
      throw new Error("guard crashed");
    };
    const deny: ToolGuard = () => "denied-by-second";
    expect(evaluateToolGuards({ name: "t", args: {} }, [boom, deny])).toBe(
      "denied-by-second",
    );
  });
});

describe("withCentralToolGuards", () => {
  it("returns { error } and never runs the body when a guard denies", async () => {
    const execute = vi.fn(async (_input: unknown) => ({ ok: true }));
    const tools = { suspicious: { execute } };
    const guarded = withCentralToolGuards(tools);
    const result = await guarded["suspicious"]!.execute({
      command: "rm -rf / --no-preserve-root",
    });
    expect(result).toMatchObject({ error: expect.stringContaining("Blocked by central tool guard") });
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs the body and returns its value when all guards are silent", async () => {
    const execute = vi.fn(async (_input: unknown) => ({ value: 42 }));
    const tools = { fine: { execute } };
    const guarded = withCentralToolGuards(tools);
    const result = await guarded["fine"]!.execute({ path: "src/a.ts" });
    expect(result).toEqual({ value: 42 });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("fires onDeny with tool name + reason on a denial", async () => {
    const onDeny = vi.fn();
    const tools = { x: { execute: async (_input: unknown) => ({}) } };
    const guarded = withCentralToolGuards(tools, undefined, onDeny);
    await guarded["x"]!.execute({ path: "/home/me/.env" });
    expect(onDeny).toHaveBeenCalledOnce();
    expect(onDeny.mock.calls[0]?.[0]).toBe("x");
  });

  it("leaves tools with no execute untouched", () => {
    const tools = { noExec: { description: "hi" } };
    const guarded = withCentralToolGuards(tools);
    expect(guarded["noExec"]).toEqual({ description: "hi" });
  });
});
