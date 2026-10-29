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
    expect(header).not.toContain("ProjectsSwitcher");
    expect(header).not.toContain("onSwitchProject");
    expect(rail).toContain('aria-label="Open projects"');
    expect(rail).toContain("onClick={() => onSwitch(project.id)}");
    expect(rail).toContain("onClick={() => void onAdd()}");
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

  it("keeps session and archive controls in the AI window, not the project rail", () => {
    const menu = readFileSync(new URL("./projectsMenu.ts", import.meta.url), "utf8");
    const rail = readFileSync(new URL("../modules/workspace/ProjectRail.tsx", import.meta.url), "utf8");
    const input = readFileSync(new URL("../modules/ai/components/AiInputBar.tsx", import.meta.url), "utf8");
    expect(rail).not.toContain("sessions");
    expect(rail).not.toContain("onSwitchSession");
    expect(menu).not.toContain("switchSession");
    expect(menu).not.toContain("archiveSession");
    expect(bridge).toContain("notifyBackgroundAgent");
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
});
