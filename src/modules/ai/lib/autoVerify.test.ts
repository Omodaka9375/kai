import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveVerifyCommand, _resetVerifyState } from "./autoVerify";

/**
 * Auto-verify at run end — behavioral pins for the wake policy.
 *
 * The class this guards: a verify TIMEOUT must never be treated as a
 * failure. In the wild a slow (green) vitest suite timed out at the cap,
 * the bridge woke the agent with "Fix these failures before finishing"
 * (phantom failures — the tail was all `ok N` lines), AND kept the dirty
 * mark, so every subsequent run end re-verified, re-timed-out, and re-woke
 * the agent: an endless loop that relaunched the agent and re-loaded the
 * whole conversation every single time.
 *
 * Pinned here:
 *   - timeout → NO wake message, dirty mark CLEARED (no re-arm).
 *   - failure → wake message, dirty mark kept (the wake run re-marks).
 *   - pass → no wake, dirty cleared.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("autoVerify wake policy", () => {
  afterEach(() => {
    _resetVerifyState();
    vi.clearAllMocks();
  });

  it("resolve falls through cleanly on an absent package.json", async () => {
    const invoke = (await import("@tauri-apps/api/core")).invoke as ReturnType<typeof vi.fn>;
    // package.json absent → invoke throws → readPkgJson returns null; no
    // Cargo.toml check needed since fs_stat also throws (mocked).
    invoke.mockRejectedValue(new Error("absent"));
    const cmd = await resolveVerifyCommand("/tmp/nonexistent-root");
    expect(cmd === null || typeof cmd === "string").toBe(true);
  });
});

/** Source text of autoVerify.ts — read once at module load (no top-level
 *  await: it breaks esbuild's sync transform in this setup). */
const SRC: string = readFileSync(new URL("./autoVerify.ts", import.meta.url), "utf8");

/** Source-contract pins (the wake policy itself lives in code paths that
 *  need a native runCommand mock; pin the decision structure textually so
 *  a regression to "timeout == failure" fails loudly). */
describe("autoVerify wake policy (source contract)", () => {
  it("timeout returns \"timeout\", never a failure message", () => {
    expect(SRC).toContain('return "timeout"');
    expect(SRC).not.toContain("TIMED OUT after ${VERIFY_TIMEOUT_S}s — last output");
    // The old phrasing told the model to fix a timeout as if it were a
    // failure — that must not come back.
    expect(SRC).toMatch(/timeout says nothing about correctness/);
  });

  it("timeout clears the dirty mark (no wake re-arm on next run end)", () => {
    expect(SRC).toMatch(/if \(outcome === "timeout"\) \{[\s\S]*?dirtyAt\.delete\(workspaceRoot\);/);
  });

  it("failure keeps the dirty mark and wakes with the exact output", () => {
    const body = SRC.split("export async function verifyIfDirtyAtRunEnd")[1] ?? "";
    expect(body).toContain("const failure = outcome.fail;");
    expect(body).toContain("[verify] ${failure}");
  });
});