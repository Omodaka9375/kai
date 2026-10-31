import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Desktop-digest contract (2026-10-31): OS toasts return for the HIDDEN
 * window only - approval / error-settled / run-completely-finished -
 * coalescing parallel-project bursts into one toast. The pins cover the
 * user's rules: no toast while visible, one toast per burst, re-show
 * drops the queue, approvals skip the wait.
 */

const state = {
  visible: true,
  minimized: false,
  toasts: [] as { title: string; body: string }[],
};

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isVisible: async () => state.visible,
    isMinimized: async () => state.minimized,
  }),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  sendNotification: vi.fn((o: { title: string; body: string }) => {
    state.toasts.push(o);
  }),
}));

import { offerToDigest, drainDigest, resetDigestForTests } from "./desktopDigest";

beforeEach(() => {
  state.visible = true;
  state.minimized = false;
  state.toasts.length = 0;
  resetDigestForTests();
});

describe("desktopDigest", () => {
  it("never toasts while the window is visible", async () => {
    state.visible = true;
    offerToDigest({ project: "a", kind: "done", detail: "" });
    await drainDigest();
    expect(state.toasts).toHaveLength(0);
  });

  it("toasts once for a single hidden-window event", async () => {
    state.visible = false;
    offerToDigest({ project: "proj-a", kind: "done", detail: "" });
    await drainDigest();
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]!.body).toContain("proj-a finished");
  });

  it("coalesces a parallel burst into ONE toast with collapsed lines", async () => {
    state.visible = false;
    offerToDigest({ project: "a", kind: "done", detail: "" });
    offerToDigest({ project: "b", kind: "done", detail: "" });
    offerToDigest({ project: "c", kind: "error", detail: "" });
    await drainDigest();
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]!.body).toContain("a finished");
    expect(state.toasts[0]!.body).toContain("b finished");
    expect(state.toasts[0]!.body).toContain("c stopped on an error");
  });

  it("a re-shown window during the coalescing window drops the queue", async () => {
    state.visible = false;
    offerToDigest({ project: "a", kind: "done", detail: "" });
    state.visible = true; // user came back before the drain
    await drainDigest();
    expect(state.toasts).toHaveLength(0);
  });

  it("same (project, kind) within a burst collapses to a count", async () => {
    state.visible = false;
    offerToDigest({ project: "a", kind: "done", detail: "" });
    offerToDigest({ project: "a", kind: "done", detail: "" });
    await drainDigest();
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]!.body).toContain("a finished (x2)");
  });

  it("the pair re-arms after a drain: a later run offers again", async () => {
    state.visible = false;
    offerToDigest({ project: "a", kind: "done", detail: "" });
    await drainDigest();
    offerToDigest({ project: "a", kind: "done", detail: "" });
    await drainDigest();
    expect(state.toasts).toHaveLength(2);
  });

  it("minimized counts as hidden", async () => {
    state.visible = true;
    state.minimized = true;
    offerToDigest({ project: "a", kind: "approval", detail: "1 pending" });
    await drainDigest();
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]!.body).toContain("needs your approval");
  });
});
