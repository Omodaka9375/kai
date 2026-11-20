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
    // The rail's own color scheme: fill for the header strip, css for the dot.
    expect(grid).toContain("projectIconFillCss(color, projectId, active)");
    expect(grid).toContain("projectIconCss(color, projectId)");
  });

  it("transcript wrapper bounds height AND width so hover-scroll and wrapping work", () => {
    // min-h-0: the Conversation (flex-1 overflow-y-auto) gets a bounded
    // height, so wheel-over-card scrolls that card. min-w-0: a flex item
    // defaults to min-width:auto - without it a wide code block inflates
    // the wrapper past the narrow card and the card clips on the right
    // instead of the block scrolling INSIDE the card.
    // The wrapper is now TranscriptFrame (clip fades + the bounded-flex
    // contract live together).
    expect(grid).toContain('className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"');
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
    expect(railWrap).toContain("pointer-events-none !w-0");
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
    // The panel mirrors its component-local openGroupId into the grid.
    expect(grid).toContain("export function mirrorOpenGroupId");
    const panel = readFileSync(
      new URL("./GroupChatPanelView.tsx", import.meta.url),
      "utf8",
    );
    expect(panel).toContain("mirrorOpenGroupId(stackSurface === \"group\" ? openGroupId : null)");
  });

  it("each card header carries an Ask/Allow pill bound to its own session", () => {
    // Same state as the project chat's AutoApproveToggle: the session-
    // scoped map via the version counter, written through the session-
    // targeted setter (NOT the legacy presentation field that follows the
    // foreground session). Not nested inside the open-project button.
    expect(grid).toContain("<SessionApprovePill sessionId={sessionId} />");
    expect(grid).toContain("setSessionAutoApprove(sessionId, mode === \"off\" ? \"all\" : \"off\")");
    expect(grid).toContain("getSessionAutoApprove(sessionId)");
    expect(grid).toContain("subscribeSessionAutoApprove");
    // The session-targeted setter exists in the store.
    const store = readFileSync(
      new URL("../store/chatStore.ts", import.meta.url),
      "utf8",
    );
    expect(store).toContain("export function setSessionAutoApprove(");
    // No button-in-button: the pill renders in the header DIV. Slice budget
    // covers the drag-to-reorder grip + its comment (2026-11-20).
    const headerBlock = grid.slice(
      grid.indexOf("Slim header"),
      grid.indexOf("Slim header") + 2200,
    );
    expect(headerBlock).toContain("<div");
    expect(headerBlock).toContain("<SessionApprovePill");
  });

  it("the status bar hides in Workspaces mode", () => {
    expect(app).toContain("{!chatGridOpen && (\n            <StatusBar");
  });

  it("the radio marquee re-homes into the header while the status bar is gone", () => {
    expect(header).toContain("chatGridOpen && radioEnabled");
    expect(header).toContain("<RadioMarquee />");
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
    expect(grid).toContain('className="flex shrink-0 items-center gap-1 border-b border-border/40 px-3 py-1.5"');
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
    expect(grid).toMatch(/compact\n\s*\/>/);
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
    expect(grid).toContain("draggable");
    expect(grid).toContain("onDragStartCell");
    expect(grid).toContain("onDragOverCell");
    expect(grid).toContain("onDragEndCell");
    expect(grid).toContain("const order = dragOrder ?? gridOrder;");
    expect(grid).toContain("void setGridOrder(dragOrder)");
    // Grip affordance renders in the header.
    expect(grid).toContain("Drag02Icon");
    // The order persists in the preferences store (sanitized + synced).
    const store = readFileSync(
      new URL("../../settings/store.ts", import.meta.url),
      "utf8",
    );
    expect(store).toContain("export async function setGridOrder(");
    expect(store).toContain("function sanitizeGridOrder(");
    expect(store).toContain('[KEY_GRID_ORDER]: "gridOrder"');
  });

  it("busy state is a card-level glow - no header dot, no status label", () => {
    // 2026-11-20: the card itself pulses (kai-card-glow, project color via
    // --kai-card-glow; error = destructive). The old header dot and the
    // "idle/running" label are gone.
    expect(grid).toContain("kai-card-glow");
    expect(grid).toContain('"--kai-card-glow"');
    expect(grid).toContain('status !== "idle" && "kai-card-glow"');
    expect(grid).not.toContain("statusLabel");
    // The glow color rides the same projectIconCss the dot used, and the
    // stylesheet defines the animation + reduced-motion opt-out.
    expect(grid).toContain("projectIconCss(color, projectId)");
    const headerBlock = grid.slice(
      grid.indexOf("Slim header"),
      grid.indexOf("Slim header") + 2200,
    );
    expect(headerBlock).not.toContain("size-1.5");
    const css = readFileSync(
      new URL("../../../styles/globals.css", import.meta.url),
      "utf8",
    );
    expect(css).toContain("@keyframes kai-card-glow");
    expect(css).toContain("prefers-reduced-motion");
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
});
