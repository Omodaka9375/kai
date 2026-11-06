/**
 * Spell-check for the AI input (2026-11-06) - suggestions in our own themed
 * right-click menu, the Option-B architecture from the editor survey:
 *
 * The webview underlines misspelled words (Chromium/WebView2 default) but
 * exposes ZERO API to read its results, and our textarea already
 * preventDefaults the contextmenu (the themed menu) - so the native
 * suggestions menu can never appear. This module rebuilds the standard
 * editor feature with a bundled hunspell dictionary (nspell + dictionary-en,
 * the same stack nspell's author maintains for remark):
 *
 *   - right-click moves the caret to the click point (Chromium textarea
 *     behavior - the same trick native spell menus rely on), so the WORD AT
 *     THE CARET is the word under the mouse; no pixel-to-index mirror div.
 *   - CODE GUARD (the JetBrains/cspell rule): identifiers, paths, flags,
 *     camelCase/snake_case tokens and the #/@ trigger words are NEVER
 *     flagged or suggested-for. The AI input is full of code-shaped text
 *     where "looks like a typo" is almost always intentional.
 *   - never auto-apply: the only mutations are explicit menu actions
 *     (replace-with-suggestion, add-to-dictionary). No silent rewrites.
 *
 * Laziness: the dictionary (~550KB dic + affix rules) loads on first use
 * via vite `?raw` imports inside a dynamic chunk - the main bundle never
 * pays for it, and a user who never right-clicks a word never loads it.
 */

/** Max suggestions shown in the menu (matches editor norms). */
export const SPELL_MAX_SUGGESTIONS = 5;

/** Words shorter than this are never flagged (matches Chromium's ~2). */
const MIN_WORD_LEN = 3;

// ── Code-token guard ─────────────────────────────────────────────────────

/**
 * Words that must never be spell-checked in the AI input. Deliberately
 * conservative: false negatives (skipping a real typo shaped like code)
 * are cheap; false positives (red squiggle under a flag or a path) are
 * the reason users disable spellcheck in dev tools at all.
 */
export function isCodeLikeToken(word: string): boolean {
  // Any code punctuation glued into the token: paths, flags, etc.
  if (/[^A-Za-z']/ .test(word)) return true;
  // camelCase / PascalCase / snake_case / kebab-case identifiers.
  if (/[a-z][A-Z]/.test(word)) return true;
  if (/^_+|_+$/.test(word)) return true;
  return false;
}

// ── Word-at-caret extraction ─────────────────────────────────────────────

/** Nearest word boundary pair around `index` (the caret position). */
export function wordRangeAt(text: string, index: number): { start: number; end: number } {
  const n = text.length;
  let start = Math.min(Math.max(index, 0), n);
  let end = start;
  const isWordChar = (c: string) => /[A-Za-z']/.test(c);
  while (start > 0 && isWordChar(text[start - 1]!)) start--;
  while (end < n && isWordChar(text[end]!)) end++;
  return { start, end };
}

/** The word at the caret, or null when the caret is not inside a word. */
export function wordAtCaret(text: string, index: number): string | null {
  const { start, end } = wordRangeAt(text, index);
  if (end <= start) return null;
  return text.slice(start, end);
}

// ── Case-preserving replacement ─────────────────────────────────────────

/**
 * Match the original word's casing when applying a suggestion:
 * `Missspel` -> `Misspell` (nspell already preserves), but guard the
 * ALL-CAPS shape too: `RECIEVE` -> `RECEIVE`, `Recieve` -> `Receive`.
 */
export function applySuggestionCase(original: string, suggestion: string): string {
  if (original === original.toUpperCase()) return suggestion.toUpperCase();
  if (original === original[0]!.toUpperCase() + original.slice(1).toLowerCase()) {
    return suggestion[0]!.toUpperCase() + suggestion.slice(1);
  }
  return suggestion;
}

// ── Engine (lazy singleton) ──────────────────────────────────────────────

// The engine type comes from the dictionary chunk (spellcheck.dict.ts) -
// see the LAZINESS note in the header; nspell itself is never imported
// statically here, so this module stays dictionary-free.
type NSpell = import("./spellcheck.dict").NSpellLike;

let enginePromise: Promise<NSpell> | null = null;
/** Test seam: inject a fake engine (avoids the 550KB dictionary in CI). */
let engineOverride: NSpell | null = null;

/** Extra words the user accepted as correct (their personal dictionary). */
const personalWords = new Set<string>();

async function getEngine(): Promise<NSpell> {
  if (engineOverride) return engineOverride;
  if (!enginePromise) {
    enginePromise = (async () => {
      // Dynamic import: the dictionary payload + nspell live in their own
      // chunk (spellcheck.dict.ts) that loads exactly now - the first
      // right-click - and never rides the AI panel's initial load.
      const { buildEngine } = await import("./spellcheck.dict");
      return buildEngine(personalWords);
    })();
  }
  return enginePromise;
}

/** Replace the engine (tests only). Also resets personal words. */
export function __setEngineForTest(engine: NSpell | null): void {
  engineOverride = engine;
  enginePromise = null;
  personalWords.clear();
}

// ── Public API ────────────────────────────────────────────────────────────

export type SpellTarget = {
  /** The misspelled word (as typed). */
  word: string;
  /** Character range in the textarea value. */
  start: number;
  end: number;
  /** Up to SPELL_MAX_SUGGESTIONS replacement candidates. */
  suggestions: string[];
};

/**
 * The spell target at `caretIndex` in the AI input's value, or null when
 * the caret is not on a checkable misspelled word (correct word, code-like
 * token, short word, no word, or dictionary not loaded).
 */
export async function spellTargetAt(
  text: string,
  caretIndex: number,
): Promise<SpellTarget | null> {
  const word = wordAtCaret(text, caretIndex);
  if (!word || word.length < MIN_WORD_LEN) return null;
  if (isCodeLikeToken(word)) return null;
  let engine: NSpell;
  try {
    engine = await getEngine();
  } catch {
    return null; // dictionary load failed: degrade to no suggestions
  }
  // Apostrophe forms (don't, it's) - check the variant without the mark;
  // nspell's en dictionary handles straight-apostrophe contractions.
  if (engine.correct(word)) return null;
  const suggestions: string[] = engine
    .suggest(word)
    .slice(0, SPELL_MAX_SUGGESTIONS)
    .map((s: string) => applySuggestionCase(word, s));
  const { start, end } = wordRangeAt(text, caretIndex);
  return { word, start, end, suggestions };
}

/** Replace the word at [start, end) in `value` with `replacement`. */
export function replaceRange(
  value: string,
  start: number,
  end: number,
  replacement: string,
): string {
  return value.slice(0, start) + replacement + value.slice(end);
}

/**
 * Accept `word` as permanently correct (the "Add to dictionary" action).
 * Persists via the injected user-dictionary writer; the in-memory engine
 * learns it immediately so later checks are consistent within the session.
 */
export async function addToUserDictionary(
  word: string,
  persist: (words: string[]) => Promise<void> = async () => {},
  load: () => Promise<string[]> = async () => [],
): Promise<void> {
  const clean = word.trim();
  if (!clean) return;
  personalWords.add(clean);
  try {
    const engine = await getEngine();
    engine.add(clean);
  } catch {
    // Engine not loaded: personalWords is consulted at engine build.
  }
  const existing = await load().catch(() => [] as string[]);
  if (!existing.includes(clean)) {
    await persist([...existing, clean]).catch(() => {});
  }
}
