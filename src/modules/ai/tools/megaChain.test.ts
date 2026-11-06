import { describe, expect, it } from "vitest";
import { megaChainHint } from "./shell";

/**
 * MEGA-CHAIN DETECTION (2026-11-06 report): "agents run pnpm install on
 * whole codebases or build or vitest/test commands and they stall for 20
 * minutes without a way to stop them. Also often they will combine all
 * these commands in one-liner and completely timeout, then try same thing
 * again."
 *
 * The guard: a bash_run command that chains 2+ of {install, build, test}
 * stages via ;/&&/|| is REFUSED with an actionable split-into-calls error.
 * Single-stage commands pass through untouched, whatever their length.
 */
describe("megaChainHint", () => {
  it("flags install + build one-liners", () => {
    const h = megaChainHint("pnpm install && pnpm run build");
    expect(h).not.toBeNull();
    expect(h).toContain("SEPARATE bash_run calls");
  });

  it("flags install + test one-liners (PowerShell semicolons)", () => {
    expect(megaChainHint("pnpm install; pnpm test")).not.toBeNull();
  });

  it("flags the full install + build + test triple", () => {
    const h = megaChainHint("pnpm install && pnpm build; vitest run");
    expect(h).not.toBeNull();
    expect(h).toContain("install");
    expect(h).toContain("build");
    expect(h).toContain("test");
  });

  it("flags pip install chained with a build", () => {
    expect(megaChainHint("pip install -r requirements.txt && python build.py && pytest")).not.toBeNull();
  });

  it("lets single-stage commands through, even long ones", () => {
    expect(megaChainHint("pnpm install --frozen-lockfile")).toBeNull();
    expect(megaChainHint("pnpm run build")).toBeNull();
    expect(megaChainHint("vitest run --reporter=verbose")).toBeNull();
    expect(megaChainHint("cargo build --release")).toBeNull();
  });

  it("lets non-stage chains through (e.g. git + ls)", () => {
    expect(megaChainHint("git status; git log --oneline -5")).toBeNull();
    expect(megaChainHint("echo hi && echo there")).toBeNull();
  });

  it("allows two commands of the SAME kind (install two packages)", () => {
    // install + install is one logical stage split in two - not the
    // multiply-timeout failure mode; only distinct slow kinds count.
    expect(megaChainHint("pnpm add zod && pnpm add vitest")).toBeNull();
  });
});

describe("timeout hint anti-retry pin (source)", () => {
  it("bash_run's timeout result explicitly forbids re-running unchanged", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
    expect(src).toContain(
      "Do NOT re-run the same command unchanged - it will time out the same way.",
    );
    // And the three recovery options are named.
    expect(src).toContain("bash_background");
    expect(src).toContain("timeout_secs (max 1000)");
  });

  it("the mega-chain guard is wired into bash_run execute before the shell runs", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
    const guardIdx = src.indexOf("const chainHint = megaChainHint(command);");
    const runIdx = src.indexOf("native.shellSessionRun(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(runIdx);
  });
});
