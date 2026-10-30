import { tool } from "ai";
import { z } from "zod";
import { djb2, readCacheEntry, READ_BYTE_CAP } from "../lib/hash";
import { native } from "../lib/native";
import { checkReadableCanonical, checkWritableCanonical } from "../lib/security";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import { nativeForContext, sandboxOverrideForContext, resolvePath, type ToolContext } from "./context";
import { createCheckpointBatch, snapshotFileForBatch, commitCheckpointBatch } from "../lib/checkpoints";
import { withFileMutationLock } from "../lib/mutationLock";

export type EditResult =
  | { ok: true; replacements: number; bytesWritten: number; path: string }
  | { ok: false; error: string; path: string; editIndex?: number };

/** Compute a batch of edits against IN-MEMORY content without touching
 *  disk — the consolidated batch_edit applies edits per file through this
 *  core so it inherits the hardened matcher (EOL normalize/restore,
 *  fuzzy whitespace fallback, replace_all, line_hint, did-you-mean hints)
 *  while keeping its own all-or-nothing cross-file write phase.
 *  Returns the new content, or the failing edit's index + the same
 *  actionable error applyEdits would surface. */
export async function computeEdits(
  content: string,
  filePath: string,
  edits: { old_string: string; new_string: string; replace_all?: boolean; line_hint?: number }[],
): Promise<{ ok: true; content: string; replacements: number } | { ok: false; error: string; editIndex: number }> {
  const original = content;
  const useCrlf = original.includes("\r\n");
  let text = normEol(original);
  let totalReplacements = 0;
  let skippedIdentical = 0;

  for (const [editIndex, rawEdit] of edits.entries()) {
    const oldNorm = normEol(rawEdit.old_string);
    const newNorm = stripTrailingWs(normEol(rawEdit.new_string), filePath);

    if (oldNorm === newNorm) {
      skippedIdentical++;
      continue;
    }
    if (oldNorm.length === 0) {
      return { ok: false, error: "old_string cannot be empty", editIndex };
    }
    if (rawEdit.replace_all) {
      let n = 0;
      let searchFrom = 0;
      while (searchFrom < text.length) {
        const idx = text.indexOf(oldNorm, searchFrom);
        if (idx === -1) break;
        text = text.slice(0, idx) + newNorm + text.slice(idx + oldNorm.length);
        searchFrom = idx + newNorm.length;
        n++;
        if (n > 1000) break;
      }
      if (n === 0) {
        const fz = fuzzyHits(text, oldNorm);
        if (!fz) {
          return {
            ok: false,
            error: `old_string not found: ${JSON.stringify(oldNorm.slice(0, 80))}.${getDidYouMeanHint(text, oldNorm)}`,
            editIndex,
          };
        }
        if (fz.length > MAX_FUZZY_HITS) {
          return {
            ok: false,
            error: `old_string matched more than ${MAX_FUZZY_HITS} locations after whitespace relaxation — refusing to rewrite that broadly. Narrow old_string.`,
            editIndex,
          };
        }
        for (const h of [...fz].sort((a, b) => b.index - a.index)) {
          text = text.slice(0, h.index) + newNorm + text.slice(h.index + h.length);
        }
        n = fz.length;
      }
      totalReplacements += n;
    } else {
      let idx = text.indexOf(oldNorm);
      let matchLen = oldNorm.length;
      if (idx === -1) {
        const fz = fuzzyHits(text, oldNorm);
        if (!fz) {
          return {
            ok: false,
            error: `old_string not found: ${JSON.stringify(oldNorm.slice(0, 80))}.${getDidYouMeanHint(text, oldNorm)}`,
            editIndex,
          };
        }
        let chosen = fz[0];
        if (fz.length > 1) {
          if (rawEdit.line_hint) {
            chosen = fz.reduce((best, cur) =>
              Math.abs(cur.line - rawEdit.line_hint!) <
              Math.abs(best.line - rawEdit.line_hint!)
                ? cur
                : best,
            );
          } else {
            return {
              ok: false,
              error:
                `old_string matched ${fz.length} locations (lines ${fz
                  .slice(0, 8)
                  .map((h) => h.line)
                  .join(", ")}) only after whitespace relaxation — nothing was changed. Copy the block verbatim from the file (tabs vs spaces included), widen it with surrounding context, or pass line_hint to pick one.`,
              editIndex,
            };
          }
        }
        idx = chosen.index;
        matchLen = chosen.length;
      }
      const secondIdx = text.indexOf(oldNorm, idx + matchLen);
      if (secondIdx !== -1 && !rawEdit.line_hint) {
        return {
          ok: false,
          error:
            "old_string is not unique. Provide more surrounding context, set replace_all=true, or provide line_hint to disambiguate.",
          editIndex,
        };
      }
      let chosenIdx = idx;
      if (secondIdx !== -1 && rawEdit.line_hint) {
        const occurrences: number[] = [idx, secondIdx];
        let next = secondIdx;
        for (let i = 0; i < 50; i++) {
          const nidx = text.indexOf(oldNorm, next + oldNorm.length);
          if (nidx === -1) break;
          occurrences.push(nidx);
          next = nidx;
        }
        chosenIdx = occurrences.reduce((best, cur) => {
          const cLine = text.slice(0, cur).split("\n").length;
          const bLine = text.slice(0, best).split("\n").length;
          return Math.abs(cLine - rawEdit.line_hint!) < Math.abs(bLine - rawEdit.line_hint!)
            ? cur : best;
        });
      }
      text = text.slice(0, chosenIdx) + newNorm + text.slice(chosenIdx + matchLen);
      totalReplacements += 1;
    }
  }

  if (totalReplacements === 0 && skippedIdentical > 0 && edits.length > 0) {
    return {
      ok: false,
      error: `all ${skippedIdentical} edit(s) are no-ops (old_string === new_string). Nothing to change — if you intended an edit, correct the strings.`,
      editIndex: 0,
    };
  }

  if (useCrlf) {
    text = text.replace(/\n/g, "\r\n");
  }
  return { ok: true, content: text, replacements: totalReplacements };
}

