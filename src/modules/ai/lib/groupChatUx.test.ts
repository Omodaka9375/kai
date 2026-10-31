import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Group-chat UX contract (2026-10-31, four user-reported defects).
 *
 * 1. Persona approval dead click: the registry was keyed by toolCallId
 *    while the unified surface resolves by the SDK's approvalId (always a
 *    distinct generateId()) — Approve/Deny on a persona card was a silent
 *    no-op miss. Registry keys must now BE the SDK approvalId.
 * 2. Composer: AiInputBar-style borderless strip (transparent flex-1
 *    textarea, not a small boxed Input), full-width content when expanded.
 * 3. Panel header ✕ is MINIMIZE ( _ ) — the group keeps running; the
 *    collapsed tray pill carries a small ✕ that ENDS + DELETES the group.
 * 4. The pill must disappear when no groups remain (deleteGroupChat from
 *    the pill ✕ removes the group; the tray falls back or unmounts).
 */

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8") as string;

const store = read("../store/groupChatStore.ts");
const panel = read("../components/GroupChatPanelView.tsx");
const lib = read("./groupApprovals.ts");

describe("persona approval ids route by the SDK approvalId", () => {
  it("registrations are keyed by the SDK approvalId, not the toolCallId", () => {
    // The registration site: sdkApprovalId is the map key AND the field.
    expect(store).toContain("const sdkApprovalId =");
    expect(store).toMatch(
      /personaApprovals\.set\(sdkApprovalId, \{\s*\n\s*approvalId: sdkApprovalId,/,
    );
  });

  it("respondPersonaApproval falls back to a stored-approvalId scan (pre-fix entries)", () => {
    // Direct key hit first, then the e.approvalId scan — never a silent miss.
    expect(store).toMatch(
      /respondPersonaApproval\(approvalId: string, approved: boolean\): void \{\s*\n\s*let key: string \| null = personaApprovals\.has\(approvalId\) \? approvalId : null;/,
    );
    expect(store).toMatch(/if \(e\.approvalId === approvalId\) \{/);
  });

  it("the unified surface still exposes approvalId for persona cards", () => {
    expect(lib).toContain("id: a.approvalId,");
  });
});

describe("panel ✕ is minimize; the pill ✕ ends and deletes", () => {
  it("the panel header button minimizes ( _ icon, no close semantics)", () => {
    expect(panel).toContain('aria-label="Minimize group chat"');
    expect(panel).toContain("MinusSignIcon");
    expect(panel).toContain("the group keeps running in its pill");
  });

  it("the collapsed tray pill carries a small ✕ that ends AND deletes", () => {
    expect(panel).toContain('aria-label="End and close group chat"');
    expect(panel).toMatch(
      /onEnd=\{\(id\) => \{\s*\n\s*\/\/ End \(soft-stop participants\) THEN delete/,
    );
    expect(panel).toMatch(/return endGroupChat\(id\)\.then\(\(\) => deleteGroupChat\(id\)\);/);
  });

  it("minimizing never deletes (the onEnd path lives only on the pill)", () => {
    // Slice from the minimize comment to the PanelHeader's children — the
    // onClose body sits well inside; bounded lazy windows missed it.
    const start = panel.indexOf("// Minimize hands the slot back");
    const end = panel.indexOf("<Transcript group={active}");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const closeSite = panel.slice(start, end);
    expect(closeSite).toContain("onClose={() => {");
    expect(closeSite).not.toContain("deleteGroupChat");
    expect(closeSite).not.toContain("endGroupChat");
  });
});

describe("composer mirrors the AI input bar", () => {
  it("borderless transparent textarea (no boxed Input element)", () => {
    expect(panel).toMatch(/min-h-8 flex-1 resize-none rounded-lg bg-transparent/);
    // The boxed <Input from ui/input is gone from the composer.
    expect(panel).not.toContain('import { Input } from "@/components/ui/input"');
  });

  it("expanded keeps the centered readable column without extra borders", () => {
    // Span the whole composer section (function boundary regexes stop at the
    // first nested brace - anchor to the NEXT function instead).
    const start = panel.indexOf("function Composer");
    const end = panel.indexOf("function GroupListTray");
    const composer = panel.slice(start, end);
    expect(composer).toContain('expanded && "mx-auto w-full max-w-3xl"');
    expect(composer).not.toContain("border-x");
  });
});

describe("the pill unmounts when the last group is gone", () => {
  it("the panel renders nothing without groups (delete clears the pill)", () => {
    expect(panel).toContain('if (groups.length === 0 && !pickerOpen) return null;');
  });
});
