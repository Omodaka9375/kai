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

  it("transcript wrapper bounds height so hover-scroll works", () => {
    // min-h-0 flex-1 flex-col: the Conversation (flex-1 overflow-y-auto)
    // gets a bounded height, so wheel-over-card scrolls that card.
    expect(grid).toContain('"flex min-h-0 flex-1 flex-col overflow-hidden"');
  });

  it("grid geometry is absolute full-width (universal, not project-offset)", () => {
    expect(grid).toContain('"inset-x-2 top-[2.85rem]');
    // The sidebar-dependent offset var is gone from the grid.
    expect(grid).not.toContain("kai-workspace-left");
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
});
