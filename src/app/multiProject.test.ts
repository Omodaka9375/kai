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
});
