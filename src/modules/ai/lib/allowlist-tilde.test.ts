import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isAllowlistable } from "./allowlist";

/**
 * The `~` overreach regression (2026-10-20): policy.ts treated ANY command
 * containing `~/` (or `/tmp/`) as touching a sensitive path → warning →
 * unpinnable. On pwsh, `~` prefixes are idiomatic (`Get-ChildItem ~/Downloads`),
 * so harmless listings never showed the "Always allow" button — while the
 * genuinely dangerous `rm -rf ~` was already hard-blocked by
 * checkShellCommand, which does not depend on this warning.
 *
 * Pins: (a) `~`/`/tmp/` commands are pinnable when otherwise low-risk,
 * (b) the sensitive-path list stays [/etc/, /var/log/] — `rm -rf ~` still
 * blocked by the hard deny-list, NOT by the sensitive-path warning.
 */

describe("isAllowlistable `~` and /tmp/ relaxation", () => {
  it("pins `~`-prefixed listings and /tmp/ reads", () => {
    expect(isAllowlistable("Get-ChildItem ~/Downloads")).toBe(true);
    expect(isAllowlistable("Get-Content ~/notes.txt")).toBe(true);
    expect(isAllowlistable("ls ~/src")).toBe(true);
    expect(isAllowlistable("cat /tmp/build.log")).toBe(true);
  });

  it("still refuses the dangerous `~` commands via the HARD deny-list", () => {
    expect(isAllowlistable("rm -rf ~")).toBe(false);
    expect(isAllowlistable("rm -rf ~/")).toBe(false);
    expect(isAllowlistable("rm -rf $HOME")).toBe(false);
  });

  it("policy sensitive-path list excludes ~ and /tmp/ (source contract)", () => {
    const policySrc = readFileSync(
      new URL("./policy.ts", import.meta.url),
      "utf8",
    );
    const m = policySrc.match(/const sensitivePaths = \[[^\]]*\]/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('"/etc/"');
    expect(m![0]).toContain('"/var/log/"');
    expect(m![0]).not.toContain('"/tmp/"');
    expect(m![0]).not.toContain('"~/"');
  });
});