import { useGoalsStore } from "../store/goalsStore";
import { parseGoalContract } from "./goals";

/**
 * Handle /goal slash commands.
 * Returns true if the command was handled (should not be sent as normal message).
 */
export async function handleGoalCommand(text: string): Promise<{
  handled: boolean;
  goalId?: string;
  error?: string;
}> {
  const trimmed = text.trim();

  // /goal (status) - show current goal status
  if (trimmed === "/goal") {
    const activeGoalId = useGoalsStore.getState().activeGoalId;
    if (!activeGoalId) {
      return { handled: true, error: "No active goal. Use `/goal <contract>` to start one." };
    }
    const goal = useGoalsStore.getState().goals.find((g) => g.id === activeGoalId);
    if (!goal) {
      return { handled: true, error: "Active goal not found." };
    }
    return {
      handled: true,
      goalId: goal.id,
    };
  }

  // /goal pause
  if (trimmed === "/goal pause") {
    const activeGoalId = useGoalsStore.getState().activeGoalId;
    if (!activeGoalId) {
      return { handled: true, error: "No active goal to pause." };
    }
    useGoalsStore.getState().pauseGoal(activeGoalId);
    return { handled: true, goalId: activeGoalId };
  }

  // /goal resume
  if (trimmed === "/goal resume") {
    const activeGoalId = useGoalsStore.getState().activeGoalId;
    if (!activeGoalId) {
      // Try to find a paused goal
      const pausedGoal = useGoalsStore.getState().goals.find(
        (g) => g.status === "paused",
      );
      if (!pausedGoal) {
        return { handled: true, error: "No paused goal to resume." };
      }
      useGoalsStore.getState().resumeGoal(pausedGoal.id);
      return { handled: true, goalId: pausedGoal.id };
    }
    useGoalsStore.getState().resumeGoal(activeGoalId);
    return { handled: true, goalId: activeGoalId };
  }

  // /goal clear
  if (trimmed === "/goal clear") {
    const activeGoalId = useGoalsStore.getState().activeGoalId;
    if (!activeGoalId) {
      return { handled: true, error: "No active goal to clear." };
    }
    useGoalsStore.getState().removeGoal(activeGoalId);
    return { handled: true };
  }

  // /goal <contract> - create new goal
  if (trimmed.startsWith("/goal ")) {
    const contract = trimmed.slice(6).trim();
    if (!contract) {
      return {
        handled: true,
        error: "Goal contract is empty. Use `/goal <objective>`. See the goal-loop skill for format.",
      };
    }

    try {
      const parsed = parseGoalContract(contract);

      if (!parsed.objective || !parsed.validateCommand || !parsed.stopCondition) {
        return {
          handled: true,
          error:
            "Invalid goal contract. Must include: Objective, Validate command, and Stop condition. Example:\n\n" +
            "**Objective:** Migrate Pydantic v1 to v2\n" +
            "**Validate:** `pytest -q`\n" +
            "**Stop when:** All tests pass with zero deprecation warnings",
        };
      }

      const goal = await useGoalsStore.getState().createGoal({
        objective: parsed.objective,
        constraints: parsed.constraints ?? [],
        validateCommand: parsed.validateCommand,
        stopCondition: parsed.stopCondition,
      });

      return { handled: true, goalId: goal.id };
    } catch (e) {
      return {
        handled: true,
        error: `Failed to create goal: ${String(e)}`,
      };
    }
  }

  return { handled: false };
}

/**
 * Get the goal context for the agent's system prompt.
 */
export function getGoalContext(goalId?: string): string | null {
  if (!goalId) return null;

  const goal = useGoalsStore.getState().goals.find((g) => g.id === goalId);
  if (!goal || goal.status !== "pursuing") return null;

  const checkpoints =
    goal.checkpoints.length > 0
      ? `
## Progress Checkpoints

${goal.checkpoints
  .map(
    (cp) =>
      `Step ${cp.step}: ${cp.action} - ${
        cp.validationResult?.passed ? "✅ Passed" : "❌ Failed"
      }`,
  )
  .join("\n")}`
      : "No checkpoints yet.";

  return `
## GOAL MODE — ACTIVE

You are pursuing a specific goal with a verification loop.

### Objective
${goal.objective}

### Constraints
${goal.constraints.map((c) => `- ${c}`).join("\n")}

### Validation Command
Run this command after each change to verify progress:
\`\`\`bash
${goal.validateCommand}
\`\`\`

### Stop Condition
${goal.stopCondition}

### Progress
${checkpoints}

### Rules
1. After each action, run the validation command
2. Check if the stop condition is met
3. If NOT met → continue with next action (do NOT wait for user input)
4. If met → mark goal as achieved and summarize
5. If blocked or uncertain → pause and ask for clarification
6. Document each checkpoint with a brief progress log
`;
}
