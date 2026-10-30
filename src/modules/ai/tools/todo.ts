import { tool } from "ai";
import { z } from "zod";
import { newTodoId, normalizeTodos, type Todo } from "../lib/todos";
import { useTodosStore } from "../store/todoStore";
import type { ToolContext } from "./context";

const TodoStatus = z.enum(["pending", "in_progress", "completed"]);

export function buildTodoTools(ctx: ToolContext) {
  return {
    todo_write: tool({
      needsApproval: false,
      description:
        "Replace your current task list. Use this for any non-trivial multi-step task (≥3 substantive steps). Mark exactly one item `in_progress` while you work on it; flip it to `completed` and the next to `in_progress` as you go. The tool replaces the previous list — always pass the FULL list, not a delta. REUSE the previous list's ids and titles verbatim, changing only statuses; do not invent new ids or renumber. Call it at plan creation and at real transitions (step done / next started) — not after every tool call. Auto-executes (no approval).",
      inputSchema: z.object({
        todos: z
          .array(
            z.object({
              id: z
                .string()
                .optional()
                .describe(
                  "Stable id; generated if omitted. Reuse ids across calls to keep UI stable.",
                ),
              title: z.string().min(1),
              description: z.string().optional(),
              status: TodoStatus,
            }),
          )
          .describe("The complete list of todos for this task."),
      }),
      execute: async ({ todos }) => {
        const sessionId = ctx.getSessionId();
        if (!sessionId)
          return { error: "no active session; cannot persist todos" };

        const withIds: Todo[] = todos.map((t) => ({
          id: t.id ?? newTodoId(),
          title: t.title,
          description: t.description,
          status: t.status,
        }));

        // Normalize instead of reject: shape mistakes (duplicate ids, two
        // in_progress items, empty titles) are repaired and reported — the
        // list lands on the first call instead of burning a retry turn.
        const { todos: normalized, repairs } = normalizeTodos(withIds);

        if (normalized.length === 0 && todos.length > 0) {
          return {
            error:
              "every todo had an empty title — nothing to save. Pass titles as non-empty strings.",
          };
        }

        useTodosStore.getState().setTodos(sessionId, normalized);

        return {
          ok: true,
          count: normalized.length,
          inProgress:
            normalized.find((t) => t.status === "in_progress")?.title ?? null,
          ...(repairs.length > 0 ? { repairs } : {}),
        };
      },
    }),
  } as const;
}
