import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  loadGoals,
  newGoalId,
  upsertGoal,
  removeGoal as removeGoalFromStorage,
  type Goal,
  type Checkpoint,
} from "../lib/goals";
import {
  runValidationCommand,
  checkGoalCompletion,
  updateGoalStatus as updateGoalStatusAuto,
} from "../lib/goalAutomation";

const CHANGED_EVENT = "Kai://ai-goals-changed";

type GoalsState = {
  hydrated: boolean;
  goals: Goal[];
  activeGoalId: string | null;
  hydrate: () => Promise<void>;
  createGoal: (goal: Omit<Goal, "id" | "createdAt" | "updatedAt" | "status" | "checkpoints">) => Promise<Goal>;
  updateGoal: (goal: Goal) => void;
  removeGoal: (id: string) => void;
  setActiveGoal: (id: string | null) => void;
  pauseGoal: (id: string) => void;
  resumeGoal: (id: string) => void;
  addCheckpoint: (goalId: string, checkpoint: Omit<Checkpoint, "timestamp">) => void;
  updateValidation: (goalId: string, checkpointIndex: number, validation: { command: string; passed: boolean; output: string }) => void;
  // Automation methods
  runValidation: (goalId: string, command: string) => Promise<{ passed: boolean; output: string }>;
  checkCompletion: () => Promise<{ achieved: boolean; reason: string }>;
  updateGoalStatus: (goalId: string) => Promise<void>;
};

let initialized = false;

export const useGoalsStore = create<GoalsState>((set, get) => ({
  hydrated: false,
  goals: [],
  activeGoalId: null,
  hydrate: async () => {
    if (initialized) return;
    initialized = true;
    const list = await loadGoals();
    const active = list.find((g) => g.status === "pursuing")?.id ?? null;
    set({ goals: list, activeGoalId: active, hydrated: true });
    void listen(CHANGED_EVENT, async () => {
      const list = await loadGoals();
      const active = list.find((g) => g.status === "pursuing")?.id ?? null;
      set({ goals: list, activeGoalId: active });
    });
  },
  createGoal: async (data) => {
    const id = newGoalId();
    const now = new Date().toISOString();
    const goal: Goal = {
      ...data,
      id,
      status: "pursuing",
      checkpoints: [],
      createdAt: now,
      updatedAt: now,
    };
    await upsertGoal(goal);
    set((state) => ({
      goals: [...state.goals, goal],
      activeGoalId: id,
    }));
    void emit(CHANGED_EVENT);
    return goal;
  },
  updateGoal: async (goal) => {
    await upsertGoal(goal);
    set((state) => ({
      goals: state.goals.map((g) => (g.id === goal.id ? goal : g)),
      activeGoalId: goal.status === "pursuing" ? goal.id : state.activeGoalId,
    }));
    void emit(CHANGED_EVENT);
  },
  removeGoal: async (id) => {
    await removeGoalFromStorage(id);
    set((state) => ({
      goals: state.goals.filter((g) => g.id !== id),
      activeGoalId: state.activeGoalId === id ? null : state.activeGoalId,
    }));
    void emit(CHANGED_EVENT);
  },
  setActiveGoal: (id) => {
    set({ activeGoalId: id });
  },
  pauseGoal: async (id) => {
    const list = get().goals;
    const goal = list.find((g) => g.id === id);
    if (!goal || goal.status !== "pursuing") return;
    const updated: Goal = { ...goal, status: "paused", updatedAt: new Date().toISOString() };
    await upsertGoal(updated);
    set({
      goals: list.map((g) => (g.id === id ? updated : g)),
      activeGoalId: null,
    });
    void emit(CHANGED_EVENT);
  },
  resumeGoal: async (id) => {
    const list = get().goals;
    const goal = list.find((g) => g.id === id);
    if (!goal || goal.status !== "paused") return;
    const updated: Goal = { ...goal, status: "pursuing", updatedAt: new Date().toISOString() };
    await upsertGoal(updated);
    set({
      goals: list.map((g) => (g.id === id ? updated : g)),
      activeGoalId: id,
    });
    void emit(CHANGED_EVENT);
  },
  addCheckpoint: async (goalId, checkpoint) => {
    const list = get().goals;
    const goal = list.find((g) => g.id === goalId);
    if (!goal) return;
    const newCheckpoint: Checkpoint = {
      step: checkpoint.step,
      action: checkpoint.action,
      validationResult: checkpoint.validationResult,
      timestamp: new Date().toISOString(),
    };
    const updated: Goal = {
      ...goal,
      checkpoints: [...goal.checkpoints, newCheckpoint],
      updatedAt: new Date().toISOString(),
    };
    await upsertGoal(updated);
    set({ goals: list.map((g) => (g.id === goalId ? updated : g)) });
    void emit(CHANGED_EVENT);
  },
  updateValidation: async (goalId, checkpointIndex, validation) => {
    const list = get().goals;
    const goal = list.find((g) => g.id === goalId);
    if (!goal || !goal.checkpoints[checkpointIndex]) return;
    const updatedCheckpoints = [...goal.checkpoints];
    const currentCheckpoint = updatedCheckpoints[checkpointIndex];
    updatedCheckpoints[checkpointIndex] = {
      ...currentCheckpoint,
      validationResult: validation,
    };
    const updated: Goal = {
      ...goal,
      checkpoints: updatedCheckpoints,
      updatedAt: new Date().toISOString(),
    };
    await upsertGoal(updated);
    set({ goals: list.map((g) => (g.id === goalId ? updated : g)) });
    void emit(CHANGED_EVENT);
  },
  // Automation methods
  runValidation: async (_goalId, command) => {
    return await runValidationCommand(command);
  },
  checkCompletion: async () => {
    // Read active goal from store and check completion
    const goals = get().goals;
    const activeGoal = goals.find(g => g.status === "pursuing");
    if (!activeGoal) return { achieved: false, reason: "No active goal" };
    return await checkGoalCompletion(activeGoal.id);
  },
  updateGoalStatus: async (goalId) => {
    await updateGoalStatusAuto(goalId);
    // Reload goals after status update
    const list = await loadGoals();
    const active = list.find((g) => g.status === "pursuing")?.id ?? null;
    set({ goals: list, activeGoalId: active });
    void emit(CHANGED_EVENT);
  },
}));

export { newGoalId };
