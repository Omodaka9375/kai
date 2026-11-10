import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  getApprovalResponder,
  getSessionSteeringMessage,
  setSessionSteeringMessage,
  useChatStore,
} from "./chatStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({ get: vi.fn(), set: vi.fn(), save: vi.fn() })),
}));

describe("session-scoped approvals and steering", () => {
  it("keeps responders bound to their owning session across foreground changes", () => {
    const a = vi.fn();
    const b = vi.fn();
    useChatStore.getState().setApprovalResponderForSession("project-a-chat", a);
    useChatStore.getState().setApprovalResponderForSession("project-b-chat", b);
    expect(getApprovalResponder("project-a-chat")).toBe(a);
    expect(getApprovalResponder("project-b-chat")).toBe(b);
  });

  it("does not deliver one project's steering queue to another", () => {
    setSessionSteeringMessage("project-a-chat", [{ type: "text", text: "continue A" }]);
    expect(getSessionSteeringMessage("project-a-chat")).toHaveLength(1);
    expect(getSessionSteeringMessage("project-b-chat")).toBeNull();
    setSessionSteeringMessage("project-a-chat", null);
    expect(getSessionSteeringMessage("project-a-chat")).toBeNull();
  });
});

// 2026-11-08 report: "agent from one project ended up in another folder
// after a watch fired while I was on a different project and then switched."
// makeChatSync resolved the owning project ONCE at chat construction and fell
// back to the globally-active live handle when resolution failed - so a wake
// turn (watch fire, LRU re-creation) for a backgrounded session resolved
// ctx.getCwd() to whichever project the USER was viewing, and the agent
// worked in the wrong folder. makeChatSync is not unit-constructible here
// (it pulls the full agent runtime), so the contract is pinned at source
// level like the other drift gates.
describe("wake-turn cwd isolation (source pins)", () => {
  const src = readFileSync(new URL("./chatStore.ts", import.meta.url), "utf8");

  it("re-resolves the owning project per call instead of freezing it at chat creation", () => {
    expect(src).toContain("const liveFor");
    // 2026-11-10: projectLive moved to ./projectRegistry - the accessor
    // must still re-run findProject() PER CALL (never project?.id frozen).
    expect(src).toContain("getProjectLive(findProject()?.id ?? \"\")");
    expect(src).not.toContain("getProjectLive(project?.id ?? \"\")");
  });

  it("anchors unresolved sessions to their own root, never the visible project", () => {
    expect(src).toContain("coarse but CORRECT folder");
    expect(src).toContain("getCwd: () => sessionRoot");
    // The old global-live fallback for a failed resolution must not return.
    expect(src).not.toContain('projectLive.get(project?.id ?? "")');
  });

  it("anchors env/native routing for unresolved sessions to the session's own env", () => {
    expect(src).toContain("createProjectRuntime(sessionRoot, session?.workspaceEnv)");
    // deps.projectRuntime must be the anchored runtime, not the raw match.
    expect(src).toContain("projectRuntime: runtime");
  });
});
