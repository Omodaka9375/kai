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
      /respondPersonaApproval\(\s*approvalId: string,\s*approved: boolean,\s*\): void \{\s*\n\s*let key: string \| null = personaApprovals\.has\(approvalId\) \? approvalId : null;/,
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
    // 2026-11-02 SHOULD 9: the raw-return chain is gone; the end→delete
    // sequence now rides the shared rejection-surfacing wrapper.
    expect(panel).not.toMatch(
      /return endGroupChat\(id\)\.then\(\(\) => deleteGroupChat\(id\)\);/,
    );
    expect(panel).toMatch(
      /runGroupAction\("Ending the group", \(\) =>\s*\n\s*endGroupChat\(id\)\.then\(\(\) => deleteGroupChat\(id\)\),/,
    );
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
    expect(panel).toMatch(
      /min-h-8 flex-1 resize-none rounded-lg bg-transparent/,
    );
    // The boxed <Input from ui/input is gone from the COMPOSER. Scoped to
    // the composer slice (2026-11-01): the InvitePicker persona filter is a
    // legitimate consumer of the Input primitive — but the composer's chat
    // input must stay a borderless transparent textarea.
    const start = panel.indexOf("function Composer");
    const end = panel.indexOf("function GroupListTray");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const composer = panel.slice(start, end);
    expect(composer).not.toContain("<Input");
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
    expect(
      panel.indexOf("max-w-3xl", panel.indexOf("function Transcript")),
    ).toBe(-1);
    // User bubbles get the main chat's right-aligned treatment.
    expect(panel).toContain('m.from === "user" && "ml-auto max-w-[85%]"');
    expect(composer).not.toContain("border-x");
  });

  it("agent reply bubbles sit on the panel gray — never a bg-background slab (2026-11-01)", () => {
    // User report: "responses from agents in group chat all have black
    // background. In AI chat it's rendered with gray." --background is the
    // near-black app base; both windows are bg-card (gray) and the main
    // chat renders assistant text with NO fill — the gray IS the panel
    // showing through. Agent bubbles must stay transparent so the panel
    // gray reads exactly like the AI chat, and the embedded quote preview
    // matches the main chat's (bg-muted/50, not near-black bg-background/80).
    const start = panel.indexOf("function GroupMessageBody");
    const end = panel.indexOf("function ActivityStrip");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = panel.slice(start, end);
    expect(body).toMatch(
      /from === "user"\s*\?\s*"border-border\/60 bg-muted\/40"\s*:\s*"border-border\/60 bg-transparent"/,
    );
    // The black-slab fill must not return in any bubble arm (note:
    // bg-muted-foreground/… does NOT contain the substring bg-background).
    expect(body).not.toContain("bg-background");
    // Quote preview: the main chat's gray treatment.
    expect(body).toContain("border-l-2 border-primary/60 bg-muted/50");
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
    expect(panel).toContain(
      'import { MessageResponse } from "@/components/ai-elements/message";',
    );
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
    expect(panel).not.toMatch(
      /\{groups\.length > 0 && stackSurface !== "group" \? \(/,
    );
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
    expect(panel).toContain(
      "if (groups.length === 0 && !pickerOpen) return null;",
    );
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
    expect(mini).toContain(
      'groupsForProject(activeProjectId() ?? "").length > 0',
    );
    expect(mini).not.toContain("getGroups().length");
    expect(mini).not.toMatch(/groupCount > 0/);
    // 2026-11-01 round-trip fix: the lift flag must SUBSCRIBE to everything
    // it reads imperatively. A memo keyed [groupStoreVersion] alone froze
    // across project switches (the active project is module state — no
    // store bump): stale-true lifted the window over an empty strip on the
    // other project; stale-false sat it at +42px ON the pill's strip,
    // covering the pill after switching back.
    expect(mini).toMatch(/useSyncExternalStore\(\s*subscribeActiveProject,/);
    expect(mini).toMatch(
      /\[groupStoreVersion, activeProjectVersion, stackSurface\]/,
    );
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

  it("new USER messages jump to bottom (own-send visibility rule; agent replies follow via stick-to-bottom only)", () => {
    // 2026-11-02 audit SHOULD 5: force-scrolling on agent replies yanked
    // the user out of a manual scroll-up on every participant reply. Only
    // the user's OWN send force-jumps; agent traffic rides the stick lock.
    expect(panel).toMatch(
      /newest && newest\.from === "user"/,
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

describe("single membership: conflicted rows disable at the picker (2026-11-01 M3)", () => {
  // The picker pre-empts the store refusal: rows for projects already live
  // in another group render DISABLED with the owning group's name, in both
  // invite surfaces (InvitePicker + ParticipantsMenu). The store backstop
  // is pinned in singleMembership.test.ts.
  it("InvitePicker rows disable with the owning group's name", () => {
    expect(panel).toMatch(/const owners = useMemo\(\(\) => \{/);
    expect(panel).toMatch(/const ownerName = owners\.get\(project\.id\);/);
    expect(panel).toMatch(/disabled=\{!!ownerName\}/);
    // Conflicted rows are still readable, never invisible: the badge names
    // the owning group, the row keeps the project name visible at 50%.
    expect(panel).toMatch(/in \{ownerName\}/);
    expect(panel).toMatch(
      /"cursor-not-allowed opacity-50 hover:bg-transparent"/,
    );
  });

  it("ParticipantsMenu lists conflicted projects as non-invitable", () => {
    expect(panel).toMatch(/!liveGroupForProject\(c\.id\)/);
    expect(panel).toMatch(/In another group/);
  });

  it("the store exposes the lookup the picker uses", () => {
    expect(store).toMatch(
      /export function liveGroupForProject\(projectId: string\): GroupChat \| null/,
    );
    expect(store).toMatch(
      /export function lastGroupRefusal\(\): string \| null/,
    );
  });
});

describe("2026-11-02 audit SHOULDs 4-11: scroll, memo, rejections, preamble, nonces", () => {
  it("agent replies no longer force-scroll (only the user's own send jumps)", () => {
    // The effect force-scrolled on from === "agent" too, yanking the user
    // out of a manual scroll-up on every participant reply — contradicting
    // its own comment. Stick-to-bottom follows agent traffic at-bottom.
    expect(panel).toMatch(/newest\.from === "user"[\s\S]{0,120}scrollToBottom/);
    // The old dual-author force-scroll must not return.
    expect(panel).not.toMatch(
      /newest\.from === "user" \|\| newest\.from === "agent"/,
    );
  });

  it("GroupMessageBody is memoized (stable string props must not re-parse markdown)", () => {
    expect(panel).toMatch(/const GroupMessageBody = memo\(function GroupMessageBody/);
    // The map must render it as an element (not a bare call) so memo works.
    expect(panel).toMatch(/<GroupMessageBody text=\{m\.text\} from=\{m\.from\} \/>/);
  });

  it("group actions surface rejections instead of unhandled promises", () => {
    // The shared action wrapper + strip in the panel, the composer catch
    // keeping the draft, and the tray's end→delete chain no longer throw
    // unhandled rejections. (The tray's `void onEnd` is safe now: onEnd
    // catches internally via runGroupAction.)
    expect(panel).toMatch(/const runGroupAction = useCallback/);
    expect(panel).toMatch(/runGroupAction\("Ending the group"/);
    expect(panel).toMatch(/runGroupAction\("Stopping participants"/);
    expect(panel).toMatch(/setSendError\(/);
    expect(panel).not.toMatch(/void endGroupChat\(active\.id\)/);
    expect(panel).toMatch(
      /\.catch\(\(e: unknown\) =>[\s\S]{0,80}console\.error\("\[Kai-groups\] /,
    );
  });

  it("the bridge gates the preamble on the STORE term flag, not a React ref", () => {
    // A ref resets every boot → re-inject → unrequested model run per
    // restart. consumeCoordinatorPreamble is atomic per term and
    // persisted; cleared on reclaim/re-delegate/end.
    const bridge = readFileSync(
      new URL("../../ai/components/AgentRunBridge.tsx", import.meta.url),
      "utf8",
    );
    expect(bridge).toMatch(/consumeCoordinatorPreamble\(coordGroup\.id\)/);
    expect(bridge).not.toMatch(/preambleGivenRef/);
    // Store side: the flag + accessor + term clears.
    expect(store).toMatch(/preambleGiven\?: boolean;/);
    expect(store).toMatch(
      /export function consumeCoordinatorPreamble\(groupId: string\): boolean/,
    );
    expect(store).toMatch(
      /export function resolveCoordinator\(g: GroupChat\): string \| null/,
    );
  });
});

describe("2026-11-02 user asks: compact InvitePicker dropdowns + custom-instructions hint", () => {
  it("both dropdowns gate their filters on roster size and cap their viewports", () => {
    // Filters only appear when the list warrants one (>6 rows) — a small
    // roster stays tight, a large one stays scannable.
    expect(panel).toMatch(/showProjectFilter = candidates\.length > 6/);
    expect(panel).toMatch(/showPersonaFilter = personas\.length > 6/);
    // Viewports are bounded short (max-h-56), not the old 64/80 walls.
    expect(panel).not.toMatch(/max-h-64/);
    expect(panel).not.toMatch(/max-h-80/);
    expect(panel).toMatch(/max-h-56/);
    expect(panel).toMatch(/Filter projects…/);
  });

  it("selection chips cap at 4 with a +N overflow chip", () => {
    expect(panel).toMatch(/invitees\.slice\(0, 4\)\.map/);
    // JSX text: `+{invitees.length - 4} more` (no space before the brace).
    expect(panel).toMatch(/\+\{invitees\.length - 4\} more/);
    expect(panel).toMatch(/\+\{pickedPersonas\.length - 4\} more/);
  });

  it("the settings section explains where custom instructions apply", () => {
    const section = readFileSync(
      new URL("../../../settings/sections/AgentsSection.tsx", import.meta.url),
      "utf8",
    );
    expect(section).toMatch(
      /Appended to the system prompt of every agent run/,
    );
  });

  it("message responses render links through ChatFileLink", () => {
    const message = readFileSync(
      new URL("../../../components/ai-elements/message.tsx", import.meta.url),
      "utf8",
    );
    expect(message).toMatch(/a: ChatFileLink/);
  });
});

describe("2026-11-02 audit NITs: pill badge, rename cap, pure updater, proxy preview", () => {
  it("the pill badge counts background participant sessions, not just personas", () => {
    const pill = readFileSync(
      new URL("../components/GroupPill.tsx", import.meta.url),
      "utf8",
    );
    expect(pill).toMatch(/getSessionAgentMeta\(p\.sessionId\)\.status === "awaiting-approval"/);
    expect(pill).toContain("getPersonaApprovals().length");
  });

  it("the rename input caps at the store's 120-char limit", () => {
    expect(panel).toMatch(/<input\s+autoFocus\s+value=\{nameDraft\}\s+maxLength=\{120\}/);
  });

  it("pickMention is a pure updater (side effects outside setMention)", () => {
    // setText/queueMicrotask must not run inside the updater — React may
    // double-invoke updaters (StrictMode); idempotent today, fatal tomorrow.
    const fn = panel.slice(
      panel.indexOf("const pickMention = useCallback("),
      panel.indexOf("const onTextChange = useCallback("),
    );
    // The single setMention call must be a plain close — no updater fn at
    // all (the pure-updater fix removed it), and setText/queueMicrotask sit
    // outside any setMention argument.
    const setMentionIdx = fn.indexOf("setMention(");
    const updaterEnd = fn.indexOf(");", setMentionIdx);
    const updaterCall = fn.slice(setMentionIdx, updaterEnd);
    expect(updaterCall).not.toContain("=>");
    expect(updaterCall).not.toContain("setText");
    expect(updaterCall).not.toContain("queueMicrotask");
    expect(fn).toMatch(/setMention\(\{ open: false, start: 0, query: "" \}\);/);
  });

  it("proxy approval cards preview file edits inline (no diff tab exists for headless runs)", () => {
    const approval = readFileSync(
      new URL("../components/AiToolApproval.tsx", import.meta.url),
      "utf8",
    );
    expect(approval).toMatch(/proxy=\{proxy\}/);
    expect(approval).toMatch(/PROXY INLINE PREVIEW/);
    expect(approval).toMatch(/no diff tab to/);
  });
});

describe("2026-11-02 audit SHOULDs: delivery gates, hydrate guard, debounced persist", () => {
  it("deliveries gate on isProjectOpen — a closed project's frozen id is never used", () => {
    // Both send fan-out paths: the user/coordinator send and the routed
    // @-mention. The frozen record id is only trusted while the project is
    // OPEN (its bridge is mounting); a closed project's id is a black hole.
    expect(store).toMatch(
      /sessionKnown \|\| \(isProjectOpen\(p\.projectId\) \? p\.sessionId : ""\)/,
    );
    expect(store).toMatch(
      /known \|\|\n\s*\(isProjectOpen\(target\.projectId\) \? target\.sessionId : ""\)/,
    );
  });

  it("hydrate filters malformed records BEFORE the sort, then sorts deterministically", () => {
    // The 2026-11-02 wedge fix: a null/garbage record used to throw inside
    // the sort's createdAt read, leaving a rejected hydratePromise cached
    // for the app lifetime. Filter first; sort only valid records.
    expect(store).toMatch(/const valid = saved\.filter\(/);
    expect(store).toMatch(
      /const ordered = \[\.\.\.valid\]\.sort\(/,
    );
  });

  it("appendGroupMessage debounces the file write (never awaits a full save)", () => {
    // O(history) fix: every message used to serialize EVERY group's entire
    // transcript inline. The in-memory append + notify stay synchronous;
    // the write is scheduled and chained so rapid rounds cannot drop state.
    expect(store).toMatch(/schedulePersist\(\);\s*\n\s*notify\(\);\s*\n\s*return m;/);
    expect(store).toMatch(/function schedulePersist\(\): void \{/);
    expect(store).toMatch(/persistInFlight = \(persistInFlight \?\? Promise\.resolve\(\)\)/);
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
    expect(chat).toMatch(
      /const changed = activeProjectRuntime\?\.id !== runtime\.id;/,
    );
    expect(chat).toMatch(/if \(changed\) \{\s*activeProjectVersion\+\+;/);
  });

  it("the pill gate uses the panel's expanded boolean (not the store surface)", () => {
    expect(panel).toMatch(
      /activeProjectGroups\.length > 0 &&\s*!expanded \? \(/,
    );
  });
});
