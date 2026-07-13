/**
 * Goal Automation Service
 * Provides automatic checkpoint creation and validation for goals
 */

import { native } from "../lib/native";
import { useGoalsStore } from "../store/goalsStore";
import type { Goal } from "./goals";

/**
 * Create a checkpoint automatically based on AI progress
 */
export async function createCheckpoint(
  goalId: string,
  action: string,
  step: number,
  validationResult?: { command: string; passed: boolean; output: string }
): Promise<void> {
  const addCheckpoint = useGoalsStore.getState().addCheckpoint;
  await addCheckpoint(goalId, {
    step,
    action,
    validationResult,
  });
}

/**
 * Run validation command and create checkpoint with result
 */
export async function createCheckpointWithValidation(
  goalId: string,
  action: string,
  step: number,
  validationCommand: string
): Promise<void> {
  const result = await runValidationCommand(validationCommand);
  
  await createCheckpoint(goalId, action, step, {
    command: validationCommand,
    passed: result.passed,
    output: result.output,
  });
}

/**
 * Run validation command
 */
export async function runValidationCommand(
  command: string
): Promise<{ passed: boolean; output: string }> {
  try {
    const result = await native.runCommand(command, null, 60);
    
    // Heuristic: check for error indicators
    const lower = (result.stdout + result.stderr).toLowerCase();
    const passed =
      !lower.includes("error") &&
      !lower.includes("failed") &&
      !lower.includes("failure");

    return { 
      passed, 
      output: result.stdout || result.stderr || "No output"
    };
  } catch (e) {
    return {
      passed: false,
      output: `Validation command failed: ${String(e)}`,
    };
  }
}

/**
 * Auto-validate all pending checkpoints for a goal
 */
export async function autoValidateGoal(goalId: string): Promise<void> {
  const goals = useGoalsStore.getState().goals;
  const goal = goals.find(g => g.id === goalId);
  
  if (!goal || !goal.validateCommand) return;
  
  // Validate all checkpoints that don't have results yet
  for (let i = 0; i < goal.checkpoints.length; i++) {
    const checkpoint = goal.checkpoints[i];
    if (!checkpoint.validationResult) {
      const result = await runValidationCommand(goal.validateCommand);
      
      const updateValidation = useGoalsStore.getState().updateValidation;
      await updateValidation(goalId, i, {
        command: goal.validateCommand,
        passed: result.passed,
        output: result.output,
      });
    }
  }
}

/**
 * Check if goal has achieved its stop condition
 */
export async function checkGoalCompletion(goalId: string): Promise<{
  achieved: boolean;
  reason: string;
}> {
  const goals = useGoalsStore.getState().goals;
  const goal = goals.find(g => g.id === goalId);
  
  if (!goal) {
    return { achieved: false, reason: "Goal not found" };
  }
  
  // Check if all checkpoints passed
  const failedCheckpoints = goal.checkpoints.filter(
    cp => cp.validationResult?.passed === false
  );
  
  if (failedCheckpoints.length > 0) {
    return { 
      achieved: false, 
      reason: `${failedCheckpoints.length} checkpoint(s) failed validation` 
    };
  }
  
  // Check if all checkpoints have passed validation
  const allValidated = goal.checkpoints.every(cp => cp.validationResult?.passed);
  
  if (allValidated && goal.checkpoints.length > 0) {
    return { achieved: true, reason: "All checkpoints passed" };
  }
  
  return { achieved: false, reason: "Not all checkpoints validated yet" };
}

/**
 * Update goal status based on validation results
 */
export async function updateGoalStatus(goalId: string): Promise<void> {
  const goals = useGoalsStore.getState().goals;
  const goal = goals.find(g => g.id === goalId);
  
  if (!goal || goal.status !== "pursuing") return;
  
  const completion = await checkGoalCompletion(goalId);
  
  if (completion.achieved) {
    const updateGoal = useGoalsStore.getState().updateGoal;
    const updated: Goal = {
      ...goal,
      status: "achieved",
      updatedAt: new Date().toISOString(),
    };
    await updateGoal(updated);
  }
}

/**
 * Smart checkpoint creation - analyzes recent actions and creates checkpoints
 */
export async function createSmartCheckpoint(
  goalId: string,
  recentActions: string[]
): Promise<void> {
  const goals = useGoalsStore.getState().goals;
  const goal = goals.find(g => g.id === goalId);
  
  if (!goal) return;
  
  // Analyze recent actions to determine next checkpoint
  const lastCheckpoint = goal.checkpoints[goal.checkpoints.length - 1];
  const nextStep = (lastCheckpoint?.step || 0) + 1;
  
  // Create checkpoint from most recent action
  const action = recentActions[recentActions.length - 1] || "Progress made";
  
  await createCheckpoint(goalId, action, nextStep);
}