/** Strip trailing whitespace from each line, preserving line endings.
 *  Exempt .md/.mdx where trailing spaces are meaningful (hard line breaks). */
function stripTrailingWs(s: string, filePath: string): string {
  if (/\.(md|mdx)$/i.test(filePath)) return s;
  return s.replace(/[^\S\n\r]+$/gm, "");
}

/** One relaxed replacement target: a TRUE region [index, index+length)
 *  into the original text. `line` is the 1-based start line of the region,
 *  for line_hint disambiguation. */
type FuzzyHit = { index: number; length: number; line: number };

/** Cap for collected relaxed matches; beyond it a replace_all is too broad
 *  to act on and single edits bounce as ambiguous anyway. */
const MAX_FUZZY_HITS = 50;

/** Escape a literal for RegExp source. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Aider-style whitespace-tolerant find.
 *
 * The model usually gets the TOKENS right and the WHITESPACE wrong (tabs
 * vs spaces, collapsed runs, re-wrapped spacing, trailing drift). Build a
 * regex from old_string where every whitespace run becomes tolerant —
 * intra-line runs match [ \t]* (the model may have eaten or added the
 * space), inter-line runs require the newline (\n) to exist but absorb
 * any indentation and blank-line drift around it — and return every match
 * with its TRUE region in the original text.
 *
 * True regions are the whole point. The predecessor mapped a normalized
 * match back to a START offset only and callers spliced old_string.length
 * characters — for a relaxed match that is the wrong length: a
 * spaces-indented needle against a tab-indented line silently ate the
 * newline plus the next line's head. Corruption through the very fallback
 * meant to prevent failure.
 *
 * When a match covers a whole line's non-whitespace content (nothing but
 * whitespace before it on that line and after it to EOL), the region is
 * EXTENDED to the full line(s) so the replacement carries the model's own
 * indentation — models routinely send a fully re-indented new_string
 * against a differently-indented old line. Partial-line matches keep the
 * exact token region so surrounding text ("x = " before "= 1;") survives.
 *
 * Multi-hit is returned in full (capped) — the CALLER decides: single
 * edits bounce unless line_hint disambiguates, replace_all consumes them.
 */
