import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALLOWED_TOOLS,
  HARD_EXCLUDED_TOOLS,
  isToolAllowed,
  TIER_LABELS,
  TOOL_CATALOG,
  toolsInTier,
  type ToolTier,
} from "./toolCatalog";

/**
 * The catalog is the assistant's security boundary (it gates what a headless,
 * approval-less agent may run), so its invariants are pinned, not trusted:
 * the default must be read-only, hard-excluded tools must be un-selectable
 * even if someone edits the persisted allowlist, and every tier must be
 * non-empty and disjoint.
 */

describe("tool catalog shape", () => {
  it("every entry has a known tier + a blurb, and names are unique", () => {
    const seen = new Set<string>();
    for (const t of TOOL_CATALOG) {
      expect(TIER_LABELS[t.tier]).toBeTruthy();
      expect(t.blurb.length).toBeGreaterThan(3);
      expect(seen.has(t.name)).toBe(false);
      seen.add(t.name);
    }
  });

  it("covers all three tiers with at least one tool each", () => {
    for (const tier of Object.keys(TIER_LABELS) as ToolTier[]) {
      expect(toolsInTier(tier).length).toBeGreaterThan(0);
    }
  });

  it("no tool is both selectable and hard-excluded", () => {
    for (const t of TOOL_CATALOG) {
      expect(HARD_EXCLUDED_TOOLS.has(t.name)).toBe(false);
    }
  });
});

describe("DEFAULT_ALLOWED_TOOLS", () => {
  it("is the read tier minus gmail_read — nothing that writes, executes, costs credits, or reads the owner's mail", () => {
    // gmail_read is READ-tier (zero side effects) but stays opt-in even on a
    // fresh install: it reads the owner's private mailbox, which deserves an
    // explicit grant, not a default.
    expect([...DEFAULT_ALLOWED_TOOLS].sort()).toEqual(
      toolsInTier("read")
        .filter((n) => n !== "gmail_read" && n !== "social_read")
        .sort(),
    );
    expect(DEFAULT_ALLOWED_TOOLS).not.toContain("gmail_read");
    expect(DEFAULT_ALLOWED_TOOLS).not.toContain("social_read");
    for (const dangerous of [
      "bash_run",
      "write_file",
      "edit",
      "generate_image",
      "watch_create",
    ]) {
      expect(DEFAULT_ALLOWED_TOOLS).not.toContain(dangerous);
    }
  });
});

describe("isToolAllowed", () => {
  it("grants a read tool listed in the allowlist", () => {
    expect(isToolAllowed("web_search", ["web_search", "grep"])).toBe(true);
  });

  it("denies a tool not listed", () => {
    expect(isToolAllowed("bash_run", ["web_search"])).toBe(false);
  });

  it("denies a hard-excluded tool EVEN IF the allowlist lists it", () => {
    // The load-bearing rule: a hand-edited/stale persisted allowlist can
    // never resurrect a desktop-only tool on the headless surface.
    expect(isToolAllowed("run_subagent", ["run_subagent"])).toBe(false);
    expect(isToolAllowed("display_image", [...DEFAULT_ALLOWED_TOOLS, "display_image"])).toBe(false);
  });

  it("accepts both a Set and an array for the allowlist", () => {
    expect(isToolAllowed("grep", new Set(["grep"]))).toBe(true);
    expect(isToolAllowed("grep", ["grep"])).toBe(true);
  });

  it("denies gmail_read when not granted — it is selectable, never default", () => {
    expect(isToolAllowed("gmail_read", DEFAULT_ALLOWED_TOOLS)).toBe(false);
    expect(isToolAllowed("gmail_read", [...DEFAULT_ALLOWED_TOOLS, "gmail_read"])).toBe(true);
  });
});
