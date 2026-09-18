/**
 * Detect blocks of ASCII / Unicode box-drawing art and wrap them in
 * markdown code fences so Streamdown preserves the line breaks.
 * Without this, markdown collapses single-newline lines into one paragraph.
 *
 * Extracted from AiChat.tsx into a pure module so it stays unit-testable —
 * importing AiChat.tsx pulls in React + the whole AI store, which is too
 * heavy for vitest.
 */
export function wrapAsciiArt(text: string): string {
  // Must have at least 1 line with box-drawing or art chars.
  const lines = text.split("\n");
  if (lines.length === 0) return text;

  // Unicode box-drawing + block elements.
  const BOX_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF]/;
  // ASCII art indicators: │ ├ ─ ╭ etc (these are in the box-drawing range above).
  // Also detect ASCII-only art: lines dominated by | - + / \ = characters
  // with consistent indentation patterns.
  const ASCII_LINE_RE = /^\s*[|\-+\/=<>^v.#*~:]{3,}/;

  // Find contiguous runs of lines that look like art.
  const out: string[] = [];
  let artRun: string[] = [];
  let inArt = false;
  // Track fenced code blocks: their lines must pass through untouched,
  // otherwise a model-fenced diagram gets a second nested ```text fence
  // injected, which then renders as literal text inside the block.
  let inFence = false;

  const flushArt = () => {
    // Fence single-line Unicode box-drawing diagrams — they collapse to
    // one unreadable blob in markdown otherwise.
    const hasBoxDrawing = artRun.some((l) => BOX_RE.test(l));
    const shouldFence = artRun.length >= 2 || (artRun.length === 1 && hasBoxDrawing);
    if (shouldFence) {
      out.push("```text");
      out.push(...artRun);
      out.push("```");
    } else {
      out.push(...artRun);
    }
    artRun = [];
    inArt = false;
  };

  // A markdown list item (`- …`, `* …`, `1. …`, `+ …`) must never be
  // classified as ASCII art. Otherwise a list item whose text happens to
  // contain box-drawing or frame characters (or bracketed `| … |` content)
  // gets wrapped in a code fence, which breaks the list and renders the item
  // as a literal text block.
  const LIST_ITEM_RE = /^\s*(?:[-*+]|\d{1,3}[.)])\s+\S/;

  // Markdown structural lines must never be treated as art — fencing one of
  // these turns a heading or horizontal rule into a literal text box:
  //  - ATX headings (`## Title`, `### Title`, …): `#` lives in the ASCII art
  //    char class, so `### …` was previously caught as a 3+ char art line.
  //  - Setext underlines / thematic breaks (`---`, `===`, `_ _ _ _ _`, …).
  const ATX_HEADING_RE = /^\s{0,3}#{1,6}(?:\s|$)/;
  const SETEXT_UNDERLINE_RE = /^\s{0,3}(?:=+|-+)\s*$/;
  const THEMATIC_BREAK_RE = /^\s{0,3}(?:[-_*](?:[\t ]|$)){3,}$/;
  // Markdown emphasis (`**bold**`, `***bold***`, `__underline__`, `___…___`)
  // must never be art. A line like `**#1 — …**` starts with `**` then `#` —
  // both in the ASCII art char class, so `**#` matched the 3+ leading art
  // chars and fenced a bold heading as a plain-text block. The lookahead
  // requires a non-delimiter content char so real art (`********`,
  // `*-----*`, `* * *`) is unaffected.
  const EMPHASIS_RE = /^\s{0,3}(\*{2,3}|_{2,3})(?=[^\s*_])/;

  // GFM tables: a header row (`| A | B |`) followed by a separator row
  // (`|---|---|`) renders natively in markdown — it must never be fenced as
  // art. The separator is the disambiguator from a box-drawing ASCII diagram
  // (which uses `+`/`-` frames and `|` interiors, not a `|-|` separator).
  const TABLE_HEADER_RE = /^\s*\|.*\|\s*$/;
  const TABLE_SEPARATOR_RE = /^[\s|:\-]+$/;
  const isTableSeparator = (l: string): boolean =>
    TABLE_SEPARATOR_RE.test(l) && l.includes("|") && l.includes("-");

  const isArtLine = (line: string): boolean => {
    if (LIST_ITEM_RE.test(line)) return false;
    if (ATX_HEADING_RE.test(line)) return false;
    if (SETEXT_UNDERLINE_RE.test(line)) return false;
    if (THEMATIC_BREAK_RE.test(line)) return false;
    if (EMPHASIS_RE.test(line)) return false;
    if (BOX_RE.test(line)) return true;
    if (ASCII_LINE_RE.test(line)) return true;
    // Lines bracketed by frame chars at both ends (e.g. "│ Content  │", "+--+")
    if (/^\s*[|+\-\\/=<>].*[|+\-\\/=<>]\s*$/.test(line)) return true;
    // Lines composed entirely of frame/decorator chars (e.g. "+-----+", "-------")
    if (/^[\s|+\-\\/=<>^v.#*~:]+$/.test(line) && line.trim().length >= 3) return true;
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Fence delimiter (up to 3 leading spaces per CommonMark): toggle and
    // flush any pending run so it never merges across the boundary.
    if (/^\s{0,3}```/.test(line)) {
      if (inArt) flushArt();
      else if (artRun.length > 0) {
        out.push(...artRun);
        artRun = [];
      }
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    // GFM table block: header row immediately followed by a separator row.
    // Emit the header, separator, and any `| … |` body rows verbatim so the
    // renderer treats them as a table rather than ASCII art.
    if (
      TABLE_HEADER_RE.test(line) &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      if (inArt) flushArt();
      else if (artRun.length > 0) {
        out.push(...artRun);
        artRun = [];
      }
      out.push(line); // header
      out.push(lines[++i]); // separator
      while (i + 1 < lines.length && TABLE_HEADER_RE.test(lines[i + 1])) {
        out.push(lines[++i]); // body rows
      }
      continue;
    }
    const art = isArtLine(line);
    // A blank line next to an art line stays in the art block
    // (diagrams often have blank lines between sections).
    const blankNearArt =
      line.trim() === "" &&
      artRun.length > 0 &&
      i + 1 < lines.length &&
      isArtLine(lines[i + 1]);

    if (art || blankNearArt) {
      if (!inArt) {
        // Flush any preceding non-art lines as-is.
        if (artRun.length > 0) {
          out.push(...artRun);
          artRun = [];
        }
      }
      inArt = true;
      artRun.push(line);
    } else {
      if (inArt) flushArt();
      artRun.push(line);
    }
  }
  if (inArt) flushArt();
  else if (artRun.length > 0) out.push(...artRun);

  return out.join("\n");
}
