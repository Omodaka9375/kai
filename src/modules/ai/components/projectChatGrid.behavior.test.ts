import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * WORKSPACES behavior pins (2026-11-19 ask): the grid is a UNIVERSAL view —
 * named "Workspaces", each card tinted with its project's icon color, per-card
 * hover-scrolling transcripts, sidebar collapse + no per-project AI window
 * underneath while open.
 */
describe("Workspaces grid behavior (source pins)", () => {
  const grid = readFileSync(
    new URL("./ProjectChatGrid.tsx", import.meta.url),
    "utf8",
  );
  const header = readFileSync(
    new URL("../../header/Header.tsx", import.meta.url),
    "utf8",
  );
  const app = readFileSync(
    new URL("../../../app/App.tsx", import.meta.url),
    "utf8",
  );

  it("header toggle is named Workspaces", () => {
    expect(header).toContain("Workspaces — all project chats");
    expect(header).toContain("Close Workspaces (Esc)");
    expect(header).not.toContain("project chat grid");
  });

  it("each card header is tinted with the project's icon color", () => {
    // The rail's own color scheme: fill for the header strip. The per-
    // project css color no longer appears on the card - status colors are
    // now the rail DOT palette (see the busy-ring pin), not the project
    // hue, so a running card cannot be confused with its own icon color.
    expect(grid).toContain("projectIconFillCss(color, projectId, active)");
  });

  it("transcript wrapper bounds height AND width so hover-scroll and wrapping work", () => {
    // min-h-0: the Conversation (flex-1 overflow-y-auto) gets a bounded
    // height, so wheel-over-card scrolls that card. min-w-0: a flex item
    // defaults to min-width:auto - without it a wide code block inflates
    // the wrapper past the narrow card and the card clips on the right
    // instead of the block scrolling INSIDE the card.
    // The wrapper is now TranscriptFrame (clip fades + the bounded-flex
    // contract live together).
    expect(grid).toContain('className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden select-text"');
    expect(grid).toContain("function useTranscriptClips");
  });

  it("grid geometry is absolute full-width (universal, not project-offset)", () => {
    // bottom-2: Workspaces hides both bottom bars, so the cards take the
    // screen down to a small margin (no status-bar strip to reserve).
    expect(grid).toContain('"inset-x-2 top-[2.85rem] bottom-2"');
    // The sidebar-dependent offset var is gone from the grid.
    expect(grid).not.toContain("kai-workspace-left");
    expect(grid).not.toContain("kai-input-bar-h");
  });

  it("ActiveSurfaces renders nothing while the grid is open", () => {
    const i = app.indexOf("function ActiveSurfaces");
    const fn = i < 0 ? "" : app.slice(i, i + 900);
    expect(fn).toContain("gridOpen");
    expect(fn).toContain("if (gridOpen) return null;");
    // The hook read sits ABOVE the isActive early return (React #310 rule).
    const gridHook = fn.indexOf("useProjectChatGridStore");
    const earlyReturn = fn.indexOf("if (!isActive) return null;");
    expect(gridHook).toBeGreaterThan(-1);
    expect(gridHook).toBeLessThan(earlyReturn);
  });

  it("opening the grid collapses the sidebar", () => {
    const fn = app.slice(
      app.indexOf("const toggleChatGrid = useCallback"),
      app.indexOf("const toggleChatGrid = useCallback") + 900,
    );
    expect(fn).toContain("p.collapse()");
  });

  it("the bottom composer hides while the grid is open", () => {
    const fn = app.slice(
      app.indexOf("data-ai-input-bar"),
      app.indexOf("data-ai-input-bar") + 1100,
    );
    expect(fn).toContain("panelOpen && !chatGridOpen");
    expect(fn).toContain('aria-hidden={!panelOpen || chatGridOpen}');
  });

  it("Workspaces mode hides the project rail, sidebar toggle and project name", () => {
    // The rail collapses to zero width + pointer-events-none (mount kept
    // for its subscriptions); the header drops the sidebar toggle and the
    // current-project name (the mode is project-agnostic).
    const railWrap = app.slice(
      app.indexOf("<ProjectRail") - 400,
      app.indexOf("<ProjectRail"),
    );
    expect(railWrap).toContain("pointer-events-none w-0!");
    expect(header).toContain("{!chatGridOpen && (");
    expect(header).toContain("projectName && !compact && !chatGridOpen");
  });

  it("cards lazy-load their project chats without a visit", () => {
    // Every card resolves its project's active session on mount — the
    // background resolver reads the project's own sessions file from disk.
    expect(grid).toContain("resolveBackgroundProjectSession(cell.id)");
    expect(grid).not.toContain("No chat yet — click to load");
  });

  it("clicking a card opens the project AND closes the grid", () => {
    // The grid covers the whole workspace; a bare switch would leave the
    // clicked project hidden underneath (the click looks dead). AppShell
    // wraps switchProject with a grid close.
    const shell = readFileSync(
      new URL("../../../app/AppShell.tsx", import.meta.url),
      "utf8",
    );
    const jsx = shell.indexOf("<SwitchProjectContextProvider");
    const fn = shell.slice(jsx, jsx + 900);
    expect(fn).toContain("setOpen(false)");
    expect(fn).toContain("switchProject(id)");
  });

  it("a card binds to the group panel's group when it is the active surface", () => {
    // groupOfCell: stack rail on "group" + the open group contains the
    // project -> the card renders the GROUP (transcript + group fan-out
    // input), not the project AI chat.
    expect(grid).toContain("groupOfCell(projectId)");
    expect(grid).toContain("liveGroupForProject");
    // 2026-11-19 card paste: the composed body (persisted image paths +
  // text-chip <file> blocks) feeds the same fan-out.
  expect(grid).toContain("sendGroupMessage(group.id, body)");
    expect(grid).toContain("GroupCardBody");
    // The panel mirrors its component-local openGroupId into the shared
    // lib (openGroupUi.ts, 2026-11-26); the grid re-exports it for its own
    // importers.
    expect(grid).toContain("mirrorOpenGroupId,");
    const panel = readFileSync(
      new URL("./GroupChatPanelView.tsx", import.meta.url),
      "utf8",
    );
    expect(panel).toContain("mirrorOpenGroupId(stackSurface === \"group\" ? openGroupId : null)");
  });

  it("each card input carries an Ask/Allow pill on the left bound to its own session", () => {
    // Same state as the project chat's AutoApproveToggle: the session-
    // scoped map via the version counter, written through the session-
    // targeted setter (NOT the legacy presentation field that follows the
    // foreground session). Sits on the left of the card input bar, matching
    // the main AI input bar layout.
    expect(grid).toContain("<SessionApprovePill sessionId={sessionId} />");
    expect(grid).toContain("setSessionAutoApprove(sessionId, mode === \"off\" ? \"all\" : \"off\")");
    // 2026-11-25 TRUST GATE: the pill paints the trust-gated effective mode.
    expect(grid).toContain("effectiveSessionAutoApprove(sessionId)");
    expect(grid).toContain("subscribeSessionAutoApprove");
    // The session-targeted setter exists in the store.
    const store = readFileSync(
      new URL("../store/chatStore.ts", import.meta.url),
      "utf8",
    );
    expect(store).toContain("export function setSessionAutoApprove(");
    const headerBlock = grid.slice(
      grid.indexOf("Slim header"),
      grid.indexOf("GroupCardBody group={group}"),
    );
    expect(headerBlock).toContain("<div");
    expect(headerBlock).not.toContain("<SessionApprovePill");
    // 2026-11-25 DECLUTTER: the standalone + button is GONE from the
    // header - "New session" lives inside the CardSessionPicker dropdown
    // (separated at the bottom), so the right cluster keeps the session picker.
    expect(headerBlock).toContain("<CardSessionPicker");
    expect(headerBlock).not.toContain('title="New session"');
    const titleIdx = headerBlock.indexOf("group ? `${name} · ${group.name}` : name");
    const modelPillIdx = headerBlock.indexOf("<CardModelPill");
    const personaPillIdx = headerBlock.indexOf("<SessionPersonaPill");
    const pickerIdx = headerBlock.indexOf("<CardSessionPicker");
    expect(titleIdx).toBeGreaterThan(-1);
    // PILL ORDER (2026-11-26 ask): the context ring lives INSIDE the model
    // pill, left of the model name; the header no longer renders a
    // standalone ring. Then the persona picker, then the session picker.
    expect(headerBlock).not.toContain("<CardContextRing");
    expect(modelPillIdx).toBeGreaterThan(titleIdx);
    expect(personaPillIdx).toBeGreaterThan(modelPillIdx);
    expect(pickerIdx).toBeGreaterThan(personaPillIdx);
    // The ring renders inside the model pill's trigger, BEFORE the label.
    const pillStart = grid.indexOf("const CardModelPill = memo");
    const pillSrc = grid.slice(pillStart);
    const ringInPill = pillSrc.indexOf("<CardContextRing");
    const labelInPill = pillSrc.indexOf(
      '<span className="truncate">{shortLabel}</span>',
    );
    expect(ringInPill).toBeGreaterThan(-1);
    expect(labelInPill).toBeGreaterThan(ringInPill);
    // 2026-11-26 ask: Ask/Allow pill sits on the LEFT of the card input bar
    // (before the textarea).
    const inputStart = grid.indexOf("const CellInput = memo");
    const inputSrc = grid.slice(inputStart);
    const inputApproveIdx = inputSrc.indexOf("<SessionApprovePill sessionId={sessionId} />");
    const textareaIdx = inputSrc.indexOf("<textarea");
    expect(inputApproveIdx).toBeGreaterThan(-1);
    expect(inputApproveIdx).toBeLessThan(textareaIdx);
    expect(grid).toContain("icon={Shield01Icon}");
  });

  it("the card session picker owns session creation (New session at the dropdown bottom)", () => {
    // 2026-11-25 declutter: the picker lists the project's sessions and
    // ends with a separated "New session" item calling the same
    // project-scoped newSessionForProject - never the foreground newChat.
    const pickerStart = grid.indexOf("const CardSessionPicker");
    const pickerEnd = grid.indexOf("SessionApprovePill = memo");
    expect(pickerStart).toBeGreaterThan(-1);
    const picker = grid.slice(pickerStart, pickerEnd);
    expect(picker).toContain("<DropdownMenuSeparator");
    expect(picker).toContain("newSessionForProject(projectId)");
    expect(picker).toContain("<span>New session</span>");
    // The picker still switches via the project-scoped setter.
    expect(picker).toContain("switchSessionForProject(projectId, id)");
  });

  it("each card input has a + file-upload button right of the mic (2026-11-25 ask)", () => {
    // The + opens a hidden accept= picker and routes picked files into
    // the SAME attachment pipeline paste uses (image pills via
    // cardImageAttachment, text files as content chips) - no separate
    // send-path shape.
    const inputStart = grid.indexOf("const CellInput = memo");
    const inputSrc = grid.slice(inputStart);
    expect(inputStart).toBeGreaterThan(-1);
    expect(inputSrc).toContain('type="file"');
    expect(inputSrc).toContain("accept={ACCEPTED_FILES}");
    expect(inputSrc).toContain("onPickFiles");
    expect(inputSrc).toContain("cardImageAttachment(f)");
    // Position: the + button comes AFTER the mic block in the input strip
    // (mic icon/button first, then the attach affordance).
    const micBtn = inputSrc.indexOf("icon={Mic01Icon} size={13} strokeWidth={1.75}");
    const attachBtn = inputSrc.indexOf('title="Attach file or image"');
    expect(micBtn).toBeGreaterThan(-1);
    expect(attachBtn).toBeGreaterThan(micBtn);
  });

  it("each card header centers a compact model pill with a favorites dropdown", () => {
    expect(grid).toContain("<CardModelPill projectId={projectId} sessionId={sessionId} />");
    expect(grid).toContain("getProjectEffectiveModelId(projectId, sessionId)");
    expect(grid).toContain("setProjectSelectedModelId(projectId, m.id as ModelId)");
    expect(grid).toContain("shortenModelLabel(fullLabel)");
    // Stale favorites (e.g. the removed "proxy-custom" slot) must be
    // filtered through the catalog before getModel, so the dropdown never
    // offers a dead model id.
    expect(grid).toContain("favoriteIds\n        .filter((id) => isKnownModelId(id))\n        .map((id) => getModel(id as ModelId))");
  });

  it("the status bar hides in Workspaces mode", () => {
    expect(app).toContain("{!chatGridOpen && (\n            <StatusBar");
  });

  it("the radio marquee re-homes into the header while the status bar is gone", () => {
    expect(header).toContain("chatGridOpen && radioEnabled");
    expect(header).toContain('<RadioMarquee placement="header" />');
    // CENTERED (2026-11-25): in Workspaces the marquee sits in the MIDDLE
    // of the top bar - a leading flex-1 spacer mounts only in grid mode,
    // the trailing one always exists. Tabs are NOT rendered in Workspaces
    // ({!chatGridOpen && <TabBar/>}), so the spacers only split the empty
    // drag region and cannot squeeze anything.
    expect(header).toMatch(
      /chatGridOpen && radioEnabled && \(\s*<div data-tauri-drag-region className="h-full min-w-2 flex-1" \/>\s*\)/,
    );
    const radio = readFileSync(
      new URL("../../radio/RadioMarquee.tsx", import.meta.url),
      "utf8",
    );
    expect(radio).toContain('align={placement === "header" ? "start" : "end"}');
    expect(radio).toContain('side={placement === "header" ? "bottom" : "top"}');
    // Header placement keeps its own (slightly tighter) width cap so the
    // optical center stays stable while a track scrolls.
    expect(radio).toContain("HEADER_MARQUEE_MAX_WIDTH");
    expect(radio).toContain(
      'placement === "header" ? HEADER_MARQUEE_MAX_WIDTH : MARQUEE_MAX_WIDTH',
    );
  });

  it("cards are uniform - no selected outline in the universal view", () => {
    // Every card shares one border; the active tint must NOT single a
    // card out with a different outline.
    expect(grid).toContain("rounded-xl border border-border/60 bg-background/95");
    expect(grid).not.toContain("border-primary/50");
  });

  it("card regions share one horizontal padding rhythm", () => {
    // Header strip, transcript (via AiChatView contentClassName), group
    // transcript and both card inputs all sit on the same 12px edge.
    // CURSOR (2026-11-21): hover is a POINTER (double-click opens); the
    // grabbing hand only shows during a press / while the card is carried.
    expect(grid).toContain("flex shrink-0 select-none items-center gap-1 border-b border-border/40 px-3 py-1.5");
    expect(grid).toContain('dragging ? "cursor-grabbing" : "cursor-pointer active:cursor-grabbing"');
    expect(grid).not.toContain("cursor-grab ");
    expect(grid).toContain('contentClassName="gap-4 px-3 pb-3"');
    expect(grid).toContain('<Conversation className="px-3 py-2">');
    const px3 = (grid.match(/px-3 /g) ?? []).length;
    expect(px3).toBeGreaterThanOrEqual(3);
    // The chrome rows must not revert to the old 8px edge. (Inner content
    // padding like the group user-bubble's px-2 py-1 is fine.)
    expect(grid).not.toContain("bg-card/40 px-2 py-1");
  });

  it("AiChatView accepts a transcript content class override", () => {
    const chat = readFileSync(
      new URL("./AiChat.tsx", import.meta.url),
      "utf8",
    );
    expect(chat).toContain("contentClassName");
  });

  it("cards render compact tool rows with grouped consecutive calls", () => {
    // Card mode: the grid asks for compact; AiChatView collapses same-tool
    // runs into a ToolGroup chip and renders Tool rows without the leading
    // dot (trailing state dot instead).
    expect(grid).toContain("contentClassName=\"gap-4 px-3 pb-3\"\n            // CARD MODE");
    // `compact` is followed by hideThinking + the owning-session prop.
    expect(grid).toMatch(/compact\n[\s\S]{0,900}?sessionId=\{sessionId\}\n\s*\/>/);
    const chat = readFileSync(
      new URL("./AiChat.tsx", import.meta.url),
      "utf8",
    );
    expect(chat).toContain("const ToolGroup = memo");
    expect(chat).toContain("function groupableToolName");
    expect(chat).toContain("kind: \"calls\"");
    const tool = readFileSync(
      new URL("../../../components/ai-elements/tool.tsx", import.meta.url),
      "utf8",
    );
    expect(tool).toContain("compact?: boolean;");
    expect(tool).toContain("const COMPACT_DOT");
    expect(tool).toContain("export function toolVisualMeta");
  });

  it("send button announces itself once there is text", () => {
    // Empty: muted glyph. Typed: filled primary disc - the action is
    // discoverable without hovering a 12px arrow.
    expect(grid).toContain("bg-primary text-primary-foreground hover:bg-primary/90");
    expect(grid).toContain("canSend");
  });

  it("card inputs accept text + image pastes", () => {
    // Paste plumbing wired on BOTH inputs; pills render for pending
    // attachments; images ride sends as inline file parts.
    expect(grid).toContain("const CardPastePills = memo");
    expect(grid.match(/onPaste=\{onPaste\}/g)?.length).toBe(2);
    expect(grid).toContain("imageFilesFromClipboard");
    expect(grid).toContain("cardImageAttachment");
    expect(grid).toContain("cardPasteChip");
    expect(grid).toContain('type: "file"');
    expect(grid).toContain("persistUploadedMedia");
  });

  it("cards drag-reorder via a persisted gridOrder preference", () => {
    // DRAG-TO-REORDER (2026-11-20): the header strip is the drag handle
    // (body inputs/selection untouched); the live sequence rides
    // dragOrder, the preferences store is written once on dragend.
    // FULL-STRIP DRAG (2026-11-20): the strip itself is draggable - no
    // full-width <button> inside it (buttons swallow dragstart from a
    // draggable ancestor, which is what made the strip undraggable
    // everywhere except the grip icon).
    expect(grid).toContain("draggable");
    expect(grid).toContain("onDragStartCell");
    expect(grid).toContain("onDragOverCell");
    expect(grid).toContain("onDragEndCell");
    expect(grid).toContain("const order = dragOrder ?? gridOrder;");
    expect(grid).toContain("void setGridOrder(dragOrder)");
    const headerStrip = grid.slice(
      grid.indexOf("Slim header"),
      grid.indexOf("GroupCardBody group={group}"),
    );
    expect(headerStrip).not.toMatch(/<button[\s\S]*?open project/);
    expect(headerStrip).toContain("select-none");
    // Grip affordance removed (2026-11-21): the whole strip drags since
    // the full-bar drag fix, so the icon is redundant chrome.
    expect(grid).not.toContain("Drag02Icon");
    // The order persists in the preferences store (sanitized + synced).
    const store = readFileSync(
      new URL("../../settings/store.ts", import.meta.url),
      "utf8",
    );
    expect(store).toContain("export async function setGridOrder(");
    expect(store).toContain("function sanitizeGridOrder(");
    expect(store).toContain('[KEY_GRID_ORDER]: "gridOrder"');
  });

  it("Workspaces mode hides the tab bar and replaces it with a left-aligned + project launcher", () => {
    // 2026-11-21 ask: Workspaces is a multi-CHAT surface, not file work -
    // the file tab strip is hidden in grid mode, and a left-aligned +
    // button (styled like the new-tab + button) opens New Project / Open
    // Project while the rail is collapsed.
    expect(header).toContain("{!chatGridOpen && (\n          <TabBar");
    expect(header).toContain("{chatGridOpen && projectsMenu && (");
    expect(header).toContain("projectsMenu.newProject()");
    expect(header).toContain("projectsMenu.addProject()");
    expect(header).toContain('<span className="flex-1">New Project</span>');
    expect(header).toContain('<span className="flex-1">Open Project</span>');
    // The earlier per-button hideNew prop is gone - hiding must happen at
    // the TabBar mount, not per control inside it.
    const tabBar = readFileSync(
      new URL("../../tabs/TabBar.tsx", import.meta.url),
      "utf8",
    );
    expect(tabBar).not.toContain("hideNew");
  });

  it("the status bar hovers as a pointer and only grabs while pressed", () => {
    // 2026-11-21 ask: "hovering shows a dragging hand, but it is misleading -
    // it should be a pointer so the user knows he can double-click; only on
    // press-and-hold show the grabbing hand".
    const headerStrip = grid.slice(
      grid.indexOf("Slim header"),
      grid.indexOf("GroupCardBody group={group}"),
    );
    expect(headerStrip).toContain("cursor-pointer");
    expect(headerStrip).toContain("active:cursor-grabbing");
    expect(headerStrip).not.toContain("cursor-grab \"");
  });

  it("double-click on the status bar opens the project - single click does not", () => {
    // 2026-11-20 ask: the bar is a drag surface, so a stray single click
    // must not yank the user out of Workspaces. Guard skips double-clicks
    // landing on real controls (Ask/Allow pill owns its clicks).
    expect(grid).toContain("onDoubleClick");
    expect(grid).toContain('closest("button")');
    expect(grid).toContain("double-click to open");
    // The old single-click opener button is gone from the strip.
    const headerStrip = grid.slice(
      grid.indexOf("Slim header"),
      grid.indexOf("GroupCardBody group={group}"),
    );
    expect(headerStrip).not.toContain("switchProject(projectId)}\n        ");
  });

  it("busy state is a card-level ring in the RAIL DOT palette - no dot, no label", () => {
    // 2026-11-20 v3: the card pulses as an OVERLAY span (not a box-shadow
    // on the card root - sibling cards paint over outer shadows in the
    // dense grid, which made the effect invisible). Colors are the rail's
    // tile-dot palette so both surfaces read identically.
    expect(grid).toContain("kai-card-glow");
    expect(grid).toContain('"--kai-card-glow"');
    expect(grid).toContain(
      '{status !== "idle" && <span aria-hidden className="kai-card-glow" />}',
    );
    // Rail dot palette: emerald running / violet awaiting / red error.
    expect(grid).toContain("running: \"#10b981\"");
    expect(grid).toContain("awaiting: \"#8b5cf6\"");
    expect(grid).toContain('error: "var(--destructive)"');
    // The old header dot and status label stay gone.
    expect(grid).not.toContain("statusLabel");
    const headerBlock = grid.slice(
      grid.indexOf("Slim header"),
      grid.indexOf("GroupCardBody group={group}"),
    );
    expect(headerBlock).not.toContain("size-1.5");
    // Stylesheet: overlay ring geometry + animation + reduced-motion.
    const css = readFileSync(
      new URL("../../../styles/globals.css", import.meta.url),
      "utf8",
    );
    expect(css).toContain("@keyframes kai-card-glow");
    expect(css).toContain("prefers-reduced-motion");
    const rule = css.slice(
      css.indexOf(".kai-card-glow {"),
      css.indexOf("@keyframes kai-card-glow"),
    );
    expect(rule).toContain("position: absolute");
    expect(rule).toContain("pointer-events: none");
  });

  it("only ONE hamburger app menu is on screen per mode", () => {
    // 2026-11-21 report: "there are now 2 hamburger file menus in the top
    // bar - the one in the top left which is main, and another one between
    // the sidebar toggle and the grid toggle". The rail already owns the
    // trigger in normal mode; the header copy is the Workspaces-only
    // fallback (the rail is w-0 + pointer-events-none there, so without it
    // Settings would be unreachable).
    expect(header).toContain("{chatGridOpen && fileMenuSlot}");
    // The rail keeps its own mount.
    const rail = readFileSync(
      new URL("../../workspace/ProjectRail.tsx", import.meta.url),
      "utf8",
    );
    expect(rail).toContain("{fileMenuTrigger}");
  });

  it("a group card names the group in its title bar", () => {
    // 2026-11-21 ask: when a project's group chat is the active surface the
    // card swaps from the AI chat to the GROUP transcript - the bar must say
    // so, otherwise the two surfaces look identical.
    expect(grid).toContain("group ? `${name} · ${group.name}` : name");
    expect(grid).toContain(".slice(0, 30)");
    expect(grid).toContain('group "${group.name}"');
  });

  it("the empty transcript renders inside the conversation - never an early return", () => {
    // 2026-11-21 bug: `if (messages.length === 0) return <Conversation>...>`
    // sat ABOVE the scroll hooks. A card mounted on a brand-new session
    // registered 3 fewer hooks than the render carrying the first message;
    // React threw "Rendered more hooks than during the previous render",
    // AiErrorBoundary swallowed it and returned null, and the card went
    // BLANK the moment the user sent the first message.
    const chat = readFileSync(
      new URL("./AiChat.tsx", import.meta.url),
      "utf8",
    );
    const body = chat.slice(
      chat.indexOf("export function AiChatView("),
      chat.indexOf("const CompactionNotice = memo"),
    );
    expect(body).not.toMatch(/if \(messages\.length === 0\) \{\s*return/);
    expect(body).toContain("{messages.length === 0 && (");
    expect(body).toContain("<ConversationEmptyState");
  });

  it("group card transcript rides the shared chat zoom (symmetric with AI cards)", () => {
    // 2026-11-20: the group card's ConversationContent passes the SAME
    // useChatFontSize ratio AiChatView applies - otherwise generated code
    // blocks in AI cards render proportionally larger than group cards
    // whenever the chat font preference is above the 12px default.
    expect(grid).toContain("const chatFontZoomStyle = useChatFontSize().rootStyle;");
    expect(grid).toContain(
      '<ConversationContent className="gap-3" style={chatFontZoomStyle}>',
    );
  });

  it("hides active terminal panes when covered by Workspaces or expanded AI/group window", () => {
    // 2026-11-22 report: "When AI window is expanded or in Workspaces I can
    // see terminal text leaking from behind — only when terminal tabs are
    // open". TerminalStack + TerminalPane set inline `visibility: visible`
    // whenever `tabVisible` is true, and the expanded AI window / Workspaces
    // grid sit inset by 8px (while TerminalStack starts at 4px), leaving a
    // perimeter strip + card gaps where live terminal text bled through.
    const terminalStack = readFileSync(
      new URL("../../terminal/TerminalStack.tsx", import.meta.url),
      "utf8",
    );
    expect(terminalStack).toContain("useProjectChatGridStore((s) => s.open)");
    expect(terminalStack).toContain("s.mini.open && s.mini.expanded");
    expect(terminalStack).toContain("s.groupPanelExpanded");
    expect(terminalStack).toContain("projectActive && !occludedByOverlay && t.id === activeId");
  });

  it("bounds long-chat streaming cost via per-message WeakMap caches and transcript windowing", () => {
    const chat = readFileSync(
      new URL("./AiChat.tsx", import.meta.url),
      "utf8",
    );
    const bridge = readFileSync(
      new URL("./AgentRunBridge.tsx", import.meta.url),
      "utf8",
    );
    const contextTokens = readFileSync(
      new URL("../lib/media/contextTokens.ts", import.meta.url),
      "utf8",
    );
    expect(chat).toContain("const TRANSCRIPT_WINDOW_FULL = 60;");
    expect(chat).toContain("const TRANSCRIPT_WINDOW_COMPACT = 30;");
    expect(chat).toContain("Show earlier messages");
    expect(bridge).toContain("bridgeMessageScanCache = new WeakMap");
    expect(bridge).toContain("scanMessageForBridge(m, i === lastIdx)");
    expect(contextTokens).toContain("messageCharsCache = new WeakMap");
    expect(grid).toContain("getSessionMetaVersionFor(sessionId)");
  });

  it("shows a circle-only context indicator per chat card and a sandbox icon to the left of the project title when active", () => {
    const headerBlock = grid.slice(
      grid.indexOf("Slim header"),
      grid.indexOf("GroupCardBody group={group}"),
    );
    // 2026-11-25: the icon resolves trust-aware (loadSandboxModeForProject)
    // so untrusted new projects show their seeded read-only default.
    const sandboxIdx = headerBlock.indexOf(
      "<CardSandboxIcon root={root} projectId={projectId} />",
    );
    const titleIdx = headerBlock.indexOf("group ? `${name} · ${group.name}` : name");
    const modelPillIdx = headerBlock.indexOf("<CardModelPill");
    const personaPillIdx = headerBlock.indexOf("<SessionPersonaPill");
    const pickerIdx = headerBlock.indexOf("<CardSessionPicker");
    expect(sandboxIdx).toBeGreaterThan(-1);
    expect(titleIdx).toBeGreaterThan(sandboxIdx);
    // PILL ORDER (2026-11-26 ask): the context ring is INSIDE the model pill
    // (left of the model name) - no standalone ring in the header anymore.
    expect(headerBlock).not.toContain("<CardContextRing");
    expect(modelPillIdx).toBeGreaterThan(titleIdx);
    expect(personaPillIdx).toBeGreaterThan(modelPillIdx);
    expect(pickerIdx).toBeGreaterThan(personaPillIdx);
    expect(grid).toContain('if (mode === "off") return null;');
    expect(grid).toContain("<ContextTrigger asChild>");
    // The ring's trigger is a SPAN now (it nests inside the model pill's
    // dropdown-trigger button - nested buttons would break clicks).
    expect(grid).toContain('aria-label="Model context usage"');
    const ringSrc = grid.slice(
      grid.indexOf("const CardContextRing = memo"),
      grid.indexOf("const CardSessionPicker = memo"),
    );
    expect(ringSrc).toContain("<ContextTrigger asChild>");
    expect(ringSrc).not.toContain("<button");
  });

  it("the persona pill resolves the same effective persona the runtime runs under", () => {
    // 2026-11-23 ask: "make sure each selected agent shows the correct
    // icon". The pill read ONLY the session preference; the runtime
    // (chatStore.getAgentPersonaId + chatRuntime activeId fallback)
    // resolves session pref ?? project persona ?? app default. The pill
    // must follow the same chain and re-render on all three feeds.
    expect(grid).toContain("<SessionPersonaPill projectId={projectId} sessionId={sessionId} />");
    const pill = grid.slice(
      grid.indexOf("const SessionPersonaPill = memo"),
      grid.indexOf("const CardModelPill = memo"),
    );
    expect(pill).toContain("getSessionPreferences(sessionId).personaId ??");
    expect(pill).toContain("getProjectPersona(projectId) ??");
    expect(pill).toContain("agentsActiveId ??");
    expect(pill).toContain("subscribeProjectModels");
    expect(pill).toContain("useAgentsStore((s) => s.activeId)");
  });

  it("scopes the header right-click menu to the card top bar only, not the chat body", () => {
    const headerBlock = grid.slice(
      grid.indexOf("Slim header"),
      grid.indexOf("GroupCardBody group={group}"),
    );
    const bodyBlock = grid.slice(
      grid.indexOf("GroupCardBody group={group}"),
      grid.indexOf("const CardSandboxIcon = memo"),
    );
    expect(headerBlock).toContain("<ContextMenu>");
    expect(headerBlock).toContain("<ContextMenuTrigger asChild>");
    // 2026-11-26 rework: close moved to a dedicated X button right of the
    // session picker; the header menu mirrors the rail tile's menu.
    expect(headerBlock).toContain("Change icon...");
    expect(headerBlock).toContain("Reset to default");
    expect(headerBlock).toContain("Untrust project");
    expect(headerBlock).toContain("Trust project");
    expect(headerBlock).not.toContain("Close Project");
    expect(headerBlock).toContain("onClick={closeThisProject}");
    expect(headerBlock).toContain("</ContextMenu>");
    expect(bodyBlock).not.toContain("ContextMenu");
    expect(bodyBlock).not.toContain("Close Project");
  });

  it("reorders cards via CSS Grid order without moving DOM nodes (preserves transcript scroll position)", () => {
    expect(grid).toContain("order: gridOrderIndex");
    expect(grid).toContain("gridOrderIndex={orderMap.get(cell.id) ?? index}");
    // cells must NOT be sorted on dragOrder/gridOrder, which would trigger
    // DOM insertBefore and reset scrollTop = 0 on moved chat transcripts.
    const cellsMemo = grid.slice(
      grid.indexOf("const cells = useMemo("),
      grid.indexOf("const orderMap = useMemo("),
    );
    expect(cellsMemo).not.toContain(".sort(");
  });

  it("keeps card transcript text selectable and stamped for the copy/quote context menu", () => {
    // 2026-11-23 report: "can't select/copy text in chat cards in Workspaces".
    // TranscriptFrame opts back into text selection, and group-card messages
    // carry data-msg-author so App.tsx's contextmenu handler offers Copy.
    expect(grid).toContain(
      "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden select-text",
    );
    expect(grid).toContain('data-msg-author={m.from === "user" ? "You" : nameFor(m.projectId)}');
    // The grid container carries the marker App.tsx uses to recognize
    // Workspaces-card right-clicks.
    expect(grid).toContain("data-project-chat-grid");
  });

  it("stripped persisted image URLs render the placeholder chip, never a corrupted <img>", () => {
    // 2026-11-24 report: "images in Workspaces chat session got corrupted"
    // after the freeze-restart. stripInlineImagesInPlace (sessions.ts)
    // persists `data:image/png;base64,` WITH a trailing comma; the old
    // `url.split(",").length < 2` test returned 2 elements and rendered
    // <img src="data:image/png;base64,"> (broken image) instead of the
    // placeholder. The check must test the PAYLOAD after the comma.
    const chat = readFileSync(
      new URL("./AiChat.tsx", import.meta.url),
      "utf8",
    );
    expect(chat).toContain('!(p.url.split(",")[1] ?? "").trim() ? (');
    expect(chat).not.toContain('p.url.split(",").length < 2 ? (');
    expect(chat).toContain("Image attachment (not stored across restarts)");
  });

  it("strips invisible parts (step-start, hidden reasoning, blank text) before grouping so cards have no phantom gaps", () => {
    // 2026-11-23 report: "In Workspaces chat cards, chat has a lot of spaces
    // between some commands". Each step boundary emitted `step-start` +
    // hidden `reasoning` parts that RenderedPart turned into `null` INSIDE
    // `<PartAppear>` divs, creating empty flex children that multiplied
    // `gap-3` into 24-36px blank voids between tool rows.
    const chat = readFileSync(
      new URL("./AiChat.tsx", import.meta.url),
      "utf8",
    );
    expect(chat).toContain("function isInvisiblePart(");
    expect(chat).toContain("if (isInvisiblePart(p, showModelThinking)) return;");
    expect(chat).toContain('compact ? "gap-1.5" : "gap-3"');
  });

  it("keeps streaming hot paths throttled, observer-stable, and WeakMap-cached (2026-11-24 perf audit)", () => {
    const chat = readFileSync(new URL("./AiChat.tsx", import.meta.url), "utf8");
    const chatText = readFileSync(new URL("../lib/chatText.ts", import.meta.url), "utf8");
    const groupApprovals = readFileSync(new URL("../lib/groupApprovals.ts", import.meta.url), "utf8");
    const bridge = readFileSync(new URL("./AgentRunBridge.tsx", import.meta.url), "utf8");
    // 1. Inline <thinking> path uses throttled text + module-level regex.
    expect(chatText).toContain("const THINKING_SPLIT_RE = new RegExp(");
    expect(chat).toContain("splitThinkingBlocks(throttled)");
    expect(chat).not.toContain("splitThinkingBlocks(raw);\n      // Hidden thinking");
    // 2. useTranscriptClips depends on [ref] (no per-render ResizeObserver churn)
    //    and startCellVoice/stopCellVoice keep stable identity via voiceRef.
    expect(grid).toContain("}, [ref]);");
    expect(grid).toContain("const voiceRef = useRef(voice);");
    // 3. Group approvals scan is WeakMap-cached for settled messages.
    expect(groupApprovals).toContain("messageApprovalCache = new WeakMap");
    // 4. Bridge file-mutation fingerprint caches the settled prefix.
    expect(bridge).toContain("mutationPrefixRef");
  });
});
