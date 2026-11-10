import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * React #185 ("Maximum update depth exceeded") regression contract.
 *
 * User report (2026-10-31): opening the group chat icon crashed the UI with
 * minified React error #185 and required a full interface refresh. Stack:
 * radix Array.map + React commit-phase frames.
 *
 * Root cause: zustand v5 selector returning a FRESH array on every call
 * (`useAgentsStore((s) => [...s.customAgents, ...BUILTIN_AGENTS].map(...))`).
 * zustand feeds that selector to useSyncExternalStore, whose contract
 * requires getSnapshot to return a CACHED value — a new reference per call
 * means "the store changed" after every render, so React re-renders,
 * re-runs the selector, and after ~50 nested updates throws #185. Both
 * offenders lived in the group panel (InvitePicker + ParticipantsMenu)
 * — exactly the components that mount when the group chat opens.
 *
 * The fix: select the store's STABLE array (`(s) => s.customAgents`), then
 * derive the mapped/filtered shape in useMemo.
 *
 * 2026-11-10: InvitePicker + ParticipantsMenu moved from
 * GroupChatPanelView.tsx to GroupChatInvitePicker.tsx (god-file cleanup);
 * both persona-list selector sites moved with them, so the pins read BOTH
 * files — the union must stay clean.
 *
 * These pins keep every store selector in the group panel reference-stable.
 */
const read = (p: string) =>
  readFileSync(new URL(p, import.meta.url), "utf8") as string;

describe("group panel store selectors must return stable references", () => {
  const src = read("./GroupChatPanelView.tsx");
  const picker = read("./GroupChatInvitePicker.tsx");

  it("no selector builds an array/object inline (the #185 footgun)", () => {
    // Any selector that spreads, maps, filters, or literals an array/object
    // returns a new reference per call → infinite re-render → #185.
    for (const file of [src, picker]) {
      expect(file).not.toMatch(
        /use\w+Store\(\(s\) =>\s*\[\.\.\./,
      );
      expect(file).not.toMatch(/use\w+Store\(\(s\) =>[^)\n]*\.map\(/);
    }
  });

  it("persona lists derive in useMemo from the stable store array", () => {
    // Two fixed sites, both in the picker file now: InvitePicker's personas
    // + ParticipantsMenu's invitablePersonas.
    expect(picker).toContain(
      "const customAgents = useAgentsStore((s) => s.customAgents)",
    );
    expect(
      picker.match(/useAgentsStore\(\(s\) => s\.customAgents\)/g)?.length,
    ).toBe(2);
    expect(picker).toMatch(/const personas = useMemo\(/);
    expect(picker).toMatch(/const invitablePersonas = useMemo\(/);
  });
});

describe("the #185 decoder exists so users get an actionable message", () => {
  const store = read("../store/chatStore.ts");
  it("friendlyErrorText explains #185 as a KAI render-loop bug", () => {
    expect(store).toContain('"185"');
    expect(store).toContain("UI render loop detected");
  });
});
