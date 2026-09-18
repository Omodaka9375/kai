/**
 * Pure text-processing utilities for the chat renderer.
 *
 * These are hot-path functions (run per streamed text/reasoning part) —
 * kept free of React so they are trivially unit-testable.
 */

import { wrapAsciiArt } from "./wrapAsciiArt";

export type ContextChip =
  | { kind: "selection"; source: "terminal" | "editor"; lines: number }
  | { kind: "file"; name: string; lines: number }
  | { kind: "snippet"; name: string };

const SELECTION_RE =
  /<selection\s+source="(terminal|editor)">\n?([\s\S]*?)\n?<\/selection>/g;
const FILE_RE =
  /<file\s+name="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/file>/g;
const SNIPPET_RE = /<snippet\s+name="([^"]+)">\n?[\s\S]*?\n?<\/snippet>/g;

function countLines(s: string): number {
  if (!s) return 0;
  const trimmed = s.replace(/\n+$/, "");
  if (!trimmed) return 0;
  return trimmed.split("\n").length;
}

export function stripUserContextBlocks(text: string): {
  text: string;
  chips: ContextChip[];
} {
  const chips: ContextChip[] = [];
  let out = text;
  out = out.replace(SELECTION_RE, (_m, source: string, body: string) => {
    chips.push({
      kind: "selection",
      source: source === "editor" ? "editor" : "terminal",
      lines: countLines(body),
    });
    return "";
  });
  out = out.replace(FILE_RE, (_m, name: string, body: string) => {
    chips.push({ kind: "file", name, lines: countLines(body) });
    return "";
  });
  out = out.replace(SNIPPET_RE, (_m, name: string) => {
    chips.push({ kind: "snippet", name });
    return "";
  });
  return { text: out.trim(), chips };
}

const THINKING_BOUNDARY_RE = new RegExp(
  "<\\/?thinking>|<\\|\\/?thinking\\|>|\\n{2}\\s* response|\\n{2}\\s*",
  "gi",
);

/**
 * Strip orphaned thinking markers from visible text. These can leak when
 * the model emits a closing tag like `</thinking>` or `<|/thinking|>` or
 * an AI SDK `` / `` marker without a matching opening tag
 * (the opening was consumed upstream by the AI SDK's reasoning detector).
 */
function stripThinkingMarkers(text: string): string {
  return text.replace(THINKING_BOUNDARY_RE, "").trimStart();
}

export function splitThinkingBlocks(
  text: string,
): { thinking: boolean; text: string }[] {
  const out: { thinking: boolean; text: string }[] = [];

  // Unified regex that matches XML-style <thinking>...</thinking>,
  // pipe-delimited <|thinking|>...</|thinking|>, and AI SDK thought
  // protocol </think>... (Vercel AI SDK v6 format).
  const re = new RegExp(
    "<thinking>([\\s\\S]*?)<\\/thinking>" +
      "|<\\|thinking\\|>([\\s\\S]*?)<\\|\\/thinking\\|>" +
      "|\\n{2}</think>([\\s\\S]*?)\\n{2}",
    "gi",
  );
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ thinking: false, text: stripThinkingMarkers(text.slice(last, m.index)) });
    // Group 1 = XML, group 2 = pipe-delimited, group 3 = AI SDK protocol
    const inner = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (inner) out.push({ thinking: true, text: inner });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    const cleaned = stripThinkingMarkers(text.slice(last));
    if (cleaned.trim()) out.push({ thinking: false, text: cleaned });
  }
  return out;
}

/** Strip leaked model thinking/channel tokens and raw tool call syntax. */
/** Remove a partial trailing token like `<|cha` or `<foo` at the very end of
 *  a still-streaming text. Linear scan (no regex) — the previous `$`-anchored
 *  global regexes were O(braces·len) on content with many `<`/`|` chars.
 *  Requires at least one alphanumeric so we don't eat legitimate symbols
 *  like `<-` or `|->`. */
function stripTrailingPartialTag(s: string): string {
  const n = s.length;
  if (n === 0) return s;
  let j = n;
  while (j > 0) {
    const c = s.charCodeAt(j - 1);
    const isRunChar =
      (c >= 48 && c <= 57) || // 0-9
      (c >= 65 && c <= 90) || // A-Z
      (c >= 97 && c <= 122) || // a-z
      c === 95 || // _
      c === 45; // -
    if (!isRunChar) break;
    j--;
  }
  if (j === n || j === 0) return s;
  // First char after the tag marker must be alphanumeric or underscore
  // (not `-`/`_`-only), matching the original `[a-z_0-9]` requirement.
  const first = s.charCodeAt(j);
  const isFirstAlnum =
    (first >= 48 && first <= 57) ||
    (first >= 65 && first <= 90) ||
    (first >= 97 && first <= 122) ||
    first === 95;
  if (!isFirstAlnum) return s;
  const prev = s[j - 1];
  if (prev === "|" && j >= 2 && s[j - 2] === "<") return s.slice(0, j - 2);
  if (prev === "|" || prev === "<") return s.slice(0, j - 1);
  return s;
}

