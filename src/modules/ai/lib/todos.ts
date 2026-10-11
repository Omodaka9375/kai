import { LazyStore } from "@tauri-apps/plugin-store";

export type TodoStatus = "pending" | "in_progress" | "completed";

export type Todo = {
  id: string;
  title: string;
  description?: string;
  status: TodoStatus;
};

const STORE_PATH = "kai-todos.json";
const todosKey = (sessionId: string) => `todos:${sessionId}`;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export async function loadTodos(sessionId: string): Promise<Todo[]> {
  return (await store.get<Todo[]>(todosKey(sessionId))) ?? [];
}

export async function saveTodos(
  sessionId: string,
  todos: Todo[],
): Promise<void> {
  await store.set(todosKey(sessionId), todos);
}

export async function deleteTodos(sessionId: string): Promise<void> {
  await store.delete(todosKey(sessionId));
}

export function newTodoId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Normalize a candidate todo list into a valid one, repairing the common
 * model-authored shape mistakes instead of rejecting them:
 *  - trim titles; drop items with empty titles
 *  - dedupe repeated ids (later wins)
 *  - clamp to at most one `in_progress` (first stays, the rest demote to pending)
 *
 * Rejection burns a whole tool-call round trip; normalization lands the
 * intent on the first try. Returns the cleaned list plus a short report of
 * what was repaired so the model can adjust its next write.
 */
export function normalizeTodos(todos: Todo[]): { todos: Todo[]; repairs: string[] } {
  const repairs: string[] = [];

  // 1. Trim titles; drop empty-titled items.
  let cleaned = todos.filter((t) => t.title?.trim());
  if (cleaned.length !== todos.length) {
    repairs.push(`dropped ${todos.length - cleaned.length} empty-titled item(s)`);
  }
  cleaned = cleaned.map((t) => ({ ...t, title: t.title.trim() }));

  // 2. Dedupe repeated ids — later occurrence wins (model re-sent the list
  // with one updated item).
  const byId = new Map<string, Todo>();
  for (const t of cleaned) {
    if (t.id && byId.has(t.id)) {
      repairs.push(`duplicate id "${t.id}" merged (kept the later entry)`);
    }
    byId.set(t.id ?? newTodoId(), t);
  }
  cleaned = [...byId.values()];

  // 3. At most one in_progress — first wins, the rest demote to pending.
  let sawInProgress = false;
  cleaned = cleaned.map((t) => {
    if (t.status === "in_progress") {
      if (sawInProgress) {
        repairs.push(`"${t.title}" demoted to pending (only one in_progress allowed)`);
        return { ...t, status: "pending" as const };
      }
      sawInProgress = true;
    }
    return t;
  });

  return { todos: cleaned, repairs };
}

/**
 * Validate a candidate todo list:
 *  - At most one item with status `in_progress` (anti-drift invariant).
 *  - Titles must be non-empty.
 * Returns null on valid, otherwise an error string.
 *
 * Kept for callers that must hard-validate (e.g. UI edits); the agent tool
 * path uses normalizeTodos so shape mistakes never burn a turn.
 */
export function validateTodos(todos: Todo[]): string | null {
  let inProgress = 0;
  for (const t of todos) {
    if (!t.title.trim()) return "todo title cannot be empty";
    if (t.status === "in_progress") inProgress++;
  }
  if (inProgress > 1)
    return `only one todo may be in_progress at a time (got ${inProgress})`;
  return null;
}
