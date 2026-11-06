import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { wordAtCaret } from "./spellcheck";

/**
 * WIRING PINS (no fake engine): the REAL nspell + dictionary-en pair is
 * exercised in-process, plus source pins that the menu actually consumes
 * the spellcheck lib and persists through the settings store.
 */
describe("spellcheck real-engine + wiring", () => {
  it("the REAL dictionary corrects and suggests the user's exact case", async () => {
    // Dynamic import so the 550KB dictionary loads only for this test.
    const { spellTargetAt, __setEngineForTest } = await import("./spellcheck");
    __setEngineForTest(null); // force the real engine path
    const text = "I always missspel words";
    const t = await spellTargetAt(text, text.indexOf("missspel"));
    expect(t?.word).toBe("missspel");
    expect(t?.suggestions[0]).toBe("misspell");
    // A correct word must resolve to null (no menu section).
    expect(await spellTargetAt("always", 0)).toBeNull();
  });

  it("the AI input menu consumes the spellcheck lib (source pins)", async () => {
    const src = readFileSync(
      new URL("../components/AiInputBar.tsx", import.meta.url),
      "utf8",
    );
    // Menu imports the lib + the settings-store persistence pair.
    expect(src).toContain("spellTargetAt(el.value, el.selectionStart)");
    expect(src).toContain("addToUserDictionary(word, setSpellUserWords, getSpellUserWords)");
    // The suggestions section renders only for a resolved target.
    expect(src).toContain("{spellTarget ? (");
    expect(src).toContain("onApplySpellFix(s, spellTarget.start, spellTarget.end)");
    // The fix writes through the composer state (not just the DOM).
    expect(src).toContain("c.setValue(replaceRange(el.value, start, end, replacement))");
  });

  it("wordAtCaret handles the right-click caret semantics", () => {
    // Right-click moves the caret to the click point; the word containing
    // that index is the target word.
    expect(wordAtCaret("hello missspel world", 8)).toBe("missspel");
    expect(wordAtCaret("hello missspel world", 11)).toBe("missspel");
    expect(wordAtCaret("hello missspel world", 16)).toBe("world");
  });
});
