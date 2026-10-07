import { describe, expect, it, beforeEach, vi } from "vitest";
import { handleGoalCommand } from "./goalHandler";
import { SLASH_COMMANDS, tryRunSlashCommand } from "./slashCommands";
import { useGoalsStore } from "../store/goalsStore";

// The goals store persists via Tauri IPC (LazyStore + invoke + the
// Kai://ai-goals-changed event) — none of which exists in the Node test
// environment ("window is not defined"). Mock the storage layer and the
// event API so this test exercises the handler routing + store state
// transitions, not Tauri plumbing.
const savedGoals: Map<string, unknown> = new Map();
vi.mock("../lib/goals", async (importOriginal) => {
  const real = await importOriginal<
    typeof import("../lib/goals")
  >();
  return {
    ...real,
    loadGoals: vi.fn(async () =>
      (savedGoals.get("goals") as import("../lib/goals").Goal[]) ?? [],
    ),
    newGoalId: real.newGoalId,
    upsertGoal: vi.fn(async (goal: import("../lib/goals").Goal) => {
      savedGoals.set("goals", [
        ...((savedGoals.get("goals") as import("../lib/goals").Goal[]) ?? []),
        goal,
      ]);
    }),
    removeGoal: vi.fn(async (id: string) => {
      savedGoals.set(
        "goals",
        ((savedGoals.get("goals") as import("../lib/goals").Goal[]) ?? []).filter(
          (g) => g.id !== id,
        ),
      );
    }),
  };
});
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => undefined),
}));

/**
 * End-to-end routing for /goal: registry presence, both invocation
 * prefixes (typed `/goal` and picker-generated `#goal …`), every
 * sub-command, and the contract-validation path.
 *
 * The picker path was the original gap: the composer composes
 * `#goal <text>` for picked commands, but handleGoalCommand matched
 * only `/goal` strings — the command silently fell through to a normal
 * chat message. Locked here so both prefixes stay wired.
 */

const CONTRACT =
  "**Objective:** Fix all failing tests\n" +
  "**Validate:** `pytest -q`\n" +
  "**Stop when:** `pytest -q` exits zero";

describe("goal command routing", () => {
  beforeEach(() => {
    // Reset the store between tests: goals accumulate in-memory and
    // activeGoalId affects the bare `/goal` status branch.
    savedGoals.clear();
    useGoalsStore.setState({ goals: [], activeGoalId: null });
  });

  it("goal is registered in SLASH_COMMANDS (picker visibility)", () => {
    expect(SLASH_COMMANDS.goal).toBeDefined();
    expect(SLASH_COMMANDS.goal.invocation).toBe("/goal");
  });

  it("typed /goal with no active goal surfaces guidance, handled", async () => {
    const r = await handleGoalCommand("/goal");
    expect(r.handled).toBe(true);
    expect(r.error).toContain("No active goal");
  });

  it("picker-form #goal routes identically to /goal", async () => {
    const r = await handleGoalCommand("#goal");
    expect(r.handled).toBe(true);
    expect(r.error).toContain("No active goal");
  });

  it("#goal <contract> creates a goal (the picker+text path)", async () => {
    const r = await handleGoalCommand(`#goal ${CONTRACT}`);
    expect(r.handled).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.goalId).toBeDefined();
    const g = useGoalsStore
      .getState()
      .goals.find((x) => x.id === r.goalId);
    expect(g?.objective).toContain("Fix all failing tests");
    expect(g?.validateCommand).toBe("pytest -q");
    expect(useGoalsStore.getState().activeGoalId).toBe(r.goalId);
  });

  it("invalid contract returns a format error, handled (not sent to chat)", async () => {
    const r = await handleGoalCommand("/goal just do the thing");
    expect(r.handled).toBe(true);
    expect(r.error).toContain("Invalid goal contract");
    expect(r.goalId).toBeUndefined();
  });

  it("tryRunSlashCommand dispatches #goal to the handler", async () => {
    const r = await tryRunSlashCommand(`#goal ${CONTRACT}`);
    expect(r.kind).toBe("handled");
    if (r.kind === "handled") {
      expect(r.goalId).toBeDefined();
      // Cleanup for the created goal.
      if (r.goalId) useGoalsStore.getState().removeGoal(r.goalId);
    }
  });

  it("non-goal text is not intercepted", async () => {
    const r = await handleGoalCommand("hello world");
    expect(r.handled).toBe(false);
  });
});
