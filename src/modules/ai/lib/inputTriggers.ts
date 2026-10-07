/**
 * Input-trigger detection for the composer's inline pickers.
 *
 * Pure functions extracted from AiInputBar so they are unit-testable:
 * given the textarea value and caret, decide whether an inline picker
 * should be open and over which character range.
 *
 * - `#` opens the command + snippet picker.
 * - `/` opens the command picker (commands only — slash is the canonical
 *   command prefix, showing snippets there is noise).
 * - `@` opens the workspace file picker.
 *
 * A trigger char only counts when it is at the start of the input or
 * preceded by whitespace — that's what keeps URLs (`https://…`) and paths
 * (`src/lib/foo.ts`) from opening menus mid-word.
 */

export type SnippetTrigger = {
  /** The trigger character that opened the picker. */
  char: "#" | "/";
  start: number;
  end: number;
  query: string;
};

export type FileTrigger = {
  start: number;
  end: number;
  query: string;
};

export function detectSnippetTrigger(
  value: string,
  caret: number,
): SnippetTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "#" || ch === "/") {
      const prev = i === 0 ? " " : value[i - 1];
      if (!/\s/.test(prev)) return null;
      const slice = value.slice(i + 1, caret);
      if (!/^[a-z0-9-]*$/i.test(slice)) return null;
      return {
        char: ch as "#" | "/",
        start: i,
        end: caret,
        query: slice.toLowerCase(),
      };
    }
    if (/\s/.test(ch)) return null;
    if (!/[a-z0-9-]/i.test(ch)) return null;
  }
  return null;
}

export function detectFileTrigger(
  value: string,
  caret: number,
): FileTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "@") {
      const prev = i === 0 ? " " : value[i - 1];
      if (!/\s/.test(prev)) return null;
      const slice = value.slice(i + 1, caret);
      return { start: i, end: caret, query: slice };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}