function fuzzyHits(
  content: string,
  needle: string,
  maxHits = MAX_FUZZY_HITS,
): FuzzyHit[] | null {
  const trimmed = needle.replace(/^\s+|\s+$/g, "");
  if (!trimmed) return null;
  const parts = trimmed.split(/(\s+)/); // alternating non-ws / ws runs
  let pattern = "";
  for (const part of parts) {
    if (part === "") continue;
    if (/^\s+$/.test(part)) {
      pattern += part.includes("\n") ? "[\\s]*\\n[\\s]*" : "[ \\t]*";
    } else {
      pattern += escapeRe(part);
    }
  }
  if (!pattern) return null;
  let re: RegExp;
  try {
    re = new RegExp(pattern, "g");
  } catch {
    return null;
  }
  const hits: FuzzyHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1; // pathological empty match guard
      continue;
    }
    let index = m.index;
    let end = m.index + m[0].length;
    // Whole-content-line coverage → extend to full lines (indent included).
    const lineStart = content.lastIndexOf("\n", index - 1) + 1;
    const lineEnd = content.indexOf("\n", end) === -1 ? content.length : content.indexOf("\n", end);
    const before = content.slice(lineStart, index);
    const after = content.slice(end, lineEnd);
    if (before.trim() === "" && after.trim() === "") {
      index = lineStart;
      end = lineEnd;
    }
    hits.push({
      index,
      length: end - index,
      // Newlines before `index` + 1. (NOT split("\n", index).length — the
      // second arg is an array LIMIT, so it returned the total line count for
      // every hit and made the line_hint nearest-pick degenerate to first-hit.)
      line: content.slice(0, index).split("\n").length,
    });
    if (hits.length > maxHits) break;
  }
  return hits.length > 0 ? hits : null;
}

