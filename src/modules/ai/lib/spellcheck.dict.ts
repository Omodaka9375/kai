/**
 * The bundled hunspell dictionary payload + engine factory.
 *
 * SPLIT FROM spellcheck.ts (2026-11-06): `?raw` imports are BUILD-TIME
 * inlines - placing them in a statically-imported module would drag the
 * whole ~550KB dictionary into the AiInputBar chunk (loaded the moment
 * the AI panel opens). In this separate module, only reached through
 * spellcheck.ts's dynamic `import()` inside getEngine(), vite emits the
 * dictionary + nspell as their own chunk that loads on the FIRST
 * right-click of a word - never before.
 */

// Root-relative /node_modules paths bypass dictionary-en's `exports` map
// (which only exposes index.js, a node:fs loader unusable in the webview);
// vite inlines the file contents at build time and the files ride the
// lockfile like any dependency payload.
import affRaw from "/node_modules/dictionary-en/index.aff?raw";
import dicRaw from "/node_modules/dictionary-en/index.dic?raw";
import nspell from "nspell";

/** Build the engine with the user's accepted words pre-loaded. */
export function buildEngine(personalWords: Iterable<string>): NSpellLike {
  const spell = nspell(affRaw, dicRaw) as unknown as NSpellLike;
  for (const w of personalWords) spell.add(w);
  return spell;
}

/** The structural type spellcheck.ts needs from nspell (CJS, untyped here). */
export type NSpellLike = {
  correct(word: string): boolean;
  suggest(word: string): string[];
  add(word: string): unknown;
  remove(word: string): unknown;
};
