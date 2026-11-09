import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Tab drag/reorder contract — source pins.
 *
 * The VS Code-parity rework (geometry preview + commit-once-on-drop) exists
 * because the old drag was "jumpy and hard to move". These pins guard the
 * specific behaviors that made it jumpy, so a future edit can't quietly
 * reintroduce them:
 *
 *  1. Activation is MANUAL - pointerdown focus never activates a tab, so
 *     dragging a background tab can't trigger activation + the
 *     scroll-active-into-view effect MID-DRAG.
 *  2. No click-flash: setDraggingId is never called from pointerdown; a
 *     DRAG_THRESHOLD_PX separates click from drag.
 *  3. Commit-once: onMove is called from the drop path only - never on
 *     pointermove - so the tab array (and the whole App tree) is not
 *     re-rendered per crossing, and crossing/uncrossing a tab edge any
 *     number of times is a pure transform preview (no oscillation).
 *  4. The dragged tab follows the cursor via translateX with transition-none;
 *     no scale transform (scaling distorts the tab and its hit box).
 */

const bar = readFileSync(new URL("./TabBar.tsx", import.meta.url), "utf8");
const useTabs = readFileSync(new URL("./lib/useTabs.ts", import.meta.url), "utf8");

describe("tab bar drag contract (source pins)", () => {
  it("activation is manual - focus on pointerdown never activates a tab", () => {
    expect(bar).toContain('activationMode="manual"');
  });

  it("no click-flash: drag visuals engage only past the threshold", () => {
    expect(bar).toContain("DRAG_THRESHOLD_PX");
    // pointerdown arms refs only; setDraggingId must not appear in it.
    const pd = bar.slice(
      bar.indexOf("const onPointerDown"),
      bar.indexOf("const onPointerMove"),
    );
    expect(pd).not.toContain("setDraggingId(");
    // The threshold gate sits before the drag-state engagement.
    expect(bar).toContain("Math.abs(rawDx) < DRAG_THRESHOLD_PX");
  });

  it("commit-once-on-drop: onMove is called only from the drop path", () => {
    // No onMove call while the pointer moves.
    const pm = bar.slice(
      bar.indexOf("const onPointerMove"),
      bar.indexOf("const endDrag"),
    );
    expect(pm).not.toContain("onMove(");
    // The drop path commits exactly one onMove.
    const drop = bar.slice(bar.indexOf("const endDrag"), bar.indexOf("const onPointerUp"));
    expect(drop).toContain("onMove(dragId, hoverId)");
  });

  it("preview is transform-only: the dragged tab has no transition or scale", () => {
    expect(bar).toContain("translateX(");
    expect(bar).toContain("transition-none cursor-grabbing");
    // The old scale flash is gone.
    expect(bar).not.toContain("scale-105");
    // The old "drop indicator" bars (one per non-first tab while dragging)
    // are gone.
    expect(bar).not.toContain("showDropIndicator");
  });

  it("the click after a drag is swallowed so drops never activate tabs", () => {
    expect(bar).toContain("dragJustEndedRef");
    expect(bar).toContain("onClickCapture");
    expect(bar).toContain("e.preventDefault();");
  });

  it("edge auto-scroll exists for long tab bars", () => {
    expect(bar).toContain("EDGE_ZONE_PX");
    expect(bar).toContain("scrollLeft");
  });

  it("moveTab keeps splice semantics (insert at the occupant's slot)", () => {
    const start = useTabs.indexOf("const moveTab");
    const end = useTabs.indexOf("moveTab,", start);
    const move = useTabs.slice(start, end);
    expect(move).toContain("next.splice(to, 0, item)");
    expect(move).toContain("next.splice(from, 1)");
  });
});

// 2026-11-09 report: "while the agent is running EDIT the whole UI flickers
// and if I was on a file tab it would throw me back to terminal". Each edit
// opens an ai-diff tab (stealing focus); closeAiDiffTab's fallback picked the
// FIRST non-diff tab in the array - the terminal. The fix captures the
// pre-diff active tab and restores it on close. useTabs is a hook over
// workspace-local ids, so the contract is pinned at source level.
describe("ai-diff focus restore (source pins)", () => {
  it("openAiDiffTab captures the pre-diff surface, skipping diff-on-diff steals", () => {
    expect(useTabs).toContain("diffReturnTabRef.current = activeIdRef.current");
    expect(useTabs).toMatch(
      /currentTab\.kind !== "ai-diff"[\s\S]{0,80}diffReturnTabRef/,
    );
  });

  it("closeAiDiffTab restores the captured surface instead of the first non-diff tab", () => {
    expect(useTabs).toContain("returnCandidate");
    // The restore is gated on the return target still existing in `next`.
    expect(useTabs).toContain("next.some((t) => t.id === returnCandidate)");
    // The old blind fallback still exists, but only as the last resort.
    expect(useTabs).toContain('next.find((t) => t.kind !== "ai-diff")?.id');
  });

  it("a close for an approval with no open tabs never consumes the pending restore", () => {
    expect(useTabs).toMatch(
      /if \(!tabsRef\.current\.some\(\(t\) => t\.kind === "ai-diff" && t\.approvalId === approvalId\)\) return;/,
    );
  });
});