export function stripLeakedTokens(text: string): string {
  let cleaned = text;

  // Every replace is guarded by a cheap indexOf on its trigger token, so the
  // regexes never scan content that can't match them. This is critical for
  // streaming: `stripLeakedTokens` runs on the WHOLE accumulated text on
  // every streamed token (both text and reasoning parts). The unguarded JSON
  // regex below is O(braces·len) — when a model "thinks" about code/JSON the
  // text is full of `{`, so each token triggered a quadratic scan and froze
  // the app until the reasoning finished.

  // Raw leaked JSON tool-call payloads containing <|"|> delimiters — runs
  // FIRST because the payload regex needs the delimiter to still be present
  // (the later <|"|> cleanup below would otherwise consume it).
  if (cleaned.includes('<|"|>')) {
    cleaned = cleaned.replace(
      /(?:^|,)?\s*\{[\s\S]*?(?:new_string|old_string|path|proposedContent|proposed_content)\s*:\s*<\|"\|>[\s\S]*?\}(?:\s*,?)?/gi,
      "",
    );
  }

  if (cleaned.includes("<|")) {
    cleaned = cleaned
      .replace(/<\|channel\|?>[\s\S]*?<\|?channel\|>/gi, "")
      .replace(/<\|(?:start|end)_of_thought\|>/gi, "")
      .replace(/<\|thinking\|>[\s\S]*?<\| \/thinking\|>/gi, "")
      .replace(/<\|thinking\|>[\s\S]*?<\|?\/thinking\|>/gi, "")
      .replace(/<\|im_(?:start|end)\|>[^\n]*/g, "")
      // Raw tool call syntax leaked by Gemma 4 and similar models.
      .replace(/<\|?tool_call_?[a-z_]*(?::|\|?>)?/gi, "")
      .replace(/<\|?\/tool_call_?[a-z_]*(?:\|?>)?/gi, "")
      .replace(/<\|"\|>/g, "");
  }
  // Strip XML-style <thinking>…</thinking> blocks (complete or dangling open
  // tag). Only strip a dangling <thinking> if NO closing </thinking> follows.
  if (cleaned.includes("<thinking")) {
    cleaned = cleaned
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
      .replace(/<thinking>(?![\s\S]*<\/thinking>)[\s\S]*$/gi, "");
  }
  // Strip AI SDK thought protocol markers (Vercel AI SDK v6).
  if (cleaned.includes("</")) {
    cleaned = cleaned.replace(/\n{2}[\s\S]*?\n{2}/gi, "");
  }
  if (
    cleaned.includes("call:") ||
    cleaned.includes("<tool_call") ||
    cleaned.includes("</tool_call")
  ) {
    cleaned = cleaned
      .replace(/call:[a-z_]+\{[^}]*\}(?:<[^>]*>)?/gi, "")
      .replace(/<tool_call>?/gi, "")
      .replace(/<\/tool_call>?/gi, "");
  }
  // Strip any trailing partial or incomplete tags/tokens at the very end of
  // the text stream (linear scan).
  cleaned = stripTrailingPartialTag(cleaned);

  // Convert LaTeX math arrow symbols to standard Unicode arrows
  cleaned = cleaned
    .replace(/\$?\\(rightarrow|to)\$?/gi, "→")
    .replace(/\$?\\(leftarrow|gets)\$?/gi, "←")
    .replace(/\$?\\(Rightarrow)\$?/gi, "⇒")
    .replace(/\$?\\(Leftarrow)\$?/gi, "⇐")
    .replace(/\$?\\(leftrightarrow)\$?/gi, "↔")
    .replace(/\$?\\(Leftrightarrow)\$?/gi, "⇔");

  // Wrap ASCII / box-drawing diagrams in code fences so markdown
  // renderers preserve the line breaks.
  cleaned = wrapAsciiArt(cleaned);

  return cleaned.trim();
}

/**
 * Markdown whose only content is horizontal-rule lines (`---`, `***`, `___`)
 * and whitespace. Some models emit a bare `---` separator as their whole
 * "text" part; Streamdown renders that as an empty `<hr />` bubble. Treat it
 * as nothing so the chat never shows an empty message block.
 */
export function isBlankMarkdown(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const hr = /^\s*(?:[-*_]\s*){3,}\s*$/;
  return lines.every((line) => line.trim() === "" || hr.test(line));
}