/** Normalize line endings to \n for comparison purposes only. */
function normEol(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/**
 * Generate an actionable hint when old_string fails to match.
 * Shows the closest matching region with a character-level mismatch diagnostic.
 */
/** Equivalence classes of punctuation marks that terminal rendering and
 *  OCR make visually indistinguishable (em/en dash vs hyphen, curly vs
 *  straight quotes). Compared against the needle's trimmed lines. */
const PUNCT_CLASSES: string[][] = [
  ["\u2014", "\u2013", "-"], // em dash / en dash / hyphen
  ["\u201C", '\"'], // curly double quotes / straight
  ["\u201D", '\"'],
  ["\u2018", "'"], // curly single quotes / straight
  ["\u2019", "'"],
  ["\u2192", "->"], // arrow vs ASCII arrow
  ["\u00B7", "."], // middle dot vs period
];

function flattenPunct(s: string): string {
  let out = s;
  for (const cls of PUNCT_CLASSES) {
    // Use the LAST member (the plain ASCII form) for every member.
    const canon = cls[cls.length - 1]!;
    for (const ch of cls) {
      if (ch !== canon) out = out.split(ch).join(canon);
    }
  }
  return out;
}

/** True when two strings differ ONLY by punctuation equivalence classes. */
function punctEquivalent(a: string, b: string): boolean {
  if (a === b) return false;
  return flattenPunct(a) === flattenPunct(b);
}

/** Diagnose a punctuation-only near miss: file line number + the exact
 *  characters that differ, so the model can fix its anchor in one retry. */
function getPunctuationNearMiss(
  hLines: string[],
  nLines: string[],
): string {
  for (const nl of nLines) {
    const trimmedNeedle = nl.trim();
    if (!trimmedNeedle) continue;
    for (let i = 0; i < hLines.length; i++) {
      const hl = hLines[i]!.trim();
      if (hl === trimmedNeedle) continue; // exact - not a miss
      if (punctEquivalent(hl, trimmedNeedle)) {
        // Name every differing character.
        const diffs: string[] = [];
        const len = Math.min(hl.length, trimmedNeedle.length);
        for (let k = 0; k < len; k++) {
          const a = hl[k]!;
          const b = trimmedNeedle[k]!;
          if (a !== b) {
            const aCode = a.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
            const bCode = b.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
            diffs.push(
              `file has U+${aCode} (${JSON.stringify(a)}) but old_string has U+${bCode} (${JSON.stringify(b)})`,
            );
            if (diffs.length >= 4) break;
          }
        }
        if (hl.length !== trimmedNeedle.length && diffs.length < 4) {
          diffs.push(
            `length differs: file ${hl.length} vs old_string ${trimmedNeedle.length} chars`,
          );
        }
        return ` Punctuation near-miss on file line ${i + 1}: ${diffs.join(", ")}. Copy the line VERBATIM from the file (do not retype the dash or quote characters).`;
      }
    }
  }
  return "";
}

function getDidYouMeanHint(haystack: string, needle: string): string {
  const hLines = normEol(haystack).split("\n");
  const nLines = needle.split("\n").map((l) => l.trim()).filter(Boolean);
  if (nLines.length === 0) return "";

  // Score every file line against every needle line
  const matches: { lineNum: number; content: string; score: number; mismatch?: string }[] = [];
  for (let i = 0; i < hLines.length; i++) {
    const hl = hLines[i].trim();
    if (!hl) continue;
    for (const nl of nLines) {
      if (hl.includes(nl) || nl.includes(hl)) {
        matches.push({ lineNum: i + 1, content: hLines[i], score: Math.min(hl.length, nl.length) });
        break;
      }
    }
  }

  // Diagnose whitespace mismatches: compare first needle line against best candidate
  let wsDiag = "";
  const firstNeedle = needle.split("\n")[0] ?? "";
  if (firstNeedle.length > 0) {
    // Find best candidate line by non-whitespace content
    const stripped = firstNeedle.trim();
    for (let i = 0; i < hLines.length; i++) {
      if (hLines[i].trim() === stripped) {
        const fileLead = hLines[i].match(/^(\s*)/)?.[1] ?? "";
        const needleLead = firstNeedle.match(/^(\s*)/)?.[1] ?? "";
        if (fileLead !== needleLead) {
          const fileDesc = fileLead.includes("\t")
            ? `${fileLead.length} chars (tabs)` : `${fileLead.length} spaces`;
          const needleDesc = needleLead.includes("\t")
            ? `${needleLead.length} chars (tabs)` : `${needleLead.length} spaces`;
          wsDiag = ` Whitespace mismatch on line ${i + 1}: file has ${fileDesc} indent but old_string has ${needleDesc}.`;
        }
        break;
      }
    }
  }

  if (matches.length === 0) {
    // Punctuation near-miss: the model's anchor and the file differ only in
    // a punctuation mark (em-dash vs hyphen, curly vs straight quotes).
    // Terminal output and OCR routinely render these ambiguously, and the
    // fuzzy tier only relaxes WHITESPACE, so a single such char bounced
    // edits forever with a "not found" that named a visually identical
    // block. Point at the actual difference instead.
    const punctuationDiag = getPunctuationNearMiss(hLines, nLines);
    return `${wsDiag}${punctuationDiag} Read the file again to get the exact content and indentation.`;
  }

  matches.sort((a, b) => b.score - a.score);
  const best = matches.slice(0, 3);
  return `${wsDiag} Similar lines in file:\n${best.map((m) => `  L${m.lineNum}: ${JSON.stringify(m.content.trimEnd())}`).join("\n")}`;
}

export async function applyEdits(
  abs: string,
  edits: { old_string: string; new_string: string; replace_all?: boolean; line_hint?: number }[],
  kind: "edit" | "batch_edit",
  readCache: Map<string, { size: number; hash: number }>,
  client: typeof native = native,
): Promise<EditResult> {
  const r = await client.readFile(abs);
  if (r.kind === "binary")
    return { ok: false, error: "binary file refused", path: abs };
  if (r.kind === "toolarge")
    return { ok: false, error: `file too large (${r.size} bytes)`, path: abs };

  const original = r.content;

  // Self-heal the cache when content drifted: refresh from disk. Compare
  // HASH ONLY — size is derived (disk bytes vs UTF-16 length disagree on
  // any non-ASCII file) and must never participate in a comparison.
  const cached = readCache.get(abs);
  if (cached && cached.hash !== djb2(original)) {
    readCache.set(abs, readCacheEntry(original));
  }

  // Normalize the entire file content to \n before applying edits, then
  // restore the original line-ending style at the end. This avoids
  // positional drift that occurs when mapping CRLF↔LF per edit in
  // sequential batch_edit calls — each edit's position shift compounds.
  const useCrlf = original.includes("\r\n");
  let content = normEol(original);
  let totalReplacements = 0;
  let skippedIdentical = 0;

  for (const [editIndex, rawEdit] of edits.entries()) {
    const oldNorm = normEol(rawEdit.old_string);
    // Strip trailing whitespace from new_string to prevent model-generated
    // trailing spaces from dirtying the file.
    const newNorm = stripTrailingWs(normEol(rawEdit.new_string), abs);

    if (oldNorm === newNorm) {
      // Identical old/new is a no-op. Poisoning the WHOLE batch with an
      // error here (the old behavior) forced the caller into the slow
      // per-edit retry path — one write per edit, the known corruption
      // class. Skip the no-op instead; only error when the batch is
      // ENTIRELY no-ops (nothing was asked for).
      skippedIdentical++;
      continue;
    }
    if (oldNorm.length === 0) {
      return { ok: false, error: "old_string cannot be empty", path: abs, editIndex };
    }
    if (rawEdit.replace_all) {
      let n = 0;
      let searchFrom = 0;
      while (searchFrom < content.length) {
        const idx = content.indexOf(oldNorm, searchFrom);
        if (idx === -1) break;
        content =
          content.slice(0, idx) +
          newNorm +
          content.slice(idx + oldNorm.length);
        searchFrom = idx + newNorm.length;
        n++;
        if (n > 1000) break;
      }
      if (n === 0) {
        // Exact pass found nothing — the relaxed levels get the same
        // chance replace_all was asked for: duplicates are the point, so
        // multi-hit is not ambiguity here. Replace back-to-front so earlier
        // hit offsets stay valid.
        const fz = fuzzyHits(content, oldNorm);
        if (!fz) {
          return {
            ok: false,
            error: `old_string not found: ${JSON.stringify(oldNorm.slice(0, 80))}.${getDidYouMeanHint(content, oldNorm)}`,
            path: abs,
            editIndex,
          };
        }
        if (fz.length > MAX_FUZZY_HITS) {
          return {
            ok: false,
            error: `old_string matched more than ${MAX_FUZZY_HITS} locations after whitespace relaxation — refusing to rewrite that broadly. Narrow old_string.`,
            path: abs,
            editIndex,
          };
        }
        for (const h of [...fz].sort((a, b) => b.index - a.index)) {
          content =
            content.slice(0, h.index) + newNorm + content.slice(h.index + h.length);
        }
        n = fz.length;
      }
      totalReplacements += n;
    } else {
      let idx = content.indexOf(oldNorm);
      // Length of the region being replaced IN THE FILE. Equals oldNorm.length
      // on an exact match; on a whitespace-relaxed match the file's region has
      // a DIFFERENT length (that is the whole point of relaxing) — splicing
      // with oldNorm.length corrupted the file around the edit.
      let matchLen = oldNorm.length;
      if (idx === -1) {
        const fz = fuzzyHits(content, oldNorm);
        if (!fz) {
          return {
            ok: false,
            error: `old_string not found: ${JSON.stringify(oldNorm.slice(0, 80))}.${getDidYouMeanHint(content, oldNorm)}`,
            path: abs,
            editIndex,
          };
        }
        let chosen = fz[0];
        if (fz.length > 1) {
          // A relaxed match hitting several places is never a coin flip:
          // the exact text isn't in the file, so guessing risks rewriting
          // the wrong code. line_hint picks nearest; otherwise bounce with
          // the locations so the model can widen context.
          if (rawEdit.line_hint) {
            chosen = fz.reduce((best, cur) =>
              Math.abs(cur.line - rawEdit.line_hint!) <
              Math.abs(best.line - rawEdit.line_hint!)
                ? cur
                : best,
            );
          } else {
            return {
              ok: false,
              error:
                `old_string matched ${fz.length} locations (lines ${fz
                  .slice(0, 8)
                  .map((h) => h.line)
                  .join(", ")}) only after whitespace relaxation — nothing was changed. Copy the block verbatim from the file (tabs vs spaces included), widen it with surrounding context, or pass line_hint to pick one.`,
              path: abs,
              editIndex,
            };
          }
        }
        idx = chosen.index;
        matchLen = chosen.length;
      }
      // Check uniqueness: search for a second occurrence AFTER the first
      // match. Use exact matching only (not fuzzy whitespace) so indentation
      // variants aren't falsely flagged as duplicates.
      const secondIdx = content.indexOf(oldNorm, idx + matchLen);
      if (secondIdx !== -1 && !rawEdit.line_hint) {
        return {
          ok: false,
          error:
            "old_string is not unique. Provide more surrounding context, set replace_all=true, or provide line_hint to disambiguate.",
          path: abs,
          editIndex,
        };
      }
      // When line_hint is provided and there are multiple matches, pick
      // the occurrence closest to the hinted line number.
      let chosenIdx = idx;
      if (secondIdx !== -1 && rawEdit.line_hint) {
        const occurrences: number[] = [idx, secondIdx];
        let next = secondIdx;
        for (let i = 0; i < 50; i++) {
          const nidx = content.indexOf(oldNorm, next + oldNorm.length);
          if (nidx === -1) break;
          occurrences.push(nidx);
          next = nidx;
        }
        chosenIdx = occurrences.reduce((best, cur) => {
          const cLine = content.slice(0, cur).split("\n").length;
          const bLine = content.slice(0, best).split("\n").length;
          return Math.abs(cLine - rawEdit.line_hint!) < Math.abs(bLine - rawEdit.line_hint!)
            ? cur : best;
        });
      }
      content =
        content.slice(0, chosenIdx) +
        newNorm +
        content.slice(chosenIdx + matchLen);
      totalReplacements += 1;
    }
  }

  // The batch was ENTIRELY identical old/new no-ops — nothing was asked
  // for. Report it as an error so the model notices, instead of silently
  // writing an unchanged file (which would also refresh the read cache for
  // no reason and trigger fs-changed noise).
  if (totalReplacements === 0 && skippedIdentical > 0 && edits.length > 0) {
    return {
      ok: false,
      error: `all ${skippedIdentical} edit(s) are no-ops (old_string === new_string). Nothing to change — if you intended an edit, correct the strings.`,
      path: abs,
    };
  }

  // Restore original line-ending style after all edits are applied.
  if (useCrlf) {
    content = content.replace(/\n/g, "\r\n");
  }

  if (usePlanStore.getState().active) {
    usePlanStore.getState().enqueue({
      id: newQueuedEditId(),
      kind,
      path: abs,
      originalContent: original,
      proposedContent: content,
      isNewFile: false,
    });
    return {
      ok: true,
      replacements: totalReplacements,
      bytesWritten: content.length,
      path: abs,
    };
  }

  try {
    await client.writeFile(abs, content);
    readCache.set(abs, readCacheEntry(content));
    window.dispatchEvent(new CustomEvent("Kai:fs-changed", { detail: abs }));

    return {
      ok: true,
      replacements: totalReplacements,
      bytesWritten: content.length,
      path: abs,
    };
  } catch (err) {
    return { ok: false, error: String(err), path: abs };
  }
}

/**
 * Read-before-edit guard, self-healing: if the file isn't in the read cache
 * (model skipped read_file, session was compacted, or cache was reset),
 * read it once here instead of hard-failing. Returns null on success
 * (cache now warm) or an error result to return to the model.
 * Exported for batch_edit (the consolidated multi-file tool) — it shares
 * the same read-before-edit contract per file.
 */
export async function ensureReadCache(
  abs: string,
  ctx: ToolContext,
  client: typeof native = native,
): Promise<{ error: string; path: string } | null> {
  if (ctx.readCache.has(abs)) return null;
  const safety = await checkReadableCanonical(abs, client.canonicalize, await sandboxOverrideForContext(ctx));
  if (!safety.ok) return { error: safety.reason, path: abs };
  try {
    const r = await client.readFile(safety.canonical);
    if (r.kind === "binary") return { error: "binary file refused", path: abs };
    if (r.kind === "toolarge")
      return { error: `file too large (${r.size} bytes)`, path: abs };
    ctx.readCache.set(abs, readCacheEntry(r.content));
    ctx.fileTracker.markRead(abs);
    return null;
  } catch (e) {
    return {
      error: `cannot edit "${abs}": read failed (${String(e)}). If the file does not exist yet, use write_file to create it.`,
      path: abs,
    };
  }
}

/** Per-path edit failure counter. Resets on success or session switch.
 *  Scoped per ToolContext so cross-session counters don't interfere.
 *  Exported for batch_edit — the shared escape hatch (N failures on one
 *  file → suggest write_file) must count across both entry points. */
const editFailures = new WeakMap<ToolContext, Map<string, number>>();
const MAX_EDIT_RETRIES = 3;

export function getEditFailures(ctx: ToolContext): Map<string, number> {
  let map = editFailures.get(ctx);
  if (!map) {
    map = new Map();
    editFailures.set(ctx, map);
  }
  return map;
}

export const EDIT_MAX_RETRIES = MAX_EDIT_RETRIES;

export function buildEditTools(ctx: ToolContext) {
  const native = nativeForContext(ctx);
  return {
    edit: tool({
      description:
        "Replace text in an existing file. HOW IT WORKS: the tool searches the file for old_string and swaps it for new_string. RULES: (1) old_string must be copied EXACTLY from the file — every character, space, and indent; never invent or paraphrase it. (2) To INSERT without deleting, set old_string to the line before/after the spot and repeat that line inside new_string with your addition. (3) If old_string appears more than once, either widen it with surrounding lines to make it unique, or pass line_hint. (4) To create a NEW file use write_file instead. (5) If you need multiple changes — to one file or several — use batch_edit: each edit entry carries its own path; all edits apply atomically (any failure writes nothing). Never emit separate edit calls for the same file in one step (they race each other). Asks for user approval. The prior content is auto-checkpointed — revert a bad edit with `checkpoint_undo`.",
      inputSchema: z.object({
        path: z.string().optional(),
        old_string: z
          .string()
          .describe("The exact text to find and replace. Must match the file content exactly. Must be unique unless replace_all or line_hint."),
        new_string: z.string().describe("The replacement text."),
        replace_all: z.boolean().optional(),
        line_hint: z
          .number()
          .optional()
          .describe("Approximate 1-based line number where the edit should apply. Used to disambiguate when old_string appears more than once."),
      }),
      needsApproval: true,
      execute: async ({ path: pathArg, old_string, new_string, replace_all, line_hint }) => {
        const path = pathArg ?? "";
        if (!path)
          return {
            error:
              'path is required — set the top-level "path" field to the file you are editing (absolute, or relative to the terminal cwd). Example: {"path":"src/app.ts","old_string":"...","new_string":"..."}',
          };
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkWritableCanonical(reqPath, native.canonicalize, await sandboxOverrideForContext(ctx));
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        const guard = await ensureReadCache(abs, ctx, native);
        if (guard) return guard;
        const failures = getEditFailures(ctx).get(abs) ?? 0;
        if (failures >= MAX_EDIT_RETRIES) {
          getEditFailures(ctx).delete(abs);
          return {
            error:
              `edit failed ${MAX_EDIT_RETRIES} times on this file. ` +
              `write_file may be blocked by its partial-view guard for files over ${Math.round(READ_BYTE_CAP / 1024)}KB - ` +
              `if so, page read_file (offset/limit) until untruncated FIRST, or split the file. ` +
              `Re-read the file (force: true) and retry edit with anchors copied VERBATIM before falling back.`,
            path: abs,
          };
        }
        // Serialize against other edits/writes to the SAME file so parallel
        // tool calls from one step don't clobber each other via stale reads.
        return withFileMutationLock([abs], async () => {
          // Snapshot before mutation for checkpoint undo.
          const checkpoint = createCheckpointBatch(
            ctx.getRealWorkspaceRoot?.() ?? ctx.getWorkspaceRoot() ?? "",
            ctx.getSessionId() ?? "",
            native,
          );
          await snapshotFileForBatch(checkpoint, abs);
          const edits = [{ old_string, new_string, replace_all, line_hint }];
          const result = await applyEdits(abs, edits, "edit", ctx.readCache, native);
          if (result.ok) {
            getEditFailures(ctx).delete(abs);
            ctx.fileTracker.markModified(abs);
            await commitCheckpointBatch(checkpoint);
            return result;
          }
          // If old_string wasn't found, re-read the file (a prior concurrent
          // edit to the same file may have shifted content) and retry once.
          const retryable =
            result.error.startsWith("old_string not found");
          if (retryable) {
            // Force cache refresh so applyEdits re-reads from disk.
            ctx.readCache.delete(abs);
            const retry = await applyEdits(abs, edits, "edit", ctx.readCache, native);
            if ("ok" in retry) {
              getEditFailures(ctx).delete(abs);
              ctx.fileTracker.markModified(abs);
              await commitCheckpointBatch(checkpoint);
              return retry;
            }
            // Retry also failed — the target was consumed by a racing edit.
            // Append a hint so the model recovers instead of giving up.
            getEditFailures(ctx).set(abs, failures + 1);
            return {
              ...result,
              error:
                result.error +
                "\n\n(Still not found after re-read. This usually means another edit to the same file already consumed or displaced the target text. Re-read the file to get the current content, then resubmit. Better: use batch_edit for all same-file changes — it applies edits sequentially in one atomic operation instead of racing.)",
            };
          }
          getEditFailures(ctx).set(abs, failures + 1);
          return result;
        });
      },
    }),

    checkpoint_undo: tool({
      description:
        "Revert the last AI-write batch (write_file / edit / batch_edit) to its pre-write snapshot — every one of those tools auto-checkpoints before mutating, so this is always available after a write. Call it when an edit produced an unexpected result, when the user says 'undo that' / 'revert', or when you need to abandon a partial change set and retry a different approach. Takes no arguments; reverts the most recent batch only.",
      inputSchema: z.object({}),
      needsApproval: true,
      execute: async () => {
        const root = ctx.getWorkspaceRoot();
        if (!root) return { error: "no workspace root — cannot find checkpoints" };
        const { listCheckpoints, restoreCheckpoint } = await import("../lib/checkpoints");
        const records = await listCheckpoints(root);
        if (records.length === 0) {
          return { message: "no checkpoints found — nothing to undo" };
        }
        const last = records[records.length - 1];
        const result = await restoreCheckpoint(last, root);
        // Delete the checkpoint file after successful restore.
        try {
          const { getKaiStateDir } = await import("../lib/kaiPaths");
          const ckDir = await getKaiStateDir(root, "checkpoints");
          const files = await native.readDir(ckDir);
          for (const f of files) {
            if (f.name.includes(String(last.timestamp))) {
              await native.deleteFile(`${ckDir}/${f.name}`);
              break;
            }
          }
        } catch { /* best effort */ }
        return {
          restored: result.restored,
          deleted: result.deleted,
          skipped: result.skipped.length > 0 ? result.skipped : undefined,
          errors: result.errors.length > 0 ? result.errors : undefined,
          checkpoint_age_seconds: Math.round((Date.now() - last.timestamp) / 1000),
        };
      },
    }),
  } as const;
}