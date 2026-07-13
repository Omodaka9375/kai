import { cn } from "@/lib/utils";
import { useGoalsStore } from "../store/goalsStore";
import { motion } from "motion/react";
import type { Goal } from "../lib/goals";

export function GoalStatusPill() {
  const activeGoalId = useGoalsStore((s) => s.activeGoalId);
  const goals = useGoalsStore((s) => s.goals);

  if (!activeGoalId) return null;

  const goal = goals.find((g) => g.id === activeGoalId);
  if (!goal) return null;

  const statusColors: Record<Goal["status"], string> = {
    pursuing: "bg-green-500/20 text-green-400 border-green-500/30",
    paused: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    achieved: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    unmet: "bg-red-500/20 text-red-400 border-red-500/30",
    "budget-limited": "bg-orange-500/20 text-orange-400 border-orange-500/30",
  };

  const statusIcons: Record<Goal["status"], string> = {
    pursuing: "🎯",
    paused: "⏸️",
    achieved: "✅",
    unmet: "❌",
    "budget-limited": "⚠️",
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm",
        statusColors[goal.status],
      )}
    >
      <span>{statusIcons[goal.status]}</span>
      <span className="font-medium truncate max-w-[200px]">{goal.objective}</span>
      <span className="text-xs opacity-70">
        {goal.checkpoints.length} checkpoints
      </span>
    </motion.div>
  );
}
