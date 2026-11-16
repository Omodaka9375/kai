import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  predictAutoApproval,
  isAlwaysAllowedAuthorityTool,
  STANDING_AUTHORITY_TOOLS,
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

  it("standing-authority tools are never auto-approved, even in all mode", () => {
    // The 2026-11-15 finding: Allow mode had exactly three carve-outs, so
    // every tool that changes the agent's PERMANENT permissions auto-approved
    // with zero cards — customInstructions/defaultShell writes, MCP server
    // registration, skill authoring, watches, persona deletion.
    for (const toolName of STANDING_AUTHORITY_TOOLS) {
      expect(
        predictAutoApproval(base({ toolName, input: {} })),
      ).toBe(false);
    }
  });

  it("an Always Allow grant unlocks its own tool ONLY (2026-11-16)", () => {
    // The user clicked "Always Allow" on save_memory's card: that exact tool
    // now passes the gate under Allow mode…
    expect(
      predictAutoApproval(
        base({ toolName: "save_memory", input: { entry: "x" }, alwaysAllowedAuthorityTools: ["save_memory"] }),
      ),
    ).toBe(true);
    // …and every OTHER authority tool still stops.
    for (const toolName of STANDING_AUTHORITY_TOOLS) {
      if (toolName === "save_memory") continue;
      expect(
        predictAutoApproval(
          base({ toolName, input: {}, alwaysAllowedAuthorityTools: ["save_memory"] }),
        ),
      ).toBe(false);
    }
    // A grant never stretches to non-authority carve-outs.
    expect(
      predictAutoApproval(
        base({ input: { command: "x", elevated: true }, alwaysAllowedAuthorityTools: ["save_memory"] }),
      ),
    ).toBe(false);
    expect(
      predictAutoApproval(
        base({ toolName: "look_at_screen", input: {}, alwaysAllowedAuthorityTools: ["save_memory"] }),
      ),
    ).toBe(false);
  });

  it("isAlwaysAllowedAuthorityTool: grant applies in BOTH modes, non-authority names never", () => {
    const grants = ["save_memory"];
    expect(isAlwaysAllowedAuthorityTool("save_memory", grants)).toBe(true);
    expect(isAlwaysAllowedAuthorityTool("save_memory", [])).toBe(false);
    expect(isAlwaysAllowedAuthorityTool("save_memory", undefined)).toBe(false);
    // A non-authority tool "granted" by a tampered store is ignored.
    expect(isAlwaysAllowedAuthorityTool("bash_run", ["bash_run"])).toBe(false);
    expect(isAlwaysAllowedAuthorityTool("edit", ["edit"])).toBe(false);
  });

  it("the standing-authority set covers the escalation primitives by name", () => {
    // Pinned individually: dropping one of these silently re-opens the hole.
    // settings_update_restricted carries customInstructions, defaultShell,
    // autostart and subagentMaxSteps (the agent's own leash).
    expect(STANDING_AUTHORITY_TOOLS.has("settings_update_restricted")).toBe(true);
    expect(STANDING_AUTHORITY_TOOLS.has("mcp_add_server")).toBe(true);
    expect(STANDING_AUTHORITY_TOOLS.has("create_skill")).toBe(true);
    expect(STANDING_AUTHORITY_TOOLS.has("update_skill")).toBe(true);
    expect(STANDING_AUTHORITY_TOOLS.has("watch_create")).toBe(true);
    expect(STANDING_AUTHORITY_TOOLS.has("delete_persona")).toBe(true);
    // save_memory (2026-11-16): MEMORY.md rides into every future session's
    // system prompt — the customInstructions archetype, same class.
    expect(STANDING_AUTHORITY_TOOLS.has("save_memory")).toBe(true);
  });

  it("the cosmetic settings tool STAYS auto-approvable (Allow still works)", () => {
    // The set is deliberately narrow: theme/editor/terminal comfort prefs are
    // reversible cosmetics with no persistent authority. Over-blocking would
    // make Allow mode useless and invite users to disable the guard.
    expect(predictAutoApproval(base({ toolName: "settings_update", input: {} }))).toBe(true);
    expect(
      predictAutoApproval(base({ toolName: "bash_run", input: { command: "pnpm test" } })),
    ).toBe(true);
    expect(
      predictAutoApproval(base({ toolName: "edit", input: { path: "a.ts" } })),
    ).toBe(true);
  });

  it("every listed tool actually has an approval card (no dead guards)", () => {
    // A needsApproval:false tool never reaches this gate, so listing it would
    // read as a guard while doing nothing. Fail loudly if one drifts to false.
    const files: Record<string, string> = {
      settings_update_restricted: "../tools/settings.ts",
      mcp_add_server: "../tools/mcpTools.ts",
      create_skill: "../tools/skills.ts",
      update_skill: "../tools/skills.ts",
      watch_create: "../tools/watch.ts",
      delete_persona: "../tools/persona.ts",
      save_memory: "../tools/memory.ts",
    };
    for (const [name, rel] of Object.entries(files)) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8");
      const decl = src.indexOf(`${name}: tool({`);
      expect(decl).toBeGreaterThan(-1);
      const body = src.slice(decl, decl + 4000);
      expect(body).toMatch(/needsApproval:\s*true/);
    }
  });

  it("KAI.md documents the standing-authority carve-outs by name", () => {
    // The doc line claiming the never-auto-approved set was already stale once
    // (it listed three carve-outs). Pin it to the code so it cannot drift again.
    const kaiMd = readFileSync(
      new URL("../../../../KAI.md", import.meta.url),
      "utf8",
    );
    const line = kaiMd
      .split(/\r?\n/)
      .find((l) => l.includes("Card carve-outs"));
    expect(line).toBeDefined();
    for (const name of STANDING_AUTHORITY_TOOLS) {
      expect(line).toContain(name);
    }
    expect(line).toContain("STANDING_AUTHORITY_TOOLS");
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

  it("the bridge still enforces the same carve-outs in the same order", () => {
    // Order matters: elevated → privacy → standing authority → signed commit,
    // then approve.
    // 2026-10-31: the carve-outs are SHAPE-based (no bash_run name match) so
    // MCP (`server__*`) wrappers stop for the same clicks — pinned below.
    const order: [string, number][] = [
      ["input?.elevated === true", -1],
      ["PRIVACY_APPROVAL_TOOLS.has(toolName)", -1],
      ["STANDING_AUTHORITY_TOOLS.has(toolName)", -1],
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

  it("the bridge imports the authority set instead of re-declaring it", () => {
    // Single source of truth: PRIVACY_APPROVAL_TOOLS is duplicated between
    // the two files (only string-pinned above), so the newer, broader set is
    // IMPORTED — drift becomes a compile error, not a silent security hole.
    expect(bridge).toMatch(
      /import\s*\{[\s\S]*?STANDING_AUTHORITY_TOOLS[\s\S]*?\}\s*from\s*"\.\.\/lib\/autoApprovePrediction"/,
    );
    expect(bridge).not.toMatch(/const STANDING_AUTHORITY_TOOLS\s*[:=]/);
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
    expect(card).toContain("if (wasAutoApproved || willBeAutoApproved || hasGrant) {");
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
      card2.indexOf("if (wasAutoApproved || willBeAutoApproved || hasGrant) {"),
      card2.indexOf("// Queued behind an earlier approval"),
    );
    expect(flat).toContain("rounded-md px-2 py-1.5");
    expect(flat).not.toContain("border-border");
    expect(flat).toContain("auto-approved");
  });

  it("ALWAYS ALLOW (2026-11-16): card grants, bridge consults grants, Security revokes", () => {
    // The card renders the button ONLY for authority tools in non-proxy
    // mode, and it approves the current call in the same click.
    expect(card).toContain("isAuthorityTool && !proxy");
    expect(card).toContain("grantStandingAuthorityAlwaysAllow(toolName)");
    expect(card).toMatch(/grantStandingAuthorityAlwaysAllow\(toolName\)[\s\S]{0,400}?onRespond\(true\)/);
    // The bridge passes the grants to the predictor AND skips the manual
    // count for granted tools (no rubber-stamp cards in Ask mode).
    expect(bridge).toMatch(/predictAutoApproval\(\{[\s\S]{0,300}alwaysAllowedAuthorityTools,/);
    expect(card).toContain("alwaysAllowedAuthorityTools: authorityGrants");
    expect(bridge).toContain("isAlwaysAllowedAuthorityTool(");
    // The card's memo comparator re-renders on grant changes (a card frozen
    // pre-grant must collapse when the grant lands).
    expect(card).toContain("grantsA.length === grantsB.length");
    // SecuritySection is the revocation surface.
    const security = readFileSync(
      new URL("../../../settings/sections/SecuritySection.tsx", import.meta.url),
      "utf8",
    );
    expect(security).toContain("revokeStandingAuthorityAlwaysAllow");
  });

  it("the persona gate passes the same grant list (one gate, one grant source)", () => {
    // groupChatStore's persona auto-allow consults the SAME preferences
    // field — a grant the user clicked on a desktop card silences the
    // persona card too.
    const store = readFileSync(
      new URL("../store/groupChatStore.ts", import.meta.url),
      "utf8",
    );
    expect(store).toContain("alwaysAllowedAuthorityTools:");
    expect(store).toMatch(
      /standingAuthorityAlwaysAllowed/,
    );
  });
});
