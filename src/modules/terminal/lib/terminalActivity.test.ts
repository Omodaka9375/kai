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

/** Source pin: the OSC 133 tracker must fire the begin hook the session
 *  layer uses to light the dot (B/C), or the dot can never turn on. */
describe("osc-handlers — command-begin hook wiring", () => {
  it("registerPromptTracker accepts an onCommandBegin callback", async () => {
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
    let began = 0;
    let ended = 0;
    const tracker = osc.registerPromptTracker(
      term,
      undefined,
      () => ended++,
      () => began++,
    );
    handlers.get(133)?.("B");
    handlers.get(133)?.("C");
    handlers.get(133)?.("D;0");
    expect(began).toBe(2);
    expect(ended).toBe(1);
    tracker.dispose();
    expect(registered).toBe(1);
  });
});
