import { LazyStore } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";

const STORE_PATH = "kai-goals.json";
const KEY_GOALS = "goals";

export type GoalStatus =
  | "pursuing"
  | "paused"
  | "achieved"
  | "unmet"
  | "budget-limited";

export type Checkpoint = {
  step: number;
  action: string;
  validationResult?: {
    command: string;
    passed: boolean;
    output: string;
  };
  timestamp: string;
};

export type Goal = {
  id: string;
  objective: string;
  constraints: string[];
  validateCommand: string;
  stopCondition: string;
  status: GoalStatus;
  checkpoints: Checkpoint[];
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
};

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export async function loadGoals(): Promise<Goal[]> {
  return (await store.get<Goal[]>(KEY_GOALS)) ?? [];
}

export async function saveGoals(list: Goal[]): Promise<void> {
  await store.set(KEY_GOALS, list);
  await store.save();
}

export async function getGoal(id: string): Promise<Goal | null> {
  const list = await loadGoals();
  return list.find((g) => g.id === id) ?? null;
}

export async function upsertGoal(goal: Goal): Promise<void> {
  const list = await loadGoals();
  const idx = list.findIndex((g) => g.id === goal.id);
  const next =
    idx === -1
      ? [...list, goal]
      : list.map((g) => (g.id === goal.id ? goal : g));
  await saveGoals(next);
}

export async function removeGoal(id: string): Promise<void> {
  const list = await loadGoals();
  const next = list.filter((g) => g.id !== id);
  await saveGoals(next);
}

export async function getActiveGoal(): Promise<Goal | null> {
  const list = await loadGoals();
  return list.find((g) => g.status === "pursuing") ?? null;
}

export function newGoalId(): string {
  return `goal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Parse a goal contract from markdown format. */
export function parseGoalContract(text: string): Partial<Goal> {
  const lines = text.split("\n");
  const result: Partial<Goal> = {
    objective: "",
    constraints: [],
    validateCommand: "",
    stopCondition: "",
  };

  let currentSection: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section headers
    if (trimmed.startsWith("**Objective:**")) {
      currentSection = "objective";
      result.objective = trimmed.replace(/\*\*Objective:\*\*\s*/, "").trim();
      continue;
    }
    if (trimmed.startsWith("**Constraints:**")) {
      currentSection = "constraints";
      result.constraints = [];
      continue;
    }
    if (trimmed.startsWith("**Validate:**")) {
      currentSection = "validate";
      result.validateCommand = trimmed
        .replace(/\*\*Validate:\*\*\s*/, "")
        .replace(/`/g, "")
        .trim();
      continue;
    }
    if (trimmed.startsWith("**Stop when:**")) {
      currentSection = "stop";
      result.stopCondition = trimmed
        .replace(/\*\*Stop when:\*\*\s*/, "")
        .trim();
      continue;
    }
    if (trimmed.startsWith("**Read first:**")) {
      currentSection = "read";
      continue;
    }

    // Collect content based on current section
    if (currentSection === "constraints" && trimmed.length > 0 && result.constraints) {
      result.constraints.push(trimmed);
    }
  }

  return result;
}

/** Run validation command and return result. */
export async function runValidationCommand(
  command: string,
): Promise<{ passed: boolean; output: string }> {
  try {
    const output = await invoke<string>("shell_run_command", {
      command,
      cwd: null,
    });

    // Heuristic: if output contains "error" or "failed" (case-insensitive), mark as failed
    const lower = output.toLowerCase();
    const passed =
      !lower.includes("error") &&
      !lower.includes("failed") &&
      !lower.includes("failure");

    return { passed, output };
  } catch (e) {
    return {
      passed: false,
      output: `Validation command failed: ${String(e)}`,
    };
  }
}
