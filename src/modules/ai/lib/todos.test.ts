import { describe, expect, it } from "vitest";
import { normalizeTodos, validateTodos, type Todo } from "./todos";

function t(id: string, title: string, status: Todo["status"]): Todo {
  return { id, title, status };
}

describe("normalizeTodos (agent tool path)", () => {
  it("returns a valid list unchanged with no repairs", () => {
    const input = [t("a", "Recon", "completed"), t("b", "Fix", "in_progress"), t("c", "Verify", "pending")];
    const { todos, repairs } = normalizeTodos(input);
    expect(todos).toEqual(input);
    expect(repairs).toEqual([]);
  });

  it("demotes every in_progress after the first to pending", () => {
    const input = [
      t("a", "Step 1", "in_progress"),
      t("b", "Step 2", "in_progress"),
      t("c", "Step 3", "in_progress"),
    ];
    const { todos, repairs } = normalizeTodos(input);
    expect(todos.filter((x) => x.status === "in_progress")).toHaveLength(1);
    expect(todos[0].status).toBe("in_progress");
    expect(todos[1].status).toBe("pending");
    expect(todos[2].status).toBe("pending");
    expect(repairs.some((r) => r.includes("demoted"))).toBe(true);
  });

  it("drops empty-titled items and trims whitespace-padded titles", () => {
    const input = [t("a", "  Fix the bug  ", "pending"), t("b", "   ", "pending"), t("c", "", "completed")];
    const { todos, repairs } = normalizeTodos(input);
    expect(todos).toHaveLength(1);
    expect(todos[0].title).toBe("Fix the bug");
    expect(repairs.some((r) => r.includes("dropped 2"))).toBe(true);
  });

  it("merges duplicate ids, keeping the later entry", () => {
    const input = [
      t("a", "Old title", "pending"),
      t("a", "New title", "in_progress"),
    ];
    const { todos, repairs } = normalizeTodos(input);
    expect(todos).toHaveLength(1);
    expect(todos[0].title).toBe("New title");
    expect(todos[0].status).toBe("in_progress");
    expect(repairs.some((r) => r.includes("duplicate id"))).toBe(true);
  });

  it("survives an empty list", () => {
    const { todos, repairs } = normalizeTodos([]);
    expect(todos).toEqual([]);
    expect(repairs).toEqual([]);
  });
});

describe("validateTodos (kept for hard-validation callers)", () => {
  it("still rejects multiple in_progress items", () => {
    const err = validateTodos([t("a", "A", "in_progress"), t("b", "B", "in_progress")]);
    expect(err).toContain("only one todo may be in_progress");
  });

  it("still rejects empty titles", () => {
    expect(validateTodos([t("a", " ", "pending")])).toContain("title cannot be empty");
  });

  it("accepts a valid list", () => {
    expect(validateTodos([t("a", "A", "pending"), t("b", "B", "in_progress")])).toBeNull();
  });
});
