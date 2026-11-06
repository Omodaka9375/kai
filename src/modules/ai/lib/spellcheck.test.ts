import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setEngineForTest,
  addToUserDictionary,
  applySuggestionCase,
  isCodeLikeToken,
  replaceRange,
  spellTargetAt,
  SPELL_MAX_SUGGESTIONS,
  wordAtCaret,
  wordRangeAt,
} from "./spellcheck";
import type { NSpellLike } from "./spellcheck.dict";

/**
 * The real 550KB dictionary never loads here: every test injects a fake
 * engine through the test seam, keeping the suite fast and hermetic. The
 * REAL engine (nspell + dictionary-en) is exercised by the wiring pin in
 * spellcheck.wiring.test.ts via the same public functions.
 */

function fakeEngine(
  correctSet: Set<string>,
  suggestMap: Record<string, string[]> = {},
): NSpellLike {
  return {
    correct: (w: string) => correctSet.has(w.toLowerCase()),
    suggest: (w: string) => suggestMap[w] ?? [],
    add: () => {},
    remove: () => {},
  } as unknown as NSpellLike;
}

describe("isCodeLikeToken (the JetBrains/cspell code guard)", () => {
  it("never flags code-shaped words", () => {
    expect(isCodeLikeToken("useState")).toBe(true); // camelCase
    expect(isCodeLikeToken("AppComponent")).toBe(true); // PascalCase
    expect(isCodeLikeToken("--flag")).toBe(true);
    expect(isCodeLikeToken("C:/Users")).toBe(true);
    expect(isCodeLikeToken("email@mail")).toBe(true);
    expect(isCodeLikeToken("config.yml")).toBe(true);
    expect(isCodeLikeToken("doesn")).toBe(false); // plain word
    expect(isCodeLikeToken("hello")).toBe(false);
  });
});

describe("wordRangeAt / wordAtCaret", () => {
  it("finds the word under the caret", () => {
    const text = "please fix the typo in main.ts";
    // caret on the 'y' of typo (index 15)
    expect(wordAtCaret(text, 15)).toBe("typo");
    const r = wordRangeAt(text, 15);
    expect(text.slice(r.start, r.end)).toBe("typo");
  });

  it("is forgiving: a caret on the space after a word still targets it", () => {
    // Right-clicking the gap after a word is a near-miss for that word;
    // walking back makes the hit area forgiving (a correct word resolves
    // to null in spellTargetAt anyway, so this only ever surfaces when the
    // preceding word is actually misspelled).
    expect(wordAtCaret("one two", 3)).toBe("one");
    expect(wordAtCaret("one two", 6)).toBe("two");
    expect(wordAtCaret("", 5)).toBeNull();
    expect(wordAtCaret("word", 99)).toBe("word"); // clamped to end
  });
});

describe("applySuggestionCase", () => {
  it("preserves ALL-CAPS and Capitalized shapes", () => {
    expect(applySuggestionCase("RECIEVE", "receive")).toBe("RECEIVE");
    expect(applySuggestionCase("Recieve", "receive")).toBe("Receive");
    expect(applySuggestionCase("recieve", "receive")).toBe("receive");
  });
});

describe("replaceRange", () => {
  it("splices the suggestion into the value", () => {
    // "recieve" occupies [8, 15) in this string.
    expect(replaceRange("fix the recieve bug", 8, 15, "receive")).toBe(
      "fix the receive bug",
    );
  });
});

describe("spellTargetAt", () => {
  beforeEach(() => {
    // NOTE: "typo" is deliberately NOT in the correct set - the test expects
    // it flagged. "main.ts" exercises the code guard instead.
    __setEngineForTest(
      fakeEngine(new Set(["please", "fix", "the", "in", "main.ts"]), {
        typo: ["type", "ton"],
      }),
    );
  });

  it("resolves a misspelled word with suggestions", async () => {
    // "typo" starts at index 15 in "please fix the typo".
    const t = await spellTargetAt("please fix the typo", 15);
    expect(t?.word).toBe("typo");
    expect(t?.suggestions).toEqual(["type", "ton"]);
    expect(t?.start).toBe(15);
    expect(t?.end).toBe(19);
  });

  it("returns null for a correct word", async () => {
    expect(await spellTargetAt("please fix", 1)).toBeNull();
  });

  it("returns null for code-like tokens (the guard)", async () => {
    // 'useeffect' would be misspelled English, but it's an identifier.
    __setEngineForTest(fakeEngine(new Set(["press"])));
    expect(await spellTargetAt("press useEffect now", 6)).toBeNull();
  });

  it("caps suggestions at SPELL_MAX_SUGGESTIONS", async () => {
    __setEngineForTest(
      fakeEngine(new Set(["x"]), {
        missspel: ["a", "b", "c", "d", "e", "f", "g", "h"],
      }),
    );
    const t = await spellTargetAt("missspel", 0);
    expect(t?.suggestions.length).toBe(SPELL_MAX_SUGGESTIONS);
  });

  it("degrades to null when the engine fails to load", async () => {
    __setEngineForTest(null);
    // No override + a rejected promise path: simulate by word being short.
    expect(await spellTargetAt("hi", 0)).toBeNull();
  });
});

describe("addToUserDictionary", () => {
  beforeEach(() => {
    __setEngineForTest(fakeEngine(new Set(["existing"])));
  });

  it("persists the word and teaches the engine", async () => {
    const persist = vi.fn(async () => {});
    const load = vi.fn(async () => ["existing"]);
    await addToUserDictionary("Valsinarb", persist, load);
    expect(persist).toHaveBeenCalledWith(["existing", "Valsinarb"]);
  });

  it("never duplicates an existing entry", async () => {
    const persist = vi.fn(async () => {});
    const load = vi.fn(async () => ["valsinarb"]);
    await addToUserDictionary("valsinarb", persist, load);
    expect(persist).not.toHaveBeenCalled();
  });

  it("survives persistence failures (fail-soft)", async () => {
    const persist = vi.fn(async () => {
      throw new Error("disk full");
    });
    const load = vi.fn(async () => [] as string[]);
    await expect(
      addToUserDictionary("kairo", persist, load),
    ).resolves.toBeUndefined();
  });
});
