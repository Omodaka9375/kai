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
    expect(workspace).toContain("inert={!isActive");
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

  it("does not pass a dropdown event object as a project path", () => {
    const switcher = readFileSync(new URL("../modules/workspace/ProjectsSwitcher.tsx", import.meta.url), "utf8");
    expect(switcher).toContain("onClick={() => onAdd()}");
    expect(switcher).toContain("onSelect={() => onAdd()}");
    expect(switcher).not.toContain("onClick={onAdd}");
    expect(switcher).not.toContain("onSelect={onAdd}");
  });

  it("groups sessions under projects with archive and background controls", () => {
    const switcher = readFileSync(new URL("../modules/workspace/ProjectsSwitcher.tsx", import.meta.url), "utf8");
    const input = readFileSync(new URL("../modules/ai/components/AiInputBar.tsx", import.meta.url), "utf8");
    expect(switcher).toContain("onSwitchSession");
    expect(switcher).toContain("onArchiveSession");
    expect(switcher).toContain("New agent session");
    expect(bridge).toContain("notifyBackgroundAgent");
    expect(input).toContain("c.submit({ background: e.altKey })");
    expect(composer).toContain("setSessionPreferences(sessionId, { draft:");
  });

  it("wraps window roots in a visible RootErrorBoundary so a render crash is never a silent blank", () => {
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    const settings = readFileSync(new URL("../settings/main.tsx", import.meta.url), "utf8");
    expect(main).toContain('<RootErrorBoundary surface="main">');
    expect(settings).toContain('<RootErrorBoundary surface="settings">');
  });

  it("renders the switcher with only the original project props and guards session wiring", () => {
    const header = readFileSync(new URL("../modules/header/Header.tsx", import.meta.url), "utf8");
    const switcher = readFileSync(new URL("../modules/workspace/ProjectsSwitcher.tsx", import.meta.url), "utf8");
    expect(header).toContain("onSwitchProject && onAddProject && onCloseProject ?");
    expect(header).not.toContain("onSwitchProject && onSwitchSession &&");
    expect(switcher).toContain("Array.isArray(sessions) ? sessions : []");
  });
});
