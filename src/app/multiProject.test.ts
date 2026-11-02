import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Structural regressions for retained project workspaces. Native/PTY behavior
 * is covered elsewhere; these pins keep project switching from reverting to
 * destructive reset or foreground chat binding. */
describe("multi-project workspace ownership", () => {
  const shell = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const workspace = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const bridge = readFileSync(new URL("../modules/ai/components/AgentRunBridge.tsx", import.meta.url), "utf8");
  const composer = readFileSync(new URL("../modules/ai/components/composer.tsx", import.meta.url), "utf8");

  it("keeps every project mounted and switches visibility, not resetWorkspace", () => {
    expect(shell).toContain("projects.map((project)");
    expect(shell).toContain("<ProjectWorkspace isActive={project.id === activeId}");
    // 2026-11-02: memoized — a status-transition or foreign-project
    // re-render of AppShell no longer reconciles every workspace.
    expect(workspace).toMatch(/export const ProjectWorkspace = memo\(function ProjectWorkspace/);
    expect(workspace).toContain("projectVisible={isActive}");
    expect(shell).toContain("inert={project.id !== activeId ? true : undefined}");
    expect(shell).toContain("project.id !== activeId && \"invisible pointer-events-none\"");
    // Visibility/inert must live on the absolute-positioned project WRAPPER.
    // A transparent, hit-testable wrapper otherwise covers the foreground
    // project, while inert inside an exiting workspace leaves AI clicks dead.
    expect(workspace).not.toContain("inert={!isActive");
    expect(workspace).toContain("isActive && miniOpen && hasComposer");
    expect(workspace).toContain("projectsMenu.addProject(path)");
  });

  it("persists full root+environment project records", () => {
    expect(shell).toContain("roots: projects.map((p) => ({ root: p.root, env: p.env }))");
    expect(shell).toContain("createProjectRuntime(root, env)");
  });

  it("binds the agent bridge to the owning project's session", () => {
    expect(bridge).toContain("getProjectActiveSession(runtime.id)");
    expect(bridge).toContain("subscribeProjectActiveSessions");
    expect(bridge).not.toContain("const sessionId = useChatStore((s) => s.activeSessionId)");
  });

  it("routes file attachments to their owning project", () => {
    expect(composer).toContain("detail.projectId !== runtime.id");
    expect(workspace).toContain("projectId: projectRuntime.id");
  });

  it("keeps bridge status one-way from the SDK, without a status feedback loop", () => {
    expect(bridge).toContain("const { status, messages, addToolApprovalResponse } = useChat");
    expect(bridge).not.toContain("const status = sessionMeta.status");
  });

  it("uses an always-visible project rail, not a header dropdown", () => {
    const header = readFileSync(new URL("../modules/header/Header.tsx", import.meta.url), "utf8");
    const rail = readFileSync(new URL("../modules/workspace/ProjectRail.tsx", import.meta.url), "utf8");
    expect(workspace).toContain("<ProjectRail");
    // 2026-11-02: the rail pulls live items from its OWN context — the
    // items no longer ride the menu context every workspace consumed.
    expect(rail).toContain("useProjectRailItems()");
    expect(workspace).not.toContain("projects={projectsMenu?.items ?? []}");
    expect(header).not.toContain("ProjectsSwitcher");
    expect(header).not.toContain("onSwitchProject");
    expect(rail).toContain('aria-label="Open projects"');
    expect(rail).toContain("onClick={() => onSwitch(project.id)}");
    // The + is a DROP-UP with both entries (user ask 2026-10-31): New
    // Project creates a folder and opens it; Open Project keeps the old
    // folder-pick flow. Popover-based — the rail stays DropdownMenu-free.
    expect(rail).toContain("New Project");
    expect(rail).toContain("Open Project");
    expect(rail).toContain("void onNewProject()");
    expect(rail).toContain("void onAdd()");
    expect(rail).toContain('side="top"');
    expect(rail).not.toContain("DropdownMenu");
    // The hamburger occupies the rail's top-left slot, not a duplicate header
    // position. Only the active workspace may supply the File menu trigger.
    expect(rail).toContain("{fileMenuTrigger}");
    expect(workspace).toContain("value={isActive ? fileMenuTrigger : null}");
    // Context reaches DESCENDANTS only: a rail above the provider always
    // receives null, leaving the hamburger blank in production.
    const provider = workspace.indexOf("<FileMenuTriggerProvider");
    const projectRail = workspace.indexOf("<ProjectRail");
    expect(provider).toBeGreaterThanOrEqual(0);
    expect(projectRail).toBeGreaterThan(provider);
  });

  it("places a full-width status bar directly beneath the left control rows", () => {
    const rail = readFileSync(new URL("../modules/workspace/ProjectRail.tsx", import.meta.url), "utf8");
    expect(workspace).toContain("<div style={{ height: SIDEBAR_RAIL_HEIGHT }} className=\"shrink-0\">");
    expect(rail).toContain("style={{ height: SIDEBAR_RAIL_HEIGHT }}");
    expect(rail).not.toContain("h-9");
    expect(workspace).not.toContain("className=\"h-9 shrink-0 border-t border-border/60\"");
    // The footer is a sibling of the flex ROW containing the project rail
    // and workspace, not inside the workspace column beside the rail.
    const projectRail = workspace.indexOf("<ProjectRail");
    const rowEnd = workspace.indexOf("</main>");
    const statusBar = workspace.indexOf("<StatusBar");
    expect(projectRail).toBeLessThan(rowEnd);
    expect(rowEnd).toBeLessThan(statusBar);
  });

  it("positions the expanded AI window from the FOREGROUND project's sidebar only", () => {
    // --kai-workspace-left is document-global, but every project mounts its
    // own sidebar panel and background panels fire onResize on mount. The var
    // must therefore be written ONLY by the active instance's onResize and
    // re-synced on every activation — otherwise the expanded window renders
    // at the outgoing/stale offset and covers the incoming project's tree.
    const miniWindow = readFileSync(new URL("../modules/ai/components/AiMiniWindow.tsx", import.meta.url), "utf8");
    expect(miniWindow).toContain("--kai-workspace-left");
    // Foreground-only gate inside onResize…
    expect(workspace).toContain("if (isActive) writeWorkspaceLeft(size.inPixels);");
    // …and an activation re-sync (a project switch resizes nothing, so
    // without this the var would keep the outgoing project's width).
    expect(workspace).toMatch(/useEffect\(\(\) => \{\s*if \(!isActive\) return;[\s\S]*?writeWorkspaceLeft\(px\);/);
  });

  it("keeps session and archive controls in the AI window, not the project rail", () => {
    const menu = readFileSync(new URL("./projectsMenu.ts", import.meta.url), "utf8");
    const rail = readFileSync(new URL("../modules/workspace/ProjectRail.tsx", import.meta.url), "utf8");
    const input = readFileSync(new URL("../modules/ai/components/AiInputBar.tsx", import.meta.url), "utf8");
    expect(rail).not.toContain("sessions");
    expect(rail).not.toContain("onSwitchSession");
    expect(menu).not.toContain("switchSession");
    expect(menu).not.toContain("archiveSession");
    // No OS popups from the agent pipeline (removed 2026-10-29) — the
    // rail dot is the attention surface.
    expect(bridge).not.toContain("notifyBackgroundAgent");
    expect(input).toContain("c.submit({ background: e.altKey })");
    expect(composer).toContain("setSessionPreferences(sessionId, { draft:");
  });

  it("never creates or reassigns a chat as a side effect of switching projects", () => {
    const miniWindow = readFileSync(new URL("../modules/ai/components/AiMiniWindow.tsx", import.meta.url), "utf8");
    expect(miniWindow).not.toContain("} else {\n        newSession();");
    expect(workspace).toContain("if (projectIdForSession(activeChatSessionId) !== projectRuntime.id) return;");
    expect(workspace).not.toContain("if (activeChatSessionId) setSessionPreferences(activeChatSessionId, { projectId: projectRuntime.id });");
  });

  it("hydrates against an explicitly owned project runtime", () => {
    const store = readFileSync(new URL("../modules/ai/store/chatStore.ts", import.meta.url), "utf8");
    expect(workspace).toContain("hydrateSessions(root, projectRuntime)");
    expect(store).toContain("const hydrationRuntime = runtime ?? activeProjectRuntime");
    expect(store).toContain("const liveActiveId = hydrationRuntime");
  });

  it("wraps window roots in a visible RootErrorBoundary so a render crash is never a silent blank", () => {
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    const settings = readFileSync(new URL("../settings/main.tsx", import.meta.url), "utf8");
    expect(main).toContain('<RootErrorBoundary surface="main">');
    expect(settings).toContain('<RootErrorBoundary surface="settings">');
  });

  it("closing a project asks via the themed dialog — never window.confirm (a Tauri WebView no-op)", () => {
    // window.confirm() returns false SILENTLY in the Tauri WebView, so a
    // confirm guard there is dead code — the rail X either never closed
    // anything or closed instantly with no confirmation. The X must go
    // through the AlertDialog state machine (arm -> user -> perform).
    expect(shell).not.toContain("window.confirm");
    expect(shell).toContain('<AlertDialogContent size="sm">');
    expect(shell).toContain('AlertDialogAction variant="destructive" onClick={performClose}');
    expect(shell).toContain("setCloseConfirm({");
  });
});

describe("switch-cost contract: a switch re-renders one workspace (2026-11-02)", () => {
  // User report: "running 3 parallel projects and switching between them
  // is glitching and freezing hard." Root causes were RENDER CASCADES, not
  // PTY work: (a) AppShell subscribed to subscribeSessionAgentMeta — a
  // version bump per ~50ms throttle flush of EVERY streaming agent — and
  // re-rendered AppShell → ALL mounted workspaces on each tick; (b) the
  // menu context carried `items`, so every status bump also invalidated
  // the context every workspace consumed; (c) each ProjectWorkspace itself
  // subscribed to the GLOBAL activeSessionId, so every session switch
  // re-rendered every workspace. All three are gone: status ticks
  // subscribe nowhere above the rail, items live in a rail-only context,
  // the global session id moved into a null-rendering stamp child, and
  // ProjectWorkspace is memoized so AppShell re-renders don't reconcile
  // unchanged workspaces.
  const shell = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const workspace = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const menu = readFileSync(new URL("./projectsMenu.ts", import.meta.url), "utf8");
  const statusBar = readFileSync(new URL("../modules/statusbar/StatusBar.tsx", import.meta.url), "utf8");

  it("AppShell does not subscribe to per-tick agent-meta or session prefs", () => {
    expect(shell).not.toContain("subscribeSessionAgentMeta");
    expect(shell).not.toContain("subscribeSessionPreferences");
    expect(shell).toContain("subscribeProjectAgentStatus");
  });

  it("the menu context carries actions + getItems only; items live in a rail-only context", () => {
    expect(menu).toContain("getItems: () => ProjectSwitcherItem[];");
    expect(menu).toContain("ProjectRailItemsContext");
    expect(shell).toContain("<ProjectsMenuContext.Provider value={menuActions}>");
    expect(shell).toContain("<ProjectRailItemsContext.Provider value={items}>");
  });

  it("the workspaces are memoized and free of the global session subscription", () => {
    expect(workspace).toMatch(/export const ProjectWorkspace = memo\(function ProjectWorkspace/);
    expect(workspace).toContain("function ProjectSessionStamp");
    expect(workspace).toContain("<ProjectSessionStamp isActive={isActive} projectRuntime={projectRuntime} />");
    const stampIdx = workspace.indexOf("function ProjectSessionStamp");
    const bodyIdx = workspace.indexOf("export const ProjectWorkspace = memo(function ProjectWorkspace");
    // The GLOBAL session-id selector must appear ONLY inside the stamp
    // child, not in the memoized workspace body after it.
    expect(stampIdx).toBeLessThan(bodyIdx);
    expect(workspace.slice(bodyIdx)).not.toContain("useChatStore((s) => s.activeSessionId)");
  });

  it("open-project routing reads items at event time via getItems()", () => {
    expect(workspace).toContain("projectsMenu.getItems().find(");
    expect(workspace).not.toContain("projectsMenu.items.find(");
  });

  it("the status bar reads rail items from the rail context, not the menu", () => {
    expect(statusBar).toContain("useProjectRailItems()");
    expect(statusBar).not.toContain("useProjectsMenu");
  });
});
