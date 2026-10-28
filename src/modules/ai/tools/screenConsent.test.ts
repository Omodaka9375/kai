import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Screen-capture consent + terminal-vs-screen disambiguation contract.
 *
 * Two reported bugs (2026-10-21):
 *  1. The agent reached for look_at_screen when asked to look at the
 *     TERMINAL (recent command output). The fix is that both surfaces tell
 *     the model terminal text → get_terminal_output, never a screenshot.
 *  2. The agent took screenshots without asking, even under auto-approve
 *     "all", and models without vision still called it. The enforcement is
 *     that look_at_screen is in the never-auto-approve PRIVACY set — its
 *     approval card is the boundary; a prompt rule alone is advisory.
 *
 * These are source-contract pins (the runtime behaviour needs a live Chat +
 * React tree, so we pin the wiring exactly as loopStop.test.ts does).
 */
describe("auto-approve must never bypass a screen capture", () => {
  const bridge = readFileSync(
    new URL("../components/AgentRunBridge.tsx", import.meta.url),
    "utf8",
  );

  it("defines a PRIVACY_APPROVAL_TOOLS set containing look_at_screen", () => {
    expect(bridge).toContain("PRIVACY_APPROVAL_TOOLS");
    expect(bridge).toMatch(/PRIVACY_APPROVAL_TOOLS[\s\S]*"look_at_screen"/);
  });

  it("skips auto-approval for privacy tools (continue on the set)", () => {
    // The guard must `continue` (skip the auto-approve), not just check.
    expect(bridge).toContain(
      "if (PRIVACY_APPROVAL_TOOLS.has(toolName)) continue;",
    );
    // And it must run BEFORE the generic deferred approval response,
    // otherwise the early-exempt is dead code.
    const exemptIdx = bridge.indexOf("PRIVACY_APPROVAL_TOOLS.has(toolName)");
    const genericIdx = bridge.indexOf("autoApprovedRef.current.add(id)");
    expect(exemptIdx).toBeGreaterThan(-1);
    expect(genericIdx).toBeGreaterThan(exemptIdx);
  });
});

describe("look_at_screen tool description disambiguates from the terminal", () => {
  const screen = readFileSync(
    new URL("../tools/screen.ts", import.meta.url),
    "utf8",
  );

  it("tells the model NOT to use it for terminal output", () => {
    expect(screen).toContain("get_terminal_output");
    expect(screen).toMatch(/[Dd]o NOT use it to read terminal/);
  });

  it("forbids speculative / unprompted capture", () => {
    expect(screen).toMatch(/ONLY when the user EXPLICITLY asks/);
    expect(screen).toMatch(/[Dd]o NOT call it speculatively/);
  });

  it("keeps needsApproval: true", () => {
    expect(screen).toContain("needsApproval: true");
  });

  it("focus example no longer points at 'the terminal output'", () => {
    // The old `focus` description used 'the terminal output' as its example,
    // which actively taught the model that terminal text lives on screen.
    // Slice from the focus field to its execute handler (the first
    // `needsApproval` is in the file's top doc comment, not the tool prop).
    const focusDesc = screen.slice(
      screen.indexOf("focus: z"),
      screen.indexOf("execute: async"),
    );
    expect(focusDesc.length).toBeGreaterThan(0);
    expect(focusDesc).not.toMatch(/'the terminal output'/);
    expect(focusDesc).toContain("get_terminal_output");
  });
});

describe("system prompt routes terminal questions to get_terminal_output", () => {
  const prompt = readFileSync(
    new URL("../config/prompt.ts", import.meta.url),
    "utf8",
  );

  it("states screenshots are only on explicit user request", () => {
    expect(prompt).toContain("auto-approve never applies");
    expect(prompt).toMatch(/NEVER call it speculatively/);
  });

  it("maps 'look at my terminal' / 'last command' to get_terminal_output", () => {
    expect(prompt).toContain("Terminal output is NOT a reason to screenshot");
    expect(prompt).toContain("get_terminal_output");
  });
});
