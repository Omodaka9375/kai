import { describe, expect, it } from "vitest";
import {
  partitionSessionsByWorkspace,
  type SessionMeta,
} from "./sessions";

function meta(id: string, workspaceRoot?: string | null): SessionMeta {
  return {
    id,
    title: "New chat",
    createdAt: 0,
    updatedAt: 0,
    workspaceRoot,
  };
}

describe("partitionSessionsByWorkspace", () => {
  it("groups sessions by case-insensitive workspace identity", () => {
    const groups = partitionSessionsByWorkspace([
      meta("a", "D:/Code/2026/KAI"),
      meta("b", "d:/code/2026/kai"),
      meta("c", "D:\\Code\\2026\\KAI"),
      meta("d", "C:/Other/project"),
    ]);

    // Three case/separator variants of the same project → one bucket.
    const projectBuckets = [...groups.entries()].filter(([k]) => k !== "");
    expect(projectBuckets).toHaveLength(2);
    const kai = projectBuckets.find(([, m]) =>
      m.some((s) => s.id === "a"),
    );
    expect(kai).toBeDefined();
    expect(kai![1].map((s) => s.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps global (unscoped) sessions in their own bucket", () => {
    const groups = partitionSessionsByWorkspace([
      meta("g1", null),
      meta("g2", undefined),
      meta("p1", "D:/Code/2026/KAI"),
    ]);
    const global = groups.get("");
    expect(global?.map((s) => s.id).sort()).toEqual(["g1", "g2"]);
  });

  it("returns an empty map for no sessions", () => {
    expect(partitionSessionsByWorkspace([]).size).toBe(0);
  });
});
