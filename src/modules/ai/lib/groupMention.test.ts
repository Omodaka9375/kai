import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Group composer @-mention targeting (2026-10-31).
 *
 * User ask: "Instead of All dropdown on left of the input let me tag
 * agents in group chat with @" — the composer's Popover target picker is
 * replaced by @-mentions in the textarea:
 *   - typing "@" opens a picker over participants (+ "All" to clear)
 *   - picking inserts "@Name " into the text; "All" clears the token
 *   - arrows + Enter/Tab pick; Escape closes
 *   - on send, the LAST @-mention targets that participant (the mention
 *     stays in the text so the agent sees itself addressed); no mention =
 *     everyone (same single-target semantics the dropdown had).
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const panel = read("../components/GroupChatPanelView.tsx");
// 2026-11-26 group-input unification: the panel no longer renders its own
// composer - the MAIN AiInputBar is the group input while a group owns the
// right-gutter slot, so the mention picker + send routing live there and in
// the shared composer provider.
const bar = read("../components/AiInputBar.tsx");
const composerSrc = read("../components/composer.tsx");
const lib = read("./groupMention.ts");

import { resolveGroupMentionTarget } from "../lib/groupMention";

const PARTS = [
  { projectId: "p-alpha", name: "alpha", sessionId: "s-a", root: "/a", joinedAt: 0 },
  { projectId: "p-beta", name: "beta", sessionId: "s-b", root: "/b", joinedAt: 0 },
  { projectId: "p-sec", name: "Security Reviewer", sessionId: "s-c", root: "/c", joinedAt: 0 },
] as const;

describe("resolveGroupMentionTarget — default all, anywhere-in-message matching", () => {
  it("no mention = everyone (undefined)", () => {
    expect(resolveGroupMentionTarget("hello team", [...PARTS])).toBeUndefined();
  });

  it("a mention at the BEGINNING targets that agent", () => {
    expect(resolveGroupMentionTarget("@alpha did the tests pass?", [...PARTS])).toBe("p-alpha");
  });

  it("a mention MID-SENTENCE targets that agent", () => {
    expect(resolveGroupMentionTarget("hey, can @alpha check the build today?", [...PARTS])).toBe("p-alpha");
  });

  it("stray non-matching @tokens never strip a real mention (default all)", () => {
    expect(resolveGroupMentionTarget("@alpha look at test@2 and user@host", [...PARTS])).toBe("p-alpha");
  });

  it("prefix + case-insensitive matching; last MATCHING mention wins", () => {
    expect(resolveGroupMentionTarget("@SEC check the report", [...PARTS])).toBe("p-sec");
    expect(resolveGroupMentionTarget("@alpha and then @beta please reply", [...PARTS])).toBe("p-beta");
  });

  it("only stray tokens = everyone, not a wrong target", () => {
    expect(resolveGroupMentionTarget("check test@2 and user@host", [...PARTS])).toBeUndefined();
  });
});

describe("group input @-mention targeting (2026-11-26: the MAIN input bar is the group input)", () => {
  it("the panel composer is gone; the main bar drives group targeting", () => {
    expect(panel).not.toContain("function Composer");
    expect(panel).not.toContain("<Composer");
    // The old Popover trigger button (title="Send to…") stays gone.
    expect(panel).not.toContain('title="Send to…"');
    expect(panel).not.toMatch(/setTarget\(/);
    // The main bar's group-mode mention picker owns insertion.
    expect(bar).toContain("pickMention(");
    expect(bar).toContain("mentionList");
  });

  it("the last MATCHING mention in the text is the send target (resolver)", () => {
    // The resolver lives in the shared lib; the composer's group submit
    // route resolves the target from the trimmed text.
    expect(lib).toContain("export function resolveGroupMentionTarget(");
    expect(composerSrc).toContain("resolveGroupMentionTarget(");
    expect(composerSrc).toContain(
      "await sendGroupMessage(activeGroup.id, composed, target);",
    );
  });

  it("keyboard: arrows navigate, Enter/Tab pick, Escape closes", () => {
    expect(bar).toMatch(/"ArrowDown"[\s\S]{0,420}"ArrowUp"/);
    expect(bar).toContain('e.key === "Tab" || e.key === "Enter"');
    expect(bar).toMatch(/"Escape"[\s\S]{0,200}setFileTrigger\(null\)/);
  });

  it("the picker is a positioned dropdown inside the anchored Popover", () => {
    // The main bar's Popover wraps the strip in a PopoverAnchor, so the
    // mention picker rides the SAME anchored portal - never the anchorless
    // <Popover open> form that rendered unpositioned (2026-11-01 bug).
    expect(bar).toContain('role="listbox"');
    expect(bar).toContain('aria-label="Mention picker"');
    expect(bar).not.toContain("<Popover open={true}>");
  });

  it("the picker offers All (clear targeting) plus participants", () => {
    expect(bar).toContain("All - send to everyone");
    expect(bar).toMatch(/ParticipantDot participant=\{item\} groupId=\{c\.groupId\}/);
  });

  it("group mode hides the single-agent file picker behind @", () => {
    // `@` in group mode targets participants, NOT workspace files - the
    // file list must stay empty and the picker only shows mentions.
    expect(bar).toContain("if (!fileTrigger || c.groupMode) return [];");
  });
});

describe("picking a mention yields exactly ONE @ (no doubled @@)", () => {
  it("the replaced token range starts AT the typed @ (2026-11-01)", () => {
    // detectFileTrigger's FileTrigger.start points AT the typed "@"
    // (inputTriggers.ts), and pickMention's insertion carries its own
    // "@" (`@${name} `), so the replaced range swallows the typed one -
    // the pre-fix start (the first char AFTER the @) left it in place and
    // the insert prepended a second one: "@@alpha ".
    expect(bar).toContain(
      'const insertion = name === "All" ? "" : `@${name} `;',
    );
    expect(bar).toContain(
      "const next = before + insertion + c.value.slice(fileTrigger.end);",
    );
  });
});