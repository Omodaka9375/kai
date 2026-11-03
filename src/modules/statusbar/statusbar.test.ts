import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * StatusBar source pins — the status bar is a thin chrome strip with no
 * isolated render harness (it drags the whole chat-store + preferences
 * graph), so behavioral tests live where the logic lives and this file pins
 * the wiring contracts that have historically regressed.
 */

describe("group-chat entry button (2026-11-03 discoverability fix)", () => {
  const src = readFileSync(new URL("./StatusBar.tsx", import.meta.url), "utf8");

  it("the group button has NO project-count gate — a 1-project install shows it", () => {
    // 2026-11-03 report: a brand-new install has exactly one project open,
    // and `canStartGroup = railItems.length >= 2` meant the icon NEVER
    // rendered — the whole feature was undiscoverable for new users. A
    // single project + agent personas is a fully valid group (personas
    // join without projects), so the button always shows while the AI
    // panel is open.
    expect(src).not.toContain("canStartGroup");
    expect(src).not.toContain("railItems.length >= 2");
    expect(src).not.toContain("useProjectRailItems");
    // The button itself still dispatches the same create event.
    expect(src).toContain('window.dispatchEvent(new CustomEvent("Kai:new-group-chat"))');
  });

  it("the panel's empty-project hint points at personas, not a dead end", () => {
    // The invite picker's projects dropdown can be empty on a 1-project
    // install; the old copy ("Open another project to start a group chat")
    // read as a hard blocker even though personas alone can create a
    // group. The hint now names the persona section below.
    const panel = readFileSync(
      new URL("../ai/components/GroupChatPanelView.tsx", import.meta.url),
      "utf8",
    );
    expect(panel).toContain(
      "No other projects open — invite an agent persona below",
    );
    expect(panel).not.toContain(
      "Open another project to start a group chat.",
    );
  });
});
