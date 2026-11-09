import { describe, expect, it } from "vitest";
import {
  deriveTitle,
  partitionSessionsByWorkspace,
  type SessionMeta,
} from "./sessions";
import { __prepareMessagesForStore } from "./sessions";
import type { UIMessage } from "ai";

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

describe("__prepareMessagesForStore (switch-lag fix: per-message prepare cache)", () => {
  function userMsg(id: string, text: string): UIMessage {
    return {
      id,
      role: "user",
      parts: [{ type: "text", text }],
    } as UIMessage;
  }

  it("produces the same output as a full-array JSON round-trip", () => {
    const msgs = [
      userMsg("m1", "hello the re"),
      {
        id: "m2",
        role: "assistant",
        parts: [{ type: "text", text: "hi there" }],
      },
      userMsg("m3", "third"),
    ] as UIMessage[];
    const out = __prepareMessagesForStore(msgs);
    expect(out).not.toBeNull();
    // Round-trip equals the naive full-array prepare (the old behavior).
    const expected = JSON.parse(JSON.stringify(msgs));
    expect(JSON.parse(JSON.stringify(out))).toEqual(expected);
  });

  it("strips user image data-URL payloads (the compact-store contract)", () => {
    const msgs = [
      {
        id: "m1",
        role: "user",
        parts: [
          { type: "text", text: "look" },
          {
            type: "file",
            mediaType: "image/png",
            url: "data:image/png;base64,AAAApayload",
          },
        ],
      },
    ] as unknown as UIMessage[];
    const out = __prepareMessagesForStore(msgs);
    expect(out).not.toBeNull();
    const parts = (out![0] as { parts: Array<Record<string, unknown>> }).parts;
    const filePart = parts.find((p) => p.type === "file")!;
    expect(String(filePart.url)).not.toContain("AAAApayload");
  });

  it("serves repeat preparations of a stable message from cache (same result)", () => {
    const m = userMsg("m1", "stable text");
    const first = __prepareMessagesForStore([m]);
    const second = __prepareMessagesForStore([m, userMsg("m2", "new")]);
    // The cached entry for m1 is byte-identical across flushes.
    expect(JSON.stringify(second![0])).toBe(JSON.stringify(first![0]));
    // A rebuilt object with the same CONTENT also prepares correctly
    // (fresh identity -> fresh prepare; the cache never serves stale data).
    const rebuilt = userMsg("m1", "stable text");
    const third = __prepareMessagesForStore([rebuilt]);
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
  });

  it("never serves the streaming LAST message from cache", () => {
    // The live scenario: the last message is rebuilt every token flush. Its
    // content CHANGES between flushes even though an older object with the
    // same shape may be cached - the fresh (non-cached) path must win.
    const streaming1 = userMsg("live", "partial ans");
    __prepareMessagesForStore([userMsg("m1", "old"), streaming1]);
    const streaming2 = userMsg("live", "partial answer now longer");
    const out = __prepareMessagesForStore([userMsg("m1", "old"), streaming2]);
    expect(
      (out![1] as { parts: Array<{ type: string; text?: string }> }).parts[0]!.text,
    ).toBe("partial answer now longer");
  });

  it("trims oversized histories to the most recent messages", () => {
    // One huge message (~1MB) plus fillers; cap is 2MB (MAX_MESSAGES_JSON_BYTES).
    const huge = userMsg("huge", "x".repeat(1_000_000));
    const fillers = Array.from({ length: 30 }, (_, i) =>
      userMsg(`f${i}`, `filler ${i} `.repeat(50_000)),
    );
    const out = __prepareMessagesForStore([huge, ...fillers]);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(fillers.length + 1);
    // The KEPT tail must be the most recent messages (the huge head goes).
    const kept = out as Array<{ id: string }>;
    expect(kept[kept.length - 1]!.id).toBe(`f${fillers.length - 1}`);
    expect(kept.some((m) => m.id === "huge")).toBe(false);
  });

  it("returns null when a message is fundamentally unserializable", () => {
    const circular: Record<string, unknown> = { id: "c", role: "user", parts: [] };
    circular.self = circular;
    const out = __prepareMessagesForStore([circular as unknown as UIMessage]);
    expect(out).toBeNull();
  });
});

describe("deriveTitle (context-block stripping)", () => {
  function userMsg(text: string): UIMessage {
    return {
      id: "m1",
      role: "user",
      parts: [{ type: "text", text }],
    } as UIMessage;
  }

  it("does not derive the title from a prepended <skill> block (2026-11-09 bug)", () => {
    // The composer expands #handle into `<skill name="…">` blocks prepended
    // ahead of the user's text; the title must come from the user's own text,
    // not the literal `<skill` opening tag.
    const title = deriveTitle([
      userMsg(
        '<skill name="analyze">\nLong skill body...\n</skill>\nwhy did the build fail?',
      ),
    ]);
    expect(title).toBe("why did the build fail?");
  });

  it("still derives from the skill text alone when there is no user text", () => {
    // All text was context blocks: the fallback title applies.
    expect(deriveTitle([userMsg('<skill name="analyze">\nbody\n</skill>')])).toBe(
      "New chat",
    );
  });

  it("keeps deriving from later user messages once blocks are stripped", () => {
    const title = deriveTitle([
      userMsg('<terminal-context>foo</terminal-context>'),
      userMsg("the real question"),
    ]);
    expect(title).toBe("the real question");
  });
});
