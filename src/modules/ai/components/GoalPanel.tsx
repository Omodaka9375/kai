import { cn } from "@/lib/utils";
import { useGoalsStore } from "../store/goalsStore";
import { motion } from "motion/react";
import { useCallback, useState } from "react";

type GoalStatus = "pursuing" | "paused" | "achieved" | "unmet" | "budget-limited";

export function GoalPanel() {
  const activeGoalId = useGoalsStore((s) => s.activeGoalId);
  const goals = useGoalsStore((s) => s.goals);
  const pauseGoal = useGoalsStore((s) => s.pauseGoal);
  const resumeGoal = useGoalsStore((s) => s.resumeGoal);
  const removeGoal = useGoalsStore((s) => s.removeGoal);
  const runValidation = useGoalsStore((s) => s.runValidation);
  const updateGoalStatus = useGoalsStore((s) => s.updateGoalStatus);

  const [isRunningValidation, setIsRunningValidation] = useState(false);

  const goal = activeGoalId ? goals.find((g) => g.id === activeGoalId) : null;

  if (!goal) return null;

  const handlePause = useCallback(() => {
    pauseGoal(goal.id);
  }, [goal.id, pauseGoal]);

  const handleResume = useCallback(() => {
    resumeGoal(goal.id);
  }, [goal.id, resumeGoal]);

  const handleClear = useCallback(() => {
    removeGoal(goal.id);
  }, [goal.id, removeGoal]);

  const handleRunValidation = useCallback(async () => {
    if (!goal.validateCommand) return;
    setIsRunningValidation(true);
    try {
      const result = await runValidation(goal.id, goal.validateCommand);
      // Update the latest checkpoint with validation result
      const updateValidation = useGoalsStore.getState().updateValidation;
      const lastCheckpointIndex = goal.checkpoints.length - 1;
      if (lastCheckpointIndex >= 0) {
        await updateValidation(goal.id, lastCheckpointIndex, {
          command: goal.validateCommand,
          passed: result.passed,
          output: result.output,
        });
      }
    } finally {
      setIsRunningValidation(false);
    }
  }, [goal.id, goal.validateCommand, runValidation, goal.checkpoints.length]);

  const handleCheckCompletion = useCallback(async () => {
    await updateGoalStatus(goal.id);
  }, [goal.id, updateGoalStatus]);

  const statusBadges: Record<GoalStatus, { label: string; color: string }> = {
    pursuing: { label: "Pursuing", color: "text-green-400" },
    paused: { label: "Paused", color: "text-yellow-400" },
    achieved: { label: "Achieved", color: "text-blue-400" },
    unmet: { label: "Unmet", color: "text-red-400" },
    "budget-limited": { label: "Budget Limited", color: "text-orange-400" },
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="bg-zinc-900 border border-zinc-700 rounded-lg p-4 max-w-2xl mx-auto"
    >
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-zinc-100 mb-1">
            🎯 {goal.objective}
          </h3>
          <div className="flex items-center gap-3 text-sm">
            <span className={cn("font-medium", statusBadges[goal.status].color)}>
              {statusBadges[goal.status].label}
            </span>
            <span className="text-zinc-500">
              Created: {new Date(goal.createdAt).toLocaleString()}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
        <div>
          <p className="text-zinc-400 mb-1">Constraints:</p>
          <ul className="list-disc list-inside text-zinc-300 space-y-1">
            {goal.constraints.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-zinc-400 mb-1">Validation:</p>
          <code className="block bg-zinc-800 px-2 py-1 rounded text-zinc-300">
            {goal.validateCommand}
          </code>
        </div>
      </div>

      <div className="mb-4">
        <p className="text-zinc-400 mb-2">Stop Condition:</p>
        <p className="text-zinc-300 italic">{goal.stopCondition}</p>
      </div>

      {/* Automation Actions */}
      <div className="flex gap-2 mb-4">
        {goal.validateCommand && (
          <button
            onClick={handleRunValidation}
            disabled={isRunningValidation}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 text-white rounded text-sm transition-colors flex items-center gap-1"
          >
            {isRunningValidation ? "⏳" : "▶️"} Run Validation
          </button>
        )}
        <button
          onClick={handleCheckCompletion}
          className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded text-sm transition-colors"
        >
          🎯 Check Completion
        </button>
      </div>

      <div className="mb-4">
        <p className="text-zinc-400 mb-2">
          Checkpoints ({goal.checkpoints.length}):
        </p>
        <div className="space-y-2 max-h-60 overflow-y-auto">
          {goal.checkpoints.length === 0 ? (
            <p className="text-zinc-500 italic">No checkpoints yet...</p>
          ) : (
            goal.checkpoints.map((cp, i) => (
              <div
                key={i}
                className="bg-zinc-800/50 rounded p-2 text-sm border border-zinc-700"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium text-zinc-200">
                    Step {cp.step}: {cp.action}
                  </span>
                  <span className="text-xs text-zinc-500">
                    {new Date(cp.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                {cp.validationResult && (
                  <div
                    className={cn(
                      "mt-1 px-2 py-1 rounded text-xs",
                      cp.validationResult.passed
                        ? "bg-green-500/20 text-green-400"
                        : "bg-red-500/20 text-red-400",
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span>
                        {cp.validationResult.passed ? "✅" : "❌"}{" "}
                        {cp.validationResult.output.slice(0, 100)}
                        {cp.validationResult.output.length > 100 && "..."}
                      </span>
                      <span className={cn(
                        "px-1.5 py-0.5 rounded text-[10px] font-medium",
                        cp.validationResult.passed
                          ? "bg-green-500/20 text-green-400"
                          : "bg-red-500/20 text-red-400"
                      )}>
                        {cp.validationResult.passed ? "Passed" : "Failed"}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex gap-2">
        {goal.status === "pursuing" ? (
          <button
            onClick={handlePause}
            className="px-4 py-2 bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 rounded transition-colors"
          >
            ⏸️ Pause
          </button>
        ) : goal.status === "paused" ? (
          <button
            onClick={handleResume}
            className="px-4 py-2 bg-green-500/20 hover:bg-green-500/30 text-green-400 rounded transition-colors"
          >
            ▶️ Resume
          </button>
        ) : null}
        <button
          onClick={handleClear}
          className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded transition-colors"
        >
          🗑️ Clear
        </button>
      </div>
    </motion.div>
  );
}
