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
    // 2026-11-02 round 2: activation rides WorkspaceActiveContext — the
    // workspace takes NO isActive prop (a prop flip reconciled BOTH
    // flipping workspaces on every switch; with live agent streams that
    // was the residual switch lag).
    expect(shell).toContain("<WorkspaceActiveProvider value={project.id === activeId}>");
    expect(shell).toContain("<ProjectWorkspace />");
    expect(shell).not.toContain("<ProjectWorkspace isActive=");
    expect(workspace).toMatch(/export const ProjectWorkspace = memo\(function ProjectWorkspace\(\) \{/);
    expect(shell).toContain("inert={project.id !== activeId ? true : undefined}");
    expect(shell).toContain("project.id !== activeId && \"invisible pointer-events-none\"");
    // Visibility/inert must live on the absolute-positioned project WRAPPER.
    // A transparent, hit-testable wrapper otherwise covers the foreground
    // project, while inert inside an exiting workspace leaves AI clicks dead.
    expect(workspace).not.toContain("inert={!isActive");
    expect(workspace).toContain("<ActiveSurfaces");
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
    // Approval responses ride applyApprovalResponseToChat (stranded-part
    // fix) — the bridge no longer destructures the SDK's applier.
    expect(bridge).toContain("const { status, messages } = useChat");
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
    // 2026-11-02 round 2: the provider value is unconditional in the body;
    // foreground routing happens inside the trigger component (a body-level
    // activation ternary here re-rendered the whole tree on every switch).
    expect(workspace).toContain("<FileMenuTriggerProvider value={fileMenuTrigger}>");
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
    const gate = readFileSync(new URL("./workspaceActivation.tsx", import.meta.url), "utf8");
    // The expanded geometry itself (including the --kai-workspace-left read)
    // lives in the shared AiWindowBackdrop const so the corner-crack matte
    // can never drift from the rect the window paints.
    const backdrop = readFileSync(new URL("../modules/ai/components/AiWindowBackdrop.tsx", import.meta.url), "utf8");
    expect(backdrop).toContain("--kai-workspace-left");
    expect(miniWindow).toContain("AI_EXPANDED_WINDOW_GEOMETRY");
    // Foreground-only gate inside onResize (ref read - no body subscription)…
    expect(workspace).toContain("if (isActiveRef.current) writeWorkspaceLeft(size.inPixels);");
    // …and the activation re-sync lives in the GATE now (a project switch
    // resizes nothing, so without the re-sync the var would keep the
    // outgoing project's width).
    expect(gate).toMatch(/useEffect\(\(\) => \{\s*if \(!isActive\) return;[\s\S]*?writeWorkspaceLeft\(getSidebarPx\(\)\);/);
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
    const gate = readFileSync(new URL("./workspaceActivation.tsx", import.meta.url), "utf8");
    // 2026-11-02 round 2: the hydrate bootstrap lives in the activation gate.
    expect(gate).toContain("hydrateSessions(root, projectRuntime)");
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

  it("the workspaces are memoized and never subscribe to activation or the global session id", () => {
    expect(workspace).toMatch(/export const ProjectWorkspace = memo\(function ProjectWorkspace\(\) \{/);
    expect(workspace).toContain("function ProjectSessionStamp");
    // The stamp subscribes the ACTIVATION CONTEXT itself (round 2).
    expect(workspace).toMatch(/function ProjectSessionStamp\(\{[\s\S]*?useWorkspaceActive\(\)/);
    const bodyIdx = workspace.indexOf("export const ProjectWorkspace = memo(function ProjectWorkspace");
    // The GLOBAL session-id selector must appear ONLY inside tiny gate
    // children, never in the memoized workspace body's own hooks.
    expect(workspace.slice(bodyIdx)).not.toContain("useChatStore((s) => s.activeSessionId)");
  });

  it("the workspace BODY never subscribes to activation (2026-11-02 round 2)", () => {
    const bodyIdx = workspace.indexOf("export const ProjectWorkspace = memo(function ProjectWorkspace");
    const body = workspace.slice(bodyIdx);
    // useWorkspaceActive in the body would re-render the whole tree on every
    // project switch — the exact cost this round removes. Only the gate
    // components (defined BEFORE the body) and the stacks may subscribe.
    const bodyHookIdx = body.indexOf("useWorkspaceActive()");
    if (bodyHookIdx !== -1) {
      // Allowed only inside the gate components appended AFTER the body
      // (ActiveRefSink / AgentRunBridgeGate / ActiveSurfaces).
      const afterBody = body.slice(bodyHookIdx);
      expect(afterBody).toContain("function ActiveRefSink");
    }
    // The activation effects live in the null-rendering gate, not the body:
    expect(workspace).toContain("<WorkspaceActivationGate");
    expect(workspace).toContain("function ActiveRefSink");
    expect(workspace).toContain("isActiveRef.current");
  });

  it("open-project routing reads items at event time via getItems()", () => {
    expect(workspace).toContain("projectsMenu.getItems().find(");
    expect(workspace).not.toContain("projectsMenu.items.find(");
  });

  it("the status bar does not subscribe to project-list contexts at all (2026-11-03)", () => {
    // The group-chat button lost its project-count gate (a 1-project
    // install now shows it; personas alone form a valid group), which was
    // the status bar's ONLY rail-context consumer. Zero subscriptions =
    // one less component re-rendering on every project add/remove/switch.
    expect(statusBar).not.toContain("useProjectRailItems");
    expect(statusBar).not.toContain("useProjectsMenu");
  });
});

describe("manual rail order: drag-to-sort projects (2026-11-02)", () => {
  // User-facing feature: drag a project tile onto another to reorder the
  // sidebar. The `projects` array IS the rail order, and the persistence
  // effect saves roots in array order — so a splice-based move covers live
  // preview, persistence, and restore with no extra storage.
  const shell = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const menu = readFileSync(new URL("./projectsMenu.ts", import.meta.url), "utf8");
  const rail = readFileSync(new URL("../modules/workspace/ProjectRail.tsx", import.meta.url), "utf8");

  it("the menu exposes moveProject and AppShell splices the projects array", () => {
    expect(menu).toContain("moveProject: (dragId: string, overId: string) => void;");
    expect(shell).toMatch(/const moveProject = useCallback\(\(dragId: string, overId: string\) => \{/);
    // Splice move: remove at `from`, insert at `to` — the array order is the
    // rail order AND the persisted roots order, so nothing else is needed.
    expect(shell).toContain("next.splice(from, 1);");
    expect(shell).toContain("next.splice(to, 0, moved);");
    // No-ops are safe: dragging onto itself or an unknown id changes nothing.
    expect(shell).toContain("if (dragId === overId) return;");
  });

  it("the rail tiles are draggable and route the drop through the menu action", () => {
    expect(rail).toContain("draggable");
    expect(rail).toMatch(/onDrop=\{\(e\) => \{/);
    expect(rail).toContain("menu?.moveProject(dragId, project.id)");
    // FireFox requires drag data for a drag to start at all.
    expect(rail).toContain('e.dataTransfer.setData("text/plain", project.id)');
    // The drop target must preventDefault or the browser navigates.
    expect(rail).toMatch(/onDragOver=\{\(e\) => \{[\s\S]*?e\.preventDefault\(\)/);
    // Visual affordances: a drop underline on the hovered tile and a tint on
    // the dragged tile.
    expect(rail).toContain("bg-primary/80");
    expect(rail).toContain("bg-primary/10");
    // State resets on both drop and drag end — no stale indicators.
    expect(rail).toMatch(/onDragEnd=\{\(\) => \{[\s\S]*?setDragId\(null\)/);
  });

  it("drag handlers stay OUTSIDE the switch button — dragging never triggers a switch", () => {
    // The draggable wrapper is the tile's parent div; the button inside
    // keeps its plain onClick. A drag would ALSO fire a click after drop in
    // some embedders if handlers were on the button itself.
    const buttonIdx = rail.indexOf("aria-label={`Switch to ${project.name}`}");
    const dragStartIdx = rail.indexOf("onDragStart=");
    expect(dragStartIdx).toBeGreaterThan(-1);
    expect(buttonIdx).toBeGreaterThan(dragStartIdx);
  });
});


describe("activation follow-up hardening (2026-11-02 review, fixes 2-5)", () => {
  const shell = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const terminalStack = readFileSync(
    new URL("../modules/terminal/TerminalStack.tsx", import.meta.url),
    "utf8",
  );
  const previewStack = readFileSync(
    new URL("../modules/preview/PreviewStack.tsx", import.meta.url),
    "utf8",
  );
  const shortcuts = readFileSync(new URL("./useAppShortcuts.ts", import.meta.url), "utf8");

  it("menuActions is identity-stable across switches (changeEnvironment reads refs)", () => {
    // FIX 2: an unstable changeEnvironment re-rendered EVERY memoized
    // workspace body on every switch via the ProjectsMenuContext.
    expect(shell).toMatch(/const changeEnvironment = useCallback\(\(id: string, env: WorkspaceEnv, home: string \| null\) => \{[\s\S]*?\}, \[\]\);/);
    expect(shell).toContain("activeIdRef.current");
    expect(shell).toContain("projectsRef.current");
  });

  it("stacks have NO projectVisible default (the ?? workspaceActive path must be live)", () => {
    // FIX 3: `projectVisible = true` made `projectVisible ?? workspaceActive`
    // dead code - background panes kept inline visibility:visible which
    // OVERRODE the wrapper's invisible class (ghost paint + click capture).
    expect(terminalStack).not.toContain("projectVisible = true,");
    expect(previewStack).not.toContain("projectVisible = true,");
    expect(terminalStack).toContain("const projectActive = projectVisible ?? workspaceActive;");
    expect(previewStack).toContain("const projectActive = projectVisible ?? workspaceActive;");
  });

  it("shortcuts read activation at EVENT time (getter, never a mount-time value)", () => {
    // FIX 4: a boolean frozen at body-render time; the memoized body never
    // re-renders on a switch, so shortcuts stayed routed to the pre-switch
    // workspace (Cmd+T spawned tabs in hidden projects).
    expect(shortcuts).toContain("isActive?: () => boolean;");
    expect(shortcuts).toContain("if (isActive && !isActive()) return true;");
    expect(shortcuts).toContain("isActive = () => true,");
  });
});
