import { describe, expect, it, vi } from "vitest";

/**
 * Authorship tags + the writeSkill preservation rule.
 *
 * The rule that matters for trust: creation attribution survives an
 * unrelated edit. If a user tweaks an agent-authored skill in Settings, the
 * row must NOT silently become "unknown/user" — attribution that vanishes on
 * an edit is worse than none, because absence is what the Staff screen uses
 * for "user-created or predates tagging".
 */

// A tiny in-memory fs: writeSkill reaches disk only through these four
// invokes, so a fake invoke covers the whole path without a real FS.
const files = new Map<string, string>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: { path?: string; content?: string }) => {
    const p = String(args?.path ?? "");
    if (cmd === "fs_read_file") {
      if (!files.has(p)) throw new Error("ENOENT");
      return { kind: "text", content: files.get(p) };
    }
    if (cmd === "fs_write_file") {
      files.set(p, String(args?.content ?? ""));
      return undefined;
    }
    if (cmd === "fs_canonicalize") {
      if (!files.has(p)) throw new Error("ENOENT");
      return p;
    }
    if (cmd === "fs_create_dir") return undefined;
    throw new Error(`unmocked invoke: ${cmd}`);
  }),
}));

const { writeSkill, parseSkillMd } = await import("./skills");
const { authorshipLabel } = await import("./authorship");

const ROOT = "C:/kai/skills";
const mdPath = (name: string) => `${ROOT}/${name}/SKILL.md`;

describe("authorshipLabel", () => {
  it("renders agent + persona, and null for untagged records", () => {
    expect(authorshipLabel({ by: "agent", via: "Coder", at: 1 })).toBe(
      "agent · Coder",
    );
    expect(authorshipLabel({ by: "agent", at: 1 })).toBe("agent");
    // Absence is never rendered as "user" — that would be a guess.
    expect(authorshipLabel(undefined)).toBeNull();
  });
});

describe("writeSkill preserves created-by across rewrites", () => {
  it("an agent-created skill keeps its tag when rewritten WITHOUT one", async () => {
    const tag = { by: "agent" as const, via: "Coder", at: 1730000000000 };
    await writeSkill(
      ROOT,
      { name: "keepme", description: "d", content: "original", createdBy: tag },
      null,
    );
    expect(parseSkillMd(files.get(mdPath("keepme"))!)!.createdBy).toEqual(tag);

    // Simulate the Settings editor: same skill, draft carries NO createdBy.
    await writeSkill(
      ROOT,
      { name: "keepme", description: "d", content: "user edited body" },
      null,
    );
    const after = parseSkillMd(files.get(mdPath("keepme"))!)!;
    expect(after.createdBy).toEqual(tag);
    expect(after.body).toContain("user edited body");
  });

  it("a user-created skill never gains an agent tag by editing", async () => {
    await writeSkill(
      ROOT,
      { name: "humanmade", description: "d", content: "v1" },
      null,
    );
    expect(parseSkillMd(files.get(mdPath("humanmade"))!)!.createdBy).toBeNull();
    await writeSkill(
      ROOT,
      { name: "humanmade", description: "d", content: "v2" },
      null,
    );
    expect(parseSkillMd(files.get(mdPath("humanmade"))!)!.createdBy).toBeNull();
  });

  it("an explicit draft tag wins on rewrite (create_skill re-stamps itself)", async () => {
    await writeSkill(
      ROOT,
      {
        name: "restamp",
        description: "d",
        content: "v1",
        createdBy: { by: "agent", via: "Old", at: 1 },
      },
      null,
    );
    await writeSkill(
      ROOT,
      {
        name: "restamp",
        description: "d",
        content: "v2",
        createdBy: { by: "agent", via: "New", at: 2 },
      },
      null,
    );
    expect(parseSkillMd(files.get(mdPath("restamp"))!)!.createdBy).toEqual({
      by: "agent",
      via: "New",
      at: 2,
    });
  });
});
