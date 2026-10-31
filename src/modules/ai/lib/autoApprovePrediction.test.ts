import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  predictAutoApproval,
  type AutoApprovalPrediction,
} from "./autoApprovePrediction";

/**
 * Auto-approve blink fix — the UI-side prediction contract.
 *
 * User report: in auto-allow mode the approval prompt "shows and blinks for
 * a second" on every command. The bridge approves pending calls on a
 * setTimeout(0) AFTER the part renders, so the full bordered card painted
 * first and collapsed a tick later — a flash per tool call. Manual mode was
 * fine (the card legitimately waits for the click), so only the "all" path
 * changes: the card renders the FLAT one-row state from the first frame for
 * calls the bridge is GUARANTEED to approve.
 *
 * predictAutoApproval deliberately MIRRORS AgentRunBridge's gate; the
 * lockstep pins below fail the build if either side drifts.
 */

const base = (over: Partial<AutoApprovalPrediction> = {}): AutoApprovalPrediction => ({
  autoApprove: "all",
  toolName: "bash_run",
  input: { command: "pnpm test" },
  signingApprovalRequired: false,
  ...over,
});

describe("predictAutoApproval (the mirror)", () => {
  it("approves ordinary calls in all mode — the flat row renders from frame one", () => {
    expect(predictAutoApproval(base())).toBe(true);
    expect(
      predictAutoApproval(base({ toolName: "edit", input: { path: "a.ts" } })),
    ).toBe(true);
  });

  it("never predicts approval in off/ask mode — manual cards unchanged", () => {
    expect(predictAutoApproval(base({ autoApprove: "off" }))).toBe(false);
  });

  it("elevated bash_run is never auto-approved — the elevation card still shows", () => {
    expect(
      predictAutoApproval(base({ input: { command: "x", elevated: true } })),
    ).toBe(false);
  });

  it("privacy tools (look_at_screen) are never auto-approved", () => {
    expect(
      predictAutoApproval(base({ toolName: "look_at_screen", input: {} })),
    ).toBe(false);
  });

  it("signed-commit approval requirement blocks git commit predictions", () => {
    expect(
      predictAutoApproval(
        base({
          input: { command: "git commit -m x" },
          signingApprovalRequired: true,
        }),
      ),
    ).toBe(false);
    // Same command without the signing setting: approved.
    expect(
      predictAutoApproval(
        base({
          input: { command: "git commit -m x" },
          signingApprovalRequired: false,
        }),
      ),
    ).toBe(true);
    // commit-tree is plumbing, not a signed assertion.
    expect(
      predictAutoApproval(
        base({
          input: { command: "git commit-tree x" },
          signingApprovalRequired: true,
        }),
      ),
    ).toBe(true);
  });
});

describe("lockstep with AgentRunBridge (the real gate)", () => {
  const bridge = readFileSync(
    new URL("../components/AgentRunBridge.tsx", import.meta.url),
    "utf8",
  );
  const card = readFileSync(
    new URL("../components/AiToolApproval.tsx", import.meta.url),
    "utf8",
  );
  const predictor = readFileSync(
    new URL("./autoApprovePrediction.ts", import.meta.url),
    "utf8",
  );

  it("the bridge still enforces the same three carve-outs in the same order", () => {
    // Order matters: elevated → privacy → signed commit, then approve.
    // 2026-10-31: the carve-outs are SHAPE-based (no bash_run name match) so
    // MCP (`server__*`) wrappers stop for the same clicks — pinned below.
    const order: [string, number][] = [
      ["input?.elevated === true", -1],
      ["PRIVACY_APPROVAL_TOOLS.has(toolName)", -1],
      ["isSignedCommit =", -1],
      ["autoApprovedRef.current.add(id)", -1],
    ];
    let prev = -1;
    for (const [needle] of order) {
      const idx = bridge.indexOf(needle);
      expect(idx).toBeGreaterThan(prev);
      prev = idx;
    }
  });

  it("the carve-outs hold for MCP tools too (shape-based, not name-based)", () => {
    // The elevation gate must NOT require toolName === "bash_run" — an MCP
    // shell wrapper passing elevated:true is the same privilege request.
    expect(bridge).not.toMatch(
      /toolName === "bash_run" && input\?\.elevated === true/,
    );
    expect(predictor).not.toMatch(
      /toolName === "bash_run" && args\.input\?\.elevated === true/,
    );
    // The signed-commit gate probes command/cmd/script (the central tool
    // guards' MCP field set), not just first-party input.command.
    expect(bridge).toMatch(/input\?\.command \?\? input\?\.cmd \?\? input\?\.script/);
    expect(predictor).toMatch(
      /args\.input\?\.command \?\? args\.input\?\.cmd \?\? args\.input\?\.script/,
    );
  });

  it("MCP carve-out prediction: an MCP git wrapper with signing-required stays a card", () => {
    expect(
      predictAutoApproval(
        base({
          toolName: "github__create_commit",
          input: { command: "git commit -m x" },
          signingApprovalRequired: true,
        }),
      ),
    ).toBe(false);
    expect(
      predictAutoApproval(
        base({
          toolName: "shellmcp__run",
          input: { cmd: "git commit -m x" },
          signingApprovalRequired: true,
        }),
      ),
    ).toBe(false);
    // Ordinary MCP calls in all mode are approved like everything else.
    expect(
      predictAutoApproval(
        base({
          toolName: "github__get_issue",
          input: { repo: "a/b" },
        }),
      ),
    ).toBe(true);
    // An MCP shell wrapper passing elevated:true never auto-approves.
    expect(
      predictAutoApproval(
        base({
          toolName: "shellmcp__run",
          input: { cmd: "x", elevated: true },
        }),
      ),
    ).toBe(false);
  });

  it("the bridge still auto-approves on a deferred timer (the reason the prediction exists)", () => {
    expect(bridge).toContain("if (autoApprove !== \"all\") return;");
    expect(bridge).toMatch(/setTimeout\(\(\) => \{[\s\S]*respond\(id, true\)/);
  });

  it("the card consults the predictor BEFORE the queue/queued branch and before the full card", () => {
    const predIdx = card.indexOf("willBeAutoApproved");
    const queueIdx = card.indexOf("if (queue?.queued)");
    const fullCardIdx = card.indexOf("rounded-lg border border-border bg-card shadow-sm");
    expect(queueIdx).toBeGreaterThan(predIdx);
    expect(fullCardIdx).toBeGreaterThan(predIdx);
    // The flat row renders on prediction OR on the responded transition.
    expect(card).toContain("if (wasAutoApproved || willBeAutoApproved) {");
    // Proxy cards never predict (their sessions run on other surfaces'
    // approval routing, not this window's auto-approve).
    expect(card).toMatch(/!proxy &&\s*\n?\s*predictAutoApproval/);
  });

  it("the flat row keeps the Tool-row geometry (no border — the jump IS the glitch)", () => {
    const card2 = readFileSync(
      new URL("../components/AiToolApproval.tsx", import.meta.url),
      "utf8",
    );
    const flat = card2.slice(
      card2.indexOf("if (wasAutoApproved || willBeAutoApproved) {"),
      card2.indexOf("// Queued behind an earlier approval"),
    );
    expect(flat).toContain("rounded-md px-2 py-1.5");
    expect(flat).not.toContain("border-border");
    expect(flat).toContain("auto-approved");
  });
});
