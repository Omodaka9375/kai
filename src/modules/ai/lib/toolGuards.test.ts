import { describe, expect, it, vi } from "vitest";
import {
  collectCommandArgs,
  collectPathArgs,
  canonicalReadFloor,
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
  it("denies a secret path on ANY tool, even one with no inline check", async () => {
    const reason = await pathReadFloorGuard({
      name: "mcp_server__do_thing",
      args: { path: "/home/me/.ssh/id_rsa" },
    });
    expect(reason).toMatch(/Blocked by central tool guard/);
    expect(reason).toMatch(/id_rsa|ssh|sensitive/i);
  });

  it("allows an innocuous path", async () => {
    expect(
      await pathReadFloorGuard({ name: "read_file", args: { path: "src/app.ts" } }),
    ).toBeUndefined();
  });

  it("CATCHES a symlink hop into a protected dir (the 2026-11-15 fix)", async () => {
    // A literal path with nothing suspicious about it whose canonical form
    // lands in ~/.ssh. The old synchronous floor pattern-matched the literal
    // string only, so this sailed through — which is exactly how an MCP file
    // tool (no inline canonical check) could read a key.
    const reason = await canonicalReadFloor(
      "D:/repo/notes.txt",
      async () => "/home/me/.ssh/id_rsa",
    );
    expect(reason.ok).toBe(false);
    if (!reason.ok) {
      expect(reason.reason).toMatch(/protected|sensitive/i);
    }
  });

  it("allows a path whose canonical form is also allowed", async () => {
    const r = await canonicalReadFloor(
      "src/a.ts",
      async () => "/home/me/repo/src/a.ts",
    );
    expect(r.ok).toBe(true);
  });

  it("allows a not-yet-existing path (canonicalize throws)", async () => {
    // New-file writes legitimately fail canonicalization. Failing closed here
    // would break every create; the tool's own write check still applies.
    const r = await canonicalReadFloor("src/new.ts", async () => {
      throw new Error("ENOENT");
    });
    expect(r.ok).toBe(true);
  });

  it("denies BEFORE canonicalizing when the literal is already a secret", async () => {
    // Keeps the deny reason pointing at what the model typed, and avoids the
    // IPC round trip on paths that are refused anyway.
    const canonicalize = vi.fn(async () => "/tmp/x");
    const reason = await canonicalReadFloor("/home/me/.env", canonicalize);
    expect(reason.ok).toBe(false);
    expect(canonicalize).not.toHaveBeenCalled();
  });

  it("the floor guard canonicalizes every collected path", async () => {
    // Proves the async floor is what runs, not just the literal matcher: a
    // path arg that only looks dangerous after resolution must be refused.
    const spy = vi.fn(async (p: string) =>
      p === "D:/repo/ok.txt" ? "/home/me/.ssh/id_ed25519" : p,
    );
    const guard: ToolGuard = async ({ args }) => {
      for (const p of collectPathArgs(args)) {
        const r = await canonicalReadFloor(p, spy);
        if (!r.ok) return `Blocked by central tool guard: ${r.reason}`;
      }
      return undefined;
    };
    const reason = await guard({
      name: "mcp__read",
      args: { file_path: "D:/repo/ok.txt" },
    });
    expect(reason).toMatch(/Blocked by central tool guard/);
    expect(spy).toHaveBeenCalledWith("D:/repo/ok.txt");
  });
});

describe("shellFloorGuard", () => {
  it("denies a destructive command smuggled in a command field", async () => {
    expect(
      await shellFloorGuard({
        name: "mcp_run",
        args: { command: "rm -rf / --no-preserve-root" },
      }),
    ).toMatch(/Blocked by central tool guard/);
  });

  it("allows a benign command", async () => {
    expect(
      await shellFloorGuard({ name: "bash_run", args: { command: "pnpm test" } }),
    ).toBeUndefined();
  });
});

describe("evaluateToolGuards — monotonicity", () => {
  it("first denial wins and a later permissive guard cannot undo it", async () => {
    const deny: ToolGuard = () => "nope";
    const ignoreEverything: ToolGuard = () => undefined;
    // Order matters only for WHICH reason surfaces, never for the outcome:
    expect(await evaluateToolGuards({ name: "t", args: {} }, [deny, ignoreEverything])).toBe("nope");
    expect(await evaluateToolGuards({ name: "t", args: {} }, [ignoreEverything, deny])).toBe("nope");
  });

  it("an ASYNC guard's denial also wins, in either order", async () => {
    const asyncDeny: ToolGuard = async () => "nope-async";
    const asyncSilent: ToolGuard = async () => undefined;
    expect(
      await evaluateToolGuards({ name: "t", args: {} }, [asyncSilent, asyncDeny]),
    ).toBe("nope-async");
    expect(
      await evaluateToolGuards({ name: "t", args: {} }, [asyncDeny, () => undefined]),
    ).toBe("nope-async");
  });

  it("a crashing guard FAILS CLOSED even when it is the only guard", async () => {
    const boom: ToolGuard = () => {
      throw new Error("guard crashed");
    };
    const deny: ToolGuard = () => "denied-by-second";
    expect(
      await evaluateToolGuards({ name: "t", args: {} }, [boom, deny]),
    ).toMatch(/guard failed.*refusing to execute/i);
    expect(
      await evaluateToolGuards({ name: "t", args: {} }, [boom]),
    ).toMatch(/guard failed.*refusing to execute/i);
  });

  it("an ASYNC guard that rejects FAILS CLOSED too", async () => {
    // The new canonicalize call is IPC: a rejected promise is the realistic
    // crash shape now, and it must not degrade into permission.
    const boomAsync: ToolGuard = async () => {
      throw new Error("ipc died mid-canonicalize");
    };
    expect(
      await evaluateToolGuards({ name: "t", args: {} }, [boomAsync]),
    ).toMatch(/guard failed.*refusing to execute/i);
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
