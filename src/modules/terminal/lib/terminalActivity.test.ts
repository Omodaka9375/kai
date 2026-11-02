import { describe, expect, it } from "vitest";
import {
  markTerminalActive,
  markTerminalIdle,
  projectHasRunningTerminal,
  runningTerminalProjects,
} from "./terminalActivity";

/** Pure-store contract for the rail's terminal-activity dot. Leaf ids are
 *  process-global (idAllocator), so the map is correct across projects. */
describe("terminalActivity — per-project running-command tracking", () => {
  it("marks a leaf active for its owning project and reports it", () => {
    markTerminalActive(11, "project-a");
    expect(projectHasRunningTerminal("project-a")).toBe(true);
    expect(runningTerminalProjects().has("project-a")).toBe(true);
    markTerminalIdle(11);
    expect(projectHasRunningTerminal("project-a")).toBe(false);
  });

  it("keeps projects independent — closing one leaf does not darken another", () => {
    markTerminalActive(21, "project-a");
    markTerminalActive(22, "project-a");
    markTerminalActive(31, "project-b");
    markTerminalIdle(21);
    expect(projectHasRunningTerminal("project-a")).toBe(true); // leaf 22 still runs
    expect(projectHasRunningTerminal("project-b")).toBe(true);
    markTerminalIdle(22);
    expect(projectHasRunningTerminal("project-a")).toBe(false);
    expect(projectHasRunningTerminal("project-b")).toBe(true); // untouched
    markTerminalIdle(31);
  });

  it("idle marks are no-ops for unknown leaves (safe on dispose races)", () => {
    expect(() => markTerminalIdle(9999)).not.toThrow();
  });

  it("re-marking the same leaf with the same project does not notify", () => {
    markTerminalActive(41, "project-c");
    markTerminalActive(41, "project-c"); // dedup path
    expect(projectHasRunningTerminal("project-c")).toBe(true);
    markTerminalIdle(41);
    expect(projectHasRunningTerminal("project-c")).toBe(false);
  });
});

/** Source pin: the OSC 133 tracker must fire the start hook the session
 *  layer uses to light the dot on C ONLY — never B. B fires at every prompt
 *  render (all shells embed it in PS1/prompt), so wiring it to the dot lit
 *  freshly opened idle tabs permanently green (2026-11-02 user report). */
describe("osc-handlers — command-start hook wiring", () => {
  it("registerPromptTracker fires onCommandStart on C ONLY, never B", async () => {
    const osc = await import("./osc-handlers");
    // Minimal fake terminal: capture the registered OSC 133 handler.
    const handlers = new Map<number, (data: string) => boolean>();
    let registered = 0;
    const term = {
      parser: {
        registerOscHandler: (code: number, cb: (data: string) => boolean) => {
          handlers.set(code, cb);
          registered++;
          return { dispose: () => {} };
        },
      },
      registerMarker: () => ({ dispose: () => {}, isDisposed: false }),
    } as never;
    let started = 0;
    let ended = 0;
    const tracker = osc.registerPromptTracker(
      term,
      undefined,
      () => ended++,
      () => started++,
    );
    // A freshly opened tab's FIRST prompt render: D;0 A ... B. This is the
    // phantom-dot repro — B must NOT fire the start hook.
    handlers.get(133)?.("D;0");
    handlers.get(133)?.("A");
    handlers.get(133)?.("B");
    expect(started).toBe(0);
    // A real submission: C fires the hook.
    handlers.get(133)?.("C");
    expect(started).toBe(1);
    // And the next prompt render clears it via D.
    handlers.get(133)?.("D;0");
    expect(ended).toBe(2); // the initial D;0 plus this one
    tracker.dispose();
    expect(registered).toBe(1);
  });
});
