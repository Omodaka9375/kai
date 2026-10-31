import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Fork vs Shadow mode - discoverability contract.
 *
 * User reports: (1) people don't understand the difference between Fork and
 * Shadow mode, so they don't use either; (2) Fork is hard to notice.
 *
 * The two features isolate DIFFERENT things and that distinction must be
 * discoverable at every entry point:
 *
 *   Fork   - branches the CONVERSATION from a message into a new chat.
 *            Same project files. One click per message.
 *   Shadow - isolates the FILES (an isolated copy the agent edits) AND
 *            branches the conversation in one action. Apply copies the
 *            changes back; Discard deletes them.
 *
 * Layout contract (user report 2026-10-31): the session-menu entry must
 * stay a SINGLE-LINE item like its siblings - a stacked multi-line
 * description inside the 224px dropdown stretched the whole menu
 * vertically. The full Fork-vs-Shadow explanation rides the entry's
 * tooltip; the always-visible ShadowStrip carries the working-state
 * wording. Never re-introduce a flex-col description block in the menu.
 *
 * Vocabulary contract (KAI.md): Shadow's strip actions are Apply/Discard -
 * "Merge" belongs exclusively to the session menu's merge-into-another-chat.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const chat = read("./AiChat.tsx");
const strip = read("./ShadowStrip.tsx");
const store = read("../store/chatStore.ts");

describe("fork discoverability", () => {
  it("uses the recognizable GitFork icon, not a hand-rolled arrow SVG", () => {
    expect(chat).toContain("GitForkIcon");
    expect(chat).not.toMatch(/<svg[^>]*viewBox="0 0 16 16"[^>]*>\s*<path d="M5 3v4/);
  });

  it("the fork button is visible at rest (not hover-only)", () => {
    // opacity-70 at rest was opacity-0 before - the button only appeared on
    // message hover, which is why users never noticed it. Scoped to the
    // ForkButton's own class string, not the whole file (other hover-reveal
    // affordances legitimately use opacity-0).
    const fork = chat.slice(
      chat.indexOf('title="Fork: branch the conversation'),
      chat.indexOf("function CopyButton"),
    );
    expect(fork).toContain("opacity-70 group-hover/msg:opacity-100");
    expect(fork).not.toContain("opacity-0 group-hover/msg:opacity-100");
  });

  it("the fork tooltip names the feature and cross-references Shadow", () => {
    expect(chat).toContain('title="Fork: branch the conversation');
    expect(chat).toContain("To isolate FILES, use Shadow mode");
  });

  it("forked sessions are titled after their origin (recognizable later)", () => {
    // A session named "Fork" tells the user nothing once they have three.
    expect(store).toContain('title: `Fork \u00B7 ${originTitle}`');
    expect(store).toContain("const originTitle =");
  });
});

describe("shadow mode discoverability", () => {
  it("the session-menu entry is a single-line item - no stacked description block", () => {
    // User report: the stacked flex-col description stretched the dropdown
    // vertically. The entry must stay a plain single-line sibling.
    const item = strip.slice(
      strip.indexOf("export function ShadowSessionMenuItem"),
    );
    expect(item).not.toContain("flex flex-col gap-0.5");
    expect(item).not.toContain("text-[10px] leading-snug text-muted-foreground");
  });

  it("the full Fork-vs-Shadow explanation rides the entry tooltip", () => {
    expect(strip).toContain(
      "isolated copy of the files and a branched conversation",
    );
    expect(strip).toContain("(Fork branches the conversation only.)");
  });

  it("the tooltip distinguishes Apply from Discard outcomes", () => {
    expect(strip).toContain("Apply copies the changes back, Discard deletes them");
  });

  it("vocabulary contract holds: strip actions stay Apply/Discard, never Merge", () => {
    // The strip's buttons (copy-back / delete-copy) must never be renamed
    // "Merge" - that word belongs to the session menu's chat-merge action.
    const stripButtons = strip.slice(strip.indexOf("export function ShadowStrip"));
    expect(stripButtons).toMatch(/>\n\s*Apply\n\s*<\/Button>/);
    expect(stripButtons).toMatch(/>\n\s*Discard\n\s*<\/Button>/);
    expect(stripButtons).not.toMatch(/>\n\s*Merge\n\s*<\/Button>/);
  });
});
