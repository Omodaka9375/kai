import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Group auto-allow contract (2026-10-31).
 *
 * "Is there an auto allow mode for group?" — now yes: a per-group toggle
 * (Ask/Allow pill in the group header) that auto-approves THIS group's
 * PERSONA tool calls through the production gate.
 *
 * Invariants pinned here:
 *   - The gate is the IMPORTED predictAutoApproval (the desktop bridge's),
 *     never a reimplemented copy — one gate, one set of carve-outs.
 *   - Hard carve-outs still stop for a human click even under Allow:
 *     elevated privileges, screen capture (privacy), signed commits.
 *   - Project participants are NOT touched — their own sessions' bridges
 *     decide with their per-chat auto-approve setting.
 *   - Every auto-allow decision is AUDITED (the transcript can't prove
 *     what ran; the audit can).
 *   - The flag persists with the group (kai-groups.json) — restart keeps it.
 */

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8") as string;

const store = read("../store/groupChatStore.ts");
const panel = read("../components/GroupChatPanelView.tsx");
const pred = read("./autoApprovePrediction.ts");

describe("the gate is the production predictor, imported", () => {
  it("groupChatStore imports predictAutoApproval (no local reimplementation)", () => {
    expect(store).toContain(
      'import { predictAutoApproval } from "../lib/autoApprovePrediction";',
    );
    // And it is called with autoApprove: "all" — the gate's own carve-outs
    // (elevated / privacy / signed commit) then apply unmodified.
    expect(store).toMatch(/predictAutoApproval\(\{\s*\n\s*autoApprove: "all",/);
  });

  it("predictAutoApproval still refuses elevated, screen, and signed commits", () => {
    expect(pred).toContain('if (args.input?.elevated === true) {');
    expect(pred).toContain("PRIVACY_APPROVAL_TOOLS");
    expect(pred).toContain("signingApprovalRequired &&");
  });

  it("auto-allowed calls skip the card registry entirely", () => {
    // The resolve(true) early-return sits BEFORE the sdkApprovalId registry
    // write — no card, no wait, no pill badge.
    const slice = store.match(
      /const decisionPromises = pendingCalls\.map\([\s\S]*?notify\(\); \/\/ render the cards BEFORE the await/,
    );
    expect(slice).not.toBeNull();
    expect(slice![0]).toMatch(/groupAutoAllow &&[\s\S]*?predictAutoApproval/);
    expect(slice![0]).toContain("resolve(true);");
    expect(slice![0]).toMatch(
      /resolve\(true\);[\s\S]{0,120}?\}\s*\n\s*\/\/ KEY = THE SDK'S approvalId/,
    );
  });
});

describe("auto decisions are audited", () => {
  it("an auto-allow records an approval audit marked with the group toggle", () => {
    expect(store).toContain(
      "`persona ${p.name} (group auto-allow): ${summary}`",
    );
    expect(store).toContain("AUDIT_KINDS.approvalApprove");
  });
});

describe("scope: personas only, persisted, human-toggled", () => {
  it("the flag lives on GroupChat and persists with the group", () => {
    expect(store).toMatch(/autoApprove\?: boolean;/);
    expect(store).toContain(
      "export async function setGroupAutoApprove(groupId: string, value: boolean)",
    );
    // setGroupAutoApprove persists before notifying.
    expect(store).toMatch(
      /g\.autoApprove = value;\s*\n\s*await persist\(\);\s*\n\s*notify\(\);/,
    );
  });

  it("project participants keep their own session's auto-approve (no store-level override)", () => {
    // The ONLY gate call is inside the persona run loop (runPersonaReply) —
    // grep the whole store: no other predictAutoApproval call site exists.
    const calls = store.match(/predictAutoApproval\(/g);
    expect(calls).toHaveLength(1);
  });

  it("the header toggle renders Ask/Allow with the emerald dot twin of the AI toggle", () => {
    expect(panel).toContain("GroupAutoApproveToggle");
    expect(panel).toContain("setGroupAutoApprove(group.id, !on)");
    expect(panel).toMatch(
      /on \? "bg-emerald-500" : "bg-muted-foreground\/50"/,
    );
    expect(panel).toContain('{on ? "Allow" : "Ask"}');
  });
});
