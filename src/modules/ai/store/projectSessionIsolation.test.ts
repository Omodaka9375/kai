import { describe, expect, it, vi } from "vitest";
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
