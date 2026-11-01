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
const chat = read("../store/chatStore.ts");
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
    // The tray gate is the full JSX condition (prettier wraps it across
    // lines — match with \s*, not the one-line literal).
    const gate = panel.match(
      /\{activeProjectInGroup &&\s*activeProjectGroups\.length > 0 &&\s*!expanded \? \(/,
    );
    // 2026-11-01: the pill derives from the panel's OWN expanded boolean —
    // the cross-store surface term is gone (see the round-trip describe).
    expect(panel).not.toMatch(/stackSurface !== "group" \? \(/);
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
    // 2026-11-01 round-trip fix: the lift flag must SUBSCRIBE to everything
    // it reads imperatively. A memo keyed [groupStoreVersion] alone froze
    // across project switches (the active project is module state — no
    // store bump): stale-true lifted the window over an empty strip on the
    // other project; stale-false sat it at +42px ON the pill's strip,
    // covering the pill after switching back.
    expect(mini).toMatch(/useSyncExternalStore\(\s*subscribeActiveProject,/);
    expect(mini).toMatch(/\[groupStoreVersion, activeProjectVersion, stackSurface\]/);
    expect(mini).not.toMatch(/\[groupStoreVersion\],\s*\n\s*\);/);
  });
});

describe("group transcript auto-scrolls like the main AI chat (2026-11-01)", () => {
  // "Group chat window needs same autoscroll regular ai window has."
  // The transcript is built on the SAME primitives the main chat uses —
  // Conversation/ConversationContent/ConversationScrollButton (StickToBottom
  // under the hood) — not a hand-rolled scroll effect. User/agent sends jump
  // to bottom; a scrolled-up reader gets the catch-up arrow.
  it("the transcript renders through Conversation + ConversationScrollButton", () => {
    expect(panel).toMatch(/<Conversation contextRef=\{scrollCtx\}>/);
    expect(panel).toMatch(/<\/ConversationContent>/);
    expect(panel).toMatch(/<ConversationScrollButton \/>/);
    // The old plain-div scroller must not return.
    expect(panel).not.toMatch(
      /"flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"/,
    );
  });

  it("new user/agent messages jump to bottom (own-send visibility rule)", () => {
    expect(panel).toMatch(
      /newest && \(newest\.from === "user" \|\| newest\.from === "agent"\)/,
    );
    expect(panel).toMatch(/scrollCtx\.current\?\.scrollToBottom\(\)/);
  });
});

describe("project switch closes a non-participant group panel (2026-11-01)", () => {
  // "When a group chat is active and I switch project it doesn't close."
  // The collapsed pill is participant-scoped; the EXPANDED panel must be
  // too. The close effect fires on a REAL project switch (prev-project
  // ref) and hands the right-gutter slot back when the newly active
  // project is not a participant of the open group.
  it("the switch effect re-checks the open group against the new project", () => {
    expect(panel).toMatch(
      /const inGroup =\s*activeProjectId !== null &&\s*g\.participants\.some\(\(p\) => p\.projectId === activeProjectId\);/,
    );
    expect(panel).toMatch(/if \(inGroup\) return;\s*setOpenGroupId\(null\);/);
    // Only real switches close — the picker's explicit "open existing
    // group" (possibly a group this project isn't in) must survive its own
    // openGroupId change.
    expect(panel).toMatch(
      /if \(activeProjectId === prevProjectRef\.current\) return;/,
    );
  });

  it("agent lines render UNFENCED (markers never paint into the group UI)", () => {
    // A model echoed the fence wrapper it was taught into its group reply
    // (user report: a reply arrived wrapped in literal tool-fence markers).
    // New replies are stripped at the store's production sites; the
    // display unfences agent lines so PERSISTED history is clean too.
    expect(panel).toMatch(/from === "agent" \? unfence\(text\) : text/);
  });

  it("the store strips markers at every agent-text production site", () => {
    // Persona reply, bridge mirror (resolveMirrorReply), and coordinator
    // send_to_project are the three places agent text is produced — all
    // three unfence before the text reaches the transcript.
    expect(store).toMatch(/reply = unfence\(reply\)\.trim\(\);/);
    expect(store).toMatch(/const text = unfence\(/);
    expect(store).toMatch(/const clean = unfence\(message\);/);
  });
});

describe("the pill survives a project round-trip (2026-11-01)", () => {
  // "If I switch to a normal project and come back to group chat project,
  //  the collapsed group chat is not there — just a visual gap in its
  //  place. Effectively the group chat disappeared." Two freezes:
  //   1. AiMiniWindow's lift flag read activeProjectId() imperatively
  //      inside a memo keyed on the group store only — a project switch
  //      bumps neither input, so the flag froze at the old project:
  //      stale-true = the window lifted over an empty strip (the gap on the
  //      normal project); stale-false = the window back at +42px, COVERING
  //      the pill that painted correctly underneath after the return.
  //   2. The pill gated on chatStore's surface field, which can desync
  //      from the panel's own open-group state (surface "group" + nothing
  //      selected = panel AND pill both hidden = the gap).
  // Fix: chatStore signals active-project changes; the window subscribes;
  // the pill derives from the panel's expanded boolean ("copy the regular
  // AI chat patterns" — one derived boolean drives window + pill).
  it("chatStore notifies active-project switches (subscribe + version)", () => {
    expect(chat).toContain("export function subscribeActiveProject");
    expect(chat).toContain("export function getActiveProjectVersion");
    expect(chat).toMatch(/const changed = activeProjectRuntime\?\.id !== runtime\.id;/);
    expect(chat).toMatch(/if \(changed\) \{\s*activeProjectVersion\+\+;/);
  });

  it("the pill gate uses the panel's expanded boolean (not the store surface)", () => {
    expect(panel).toMatch(
      /activeProjectGroups\.length > 0 &&\s*!expanded \? \(/,
    );
  });
});
