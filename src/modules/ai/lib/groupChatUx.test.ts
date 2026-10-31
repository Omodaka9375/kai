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
const mini = read("../components/AiMiniWindow.tsx");
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

  it("expanded spans the full panel width like the main AI chat (no centered column)", () => {
    // Span the whole composer section (function boundary regexes stop at the
    // first nested brace - anchor to the NEXT function instead).
    const start = panel.indexOf("function Composer");
    const end = panel.indexOf("function GroupListTray");
    const composer = panel.slice(start, end);
    // 2026-10-31: the centered max-w-3xl column was removed - the expanded
    // panel mirrors the main AI chat layout (full-width strip, user bubbles
    // ml-auto max-w-[85%], replies full-width), so neither the composer nor
    // the transcript may reintroduce a width cap.
    expect(composer).not.toContain("max-w-3xl");
    expect(panel.indexOf("max-w-3xl", panel.indexOf("function Transcript"))).toBe(-1);
    // User bubbles get the main chat's right-aligned treatment.
    expect(panel).toContain('m.from === "user" && "ml-auto max-w-[85%]"');
    expect(composer).not.toContain("border-x");
  });

  it("agent markdown renders with the main chat's renderer (MessageResponse/Streamdown)", () => {
    // 2026-10-31: agent replies in the group are MARKDOWN - the raw
    // whitespace-pre-wrap text dump rendered fences/headings as literal
    // characters. GroupMessageBody must use the SAME MessageResponse
    // (Streamdown + MarkdownCode + ChatTable) the main AI chat renders
    // assistant text with - not a hand-rolled renderer.
    const start = panel.indexOf("function GroupMessageBody");
    const end = panel.indexOf("function ActivityStrip");
    const body = panel.slice(start, end);
    expect(panel).toContain('import { MessageResponse } from "@/components/ai-elements/message";');
    expect(body).toContain("<MessageResponse>{body}</MessageResponse>");
    // The raw pre-wrap dump is gone (user text also rides the renderer -
    // same as the main chat's user bubbles).
    expect(body).not.toContain("whitespace-pre-wrap rounded-lg");
  });

  it("the collapsed pill shows only in projects ENGAGED in a group", () => {
    // 2026-10-31: the panel is app-level (rendered once above all projects),
    // so the old `groups.length > 0` gate advertised any group - including
    // one between two OTHER projects - under every project's AI window.
    // The pill/tray must gate on the ACTIVE project being a participant,
    // and the tray lists only that project's groups. Creation is unaffected
    // (it enters via the status-bar window event, not the pill).
    // The tray gate is the full JSX condition line.
    const gate = panel.match(/\{activeProjectInGroup && activeProjectGroups\.length > 0 && stackSurface !== "group" \? \(/);
    expect(gate).not.toBeNull();
    expect(panel).toContain("const activeProjectGroups = useMemo(");
    expect(panel).toMatch(/groups=\{activeProjectGroups\}/);
    // The OLD unscoped gate (any group anywhere shows the pill) must not return.
    expect(panel).not.toMatch(/\{groups\.length > 0 && stackSurface !== "group" \? \(/);
  });

  it("an ENDED group does not paint the collapsed pill (X closes for good)", () => {
    // 2026-10-31 regression: "when I close chat on X the whole collapsed pill
    // was still there on all projects". GroupListTray used `?? groups[0]` so a
    // just-ENDED group kept advertising itself (dimmed, "Resume") on every
    // participant project. The pill names LIVE groups only - resume is an
    // explicit re-entry, not an always-on pill.
    const start = panel.indexOf("function GroupListTray");
    // GroupListTray is the LAST function in the file — slice to the end.
    const tray = panel.slice(start);
    expect(tray).toContain("groups.find((x) => x.endedAt === null)");
    expect(tray).not.toContain("?? groups[0]");
  });
});

describe("the pill unmounts when the last group is gone", () => {
  it("the panel renders nothing without groups (delete clears the pill)", () => {
    expect(panel).toContain('if (groups.length === 0 && !pickerOpen) return null;');
  });

  it("AiMiniWindow reserves the pill strip by the SAME predicate the pill paints by", () => {
    // 2026-11-01: "the gap where the collapsed pill was is still there — it
    // recovers if I expand and collapse the AI window again". The window
    // reserved its +42px pill strip for ANY group anywhere
    // (`getGroups().length > 0` — ended groups included, other projects'
    // groups included) while the pill itself only paints for the ACTIVE
    // project's LIVE groups: two predicates = a reserved empty strip with
    // nothing in it. Both surfaces must use groupsForProject(active) —
    // live groups the active project participates in, nothing else.
    expect(mini).toContain("groupsForProject(activeProjectId() ?? \"\").length > 0");
    expect(mini).not.toContain("getGroups().length");
    expect(mini).not.toMatch(/groupCount > 0/);
  });
});
