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

/**
 * PATH-RECOVERY (2026-11-06, from the GLM "edit keeps dropping the path
 * field" report): some local servers (GLM 5.3 Flash over llama.cpp-class
 * backends observed) emit tool-call arguments in ALPHABETICAL key order and
 * silently truncate the tail of long streamed arguments. On the edit tools
 * that lands exactly on `path` (it sorts after line_hint/new_string/old_
 * string), producing a well-formed JSON object without the ONE field that
 * identifies the file — the model retried the identical call forever.
 *
 * Recovery: the edit pipeline REQUIRES a fresh read of the target before any
 * write (read-before-edit guard), so when `path` is missing we can often
 * infer it: the file most recently read through this session's tool
 * pipeline. That is a guarded, transparent guess, not a free action:
 *
 *  - Only files the model has actually READ (or freshly written) this
 *    session are candidates — the readCache is the same source the
 *    read-before-edit guard enforces, so the inferred target is always a
 *    file the model has current knowledge of.
 *  - UNAMBIGUOUS ONLY: if two or more candidates are within a 10-second
 *    recency window (a paged multi-file read), we cannot tell which file
 *    the call meant — refuse rather than edit the wrong file.
 *  - The result tells the model WHICH file was targeted, so a wrong guess
 *    is visible and correctable instead of silent.
 *
 * Returns null when there is no safe candidate; callers keep their explicit
 * path-required error in that case.
 */
export function recoverEditTargetPath(ctx: ToolContext): string | null {
  let best: { path: string; at: number } | null = null;
  let secondBestAt = 0;
  for (const [path, entry] of ctx.readCache) {
    const at = entry.lastReadAt ?? 0;
    if (!at) continue;
    if (!best || at > best.at) {
      secondBestAt = best?.at ?? 0;
      best = { path, at };
    } else if (at > secondBestAt) {
      secondBestAt = at;
    }
  }
  if (!best) return null;
  // Ambiguity guard: a recent multi-file read burst (paging through several
  // files back-to-back) leaves two candidates too close to call. A single
  // recent read is a confident guess; near-ties are not.
  if (secondBestAt > 0 && best.at - secondBestAt < 10_000) return null;
  return best.path;
}

/**
 * Content-verified path recovery for dropped `path` arguments.
 *
 * Pure recency (`recoverEditTargetPath`) fails in two common cases:
 *  1. Parallel/burst reads: reading 2+ files within 10s permanently ties the
 *     timestamps until another read, even when `old_string` exists in ONLY one
 *     of those files.
 *  2. Quick side-reads: reading file A to edit it, then briefly reading file B
 *     to check an exported type >10s later makes B the recency winner even
 *     though `old_string` only matches A.
 *
 * When `old_string` is non-empty, probe the session's `readCache` files with
 * `computeEdits`:
 *  - Exactly ONE file matches -> return it (resolves burst ties AND prevents
 *    targeting a side-read file that doesn't contain the anchor).
 *  - MULTIPLE files match -> genuinely ambiguous anchor; return null rather
 *    than guessing by timestamp.
 *  - ZERO files match (e.g. slightly stale anchor so the model needs the
 *    "Similar lines in file" diagnostic) -> fall back to `recoverEditTargetPath`.
 */
const MAX_CONTENT_RECOVERY_PROBES = 12;

export async function recoverEditTargetPathByContent(
  ctx: ToolContext,
  oldString?: string,
  opts?: {
    replace_all?: boolean;
    line_hint?: number;
    /** Set false when caller has a stronger fallback (e.g. sharedSiblingPath)
     *  that should win over an unrelated recency guess on 0 matches. */
    allowRecencyFallback?: boolean;
  },
): Promise<string | null> {
  if (ctx.readCache.size === 0) return null;
  const needle = typeof oldString === "string" ? oldString : "";
  if (needle.trim().length > 0) {
    const client = nativeForContext(ctx);
    const override = await sandboxOverrideForContext(ctx);
    const matches: string[] = [];
    const probe = [
      {
        old_string: needle,
        new_string: `${needle}_`,
        ...(opts?.replace_all !== undefined ? { replace_all: opts.replace_all } : {}),
        ...(opts?.line_hint !== undefined ? { line_hint: opts.line_hint } : {}),
      },
    ];
    // Probe newest-first, capped, and re-verify readability/sandbox per file
    // so a TOCTOU symlink swap or tightened sandbox cannot be probed.
    const candidates = [...ctx.readCache.entries()]
      .sort((a, b) => (b[1].lastReadAt ?? 0) - (a[1].lastReadAt ?? 0))
      .slice(0, MAX_CONTENT_RECOVERY_PROBES);
    for (const [candidatePath] of candidates) {
      try {
        const readable = await checkReadableCanonical(
          candidatePath,
          client.canonicalize,
          override,
        );
        if (!readable.ok) continue;
        const r = await client.readFile(readable.canonical);
        if (r.kind !== "text") continue;
        const test = await computeEdits(r.content, readable.canonical, probe);
        if (test.ok) {
          matches.push(readable.canonical);
          if (matches.length > 1) break;
        }
      } catch {
        // Ignore unreadable/deleted cache entries during probe.
      }
    }
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) return null;
  }
  if (opts?.allowRecencyFallback === false) return null;
  return recoverEditTargetPath(ctx);
}

/** Normalize common field aliases onto `{ path?, old_string, new_string, replace_all?, line_hint? }`. */
function normalizeEditFields(raw: Record<string, unknown>): Record<string, unknown> {
  const pathVal =
    typeof raw.path === "string" && raw.path.trim().length > 0
      ? raw.path.trim()
      : typeof raw.file_path === "string" && raw.file_path.trim().length > 0
        ? raw.file_path.trim()
        : typeof raw.file === "string" && raw.file.trim().length > 0
          ? raw.file.trim()
          : undefined;
  const oldVal =
    typeof raw.old_string === "string"
      ? raw.old_string
      : typeof raw.old_str === "string"
        ? raw.old_str
        : undefined;
  const newVal =
    typeof raw.new_string === "string"
      ? raw.new_string
      : typeof raw.new_str === "string"
        ? raw.new_str
        : undefined;
  const out: Record<string, unknown> = {};
  if (pathVal !== undefined) out.path = pathVal;
  if (oldVal !== undefined) out.old_string = oldVal;
  if (newVal !== undefined) out.new_string = newVal;
  if (typeof raw.replace_all === "boolean") out.replace_all = raw.replace_all;
  if (typeof raw.line_hint === "number" && Number.isFinite(raw.line_hint)) {
    out.line_hint = raw.line_hint;
  }
  return out;
}

/**
 * Deterministic pre-schema repair for `edit` and `batch_edit` tool calls
 * (`experimental_repairToolCall` hook in AI SDK).
 *
 * Keeping `path` strictly REQUIRED in the wire JSON Schema prevents models
 * from treating it as optional, while repairing dropped `path` or drifted
 * shapes (`file_path`, top-level `path` on `batch_edit`, single-edit object
 * passed to `batch_edit`) BEFORE Zod validation means:
 *  1. The call succeeds instead of failing with InvalidToolInputError.
 *  2. The repaired `path` is written into `toolCall.input` (with `path` first),
 *     so AI diff tabs, approval cards, `compact.ts` stale-read elision, AND
 *     subsequent conversation turns all see a canonical `{ path, ... }` call
 *     (eliminating the in-context imitation loop of path-less calls).
 *
 * Returns a repaired JSON input string, or `null` when repair is unsafe or
 * not applicable.
 */
export async function repairEditToolCallInput(
  ctx: ToolContext,
  toolName: string,
  rawInput: string,
): Promise<string | null> {
  if (toolName !== "edit" && toolName !== "batch_edit") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  if (toolName === "edit") {
    if (Array.isArray(parsed)) return null;
    const norm = normalizeEditFields(parsed as Record<string, unknown>);
    if (typeof norm.old_string !== "string" || typeof norm.new_string !== "string") {
      return null;
    }
    let targetPath = typeof norm.path === "string" ? norm.path : "";
    if (!targetPath) {
      targetPath =
        (await recoverEditTargetPathByContent(ctx, norm.old_string, {
          replace_all: typeof norm.replace_all === "boolean" ? norm.replace_all : undefined,
          line_hint: typeof norm.line_hint === "number" ? norm.line_hint : undefined,
        })) ?? "";
    }
    if (!targetPath) return null;
    const canonical: Record<string, unknown> = {
      path: targetPath,
      old_string: norm.old_string,
      new_string: norm.new_string,
    };
    if (norm.replace_all !== undefined) canonical.replace_all = norm.replace_all;
    if (norm.line_hint !== undefined) canonical.line_hint = norm.line_hint;
    return JSON.stringify(canonical);
  }

  // batch_edit: accept `{ edits: [...] }`, top-level `{ path, edits: [...] }`,
  // bare `[...]` array, or single `{ path?, old_string, new_string }` object.
  let topLevelPath = "";
  let rawItems: unknown[];
  if (Array.isArray(parsed)) {
    rawItems = parsed;
  } else {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.path === "string" && obj.path.trim().length > 0) {
      topLevelPath = obj.path.trim();
    } else if (typeof obj.file_path === "string" && obj.file_path.trim().length > 0) {
      topLevelPath = obj.file_path.trim();
    } else if (typeof obj.file === "string" && obj.file.trim().length > 0) {
      topLevelPath = obj.file.trim();
    }
    if (Array.isArray(obj.edits)) {
      rawItems = obj.edits;
    } else if (
      typeof obj.old_string === "string" ||
      typeof obj.old_str === "string"
    ) {
      rawItems = [obj];
    } else {
      return null;
    }
  }
  if (rawItems.length === 0 || rawItems.length > 25) return null;

  const normalizedItems = rawItems.map((item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? normalizeEditFields(item as Record<string, unknown>)
      : null,
  );
  if (
    normalizedItems.some(
      (it) =>
        !it ||
        typeof it.old_string !== "string" ||
        typeof it.new_string !== "string",
    )
  ) {
    return null;
  }

  // Check if all explicit item paths in this batch agree on one single file
  // (helps stream-truncated tail entries in a single-file batch_edit).
  const explicitPaths = new Set(
    normalizedItems
      .map((it) => (typeof it?.path === "string" ? it.path : ""))
      .filter(Boolean),
  );
  const sharedSiblingPath =
    explicitPaths.size === 1 ? [...explicitPaths][0]! : "";

  const repairedEdits: Record<string, unknown>[] = [];
  for (const it of normalizedItems as Record<string, unknown>[]) {
    let itemPath = typeof it.path === "string" ? it.path : "";
    if (!itemPath && topLevelPath) {
      itemPath = topLevelPath;
    }
    if (!itemPath) {
      // If siblings in the same batch already agree on one file, disable
      // unrelated recency fallback so chained edits targeting text created by
      // an earlier edit in the same batch stay on `sharedSiblingPath`.
      itemPath =
        (await recoverEditTargetPathByContent(ctx, it.old_string as string, {
          replace_all: typeof it.replace_all === "boolean" ? it.replace_all : undefined,
          line_hint: typeof it.line_hint === "number" ? it.line_hint : undefined,
          allowRecencyFallback: !sharedSiblingPath,
        })) ?? sharedSiblingPath;
    }
    if (!itemPath) return null;
    const entry: Record<string, unknown> = {
      path: itemPath,
      old_string: it.old_string,
      new_string: it.new_string,
    };
    if (it.replace_all !== undefined) entry.replace_all = it.replace_all;
    if (it.line_hint !== undefined) entry.line_hint = it.line_hint;
    repairedEdits.push(entry);
  }

  return JSON.stringify({ edits: repairedEdits });
}

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
          const ph = punctHits(text, oldNorm);
          if (!ph) {
            return {
              ok: false,
              error: `old_string not found: ${JSON.stringify(oldNorm.slice(0, 80))}.${getDidYouMeanHint(text, oldNorm)}`,
              editIndex,
            };
          }
          if (ph.length > MAX_FUZZY_HITS) {
            return {
              ok: false,
              error: `old_string matched more than ${MAX_FUZZY_HITS} locations after punctuation relaxation — refusing to rewrite that broadly. Narrow old_string.`,
              editIndex,
            };
          }
          for (const h of [...ph].sort((a, b) => b.index - a.index)) {
            text =
              text.slice(0, h.index) +
              applyPunctCarry(oldNorm, newNorm, h) +
              text.slice(h.index + h.length);
          }
          totalReplacements += ph.length;
          continue;
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
          // Third tier: punctuation-equivalence (em/en dash vs hyphen,
          // curly vs straight quotes...). Same policy as the fuzzy tier —
          // multi-hit needs line_hint, else bounce with locations.
          const ph = punctHits(text, oldNorm);
          if (ph && ph.length === 1) {
            const h = ph[0]!;
            text =
              text.slice(0, h.index) +
              applyPunctCarry(oldNorm, newNorm, h) +
              text.slice(h.index + h.length);
            totalReplacements += 1;
            continue;
          }
          if (ph && ph.length > 1) {
            if (rawEdit.line_hint) {
              const chosenP = ph.reduce((best, cur) =>
                Math.abs(cur.line - rawEdit.line_hint!) <
                Math.abs(best.line - rawEdit.line_hint!)
                  ? cur
                  : best,
              );
              text =
                text.slice(0, chosenP.index) +
                applyPunctCarry(oldNorm, newNorm, chosenP) +
                text.slice(chosenP.index + chosenP.length);
              totalReplacements += 1;
              continue;
            }
            return {
              ok: false,
              error:
                `old_string matched ${ph.length} locations (lines ${ph
                  .slice(0, 8)
                  .map((h) => h.line)
                  .join(", ")}) only after punctuation relaxation — nothing was changed. Widen old_string or pass line_hint.`,
              editIndex,
            };
          }
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
 * vs spaces, collapsed runs, re-wrapped spacing, trailing drift, NBSP
 * paste artifacts). Build a regex from old_string where every whitespace
 * run becomes tolerant —
 * intra-line runs match [ \t\u00a0]* (the model may have eaten or added
 * the space), inter-line runs require the newline (\n) to exist but absorb
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
      // \u00a0 (NBSP) joins the tolerant run: it is the most common PASTE
      // artifact (web/Word/chat) and renders as a plain space in terminals
      // and read_file output, so an anchor differing from the file ONLY by
      // NBSP-vs-space is visually identical yet byte-different — the same
      // failure shape the punctuation tier was built for.
      pattern += part.includes("\n") ? "[\\s]*\\n[\\s]*" : "[ \\t\\u00a0]*";
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
  // Dots BEFORE dashes: flattenPunct canonicalizes per class in array
  // order, and the middle dot lives in BOTH clusters - dot-first keeps
  // the DIAGNOSIS (punctEquivalent) seeing the middle dot as a dot,
  // which is the likelier model guess. Matching is needle-side (member
  // -> union of its own classes), so this order never widens matching.
  ["\u00B7", "."], // middle dot vs period
  // Horizontal-bar cluster. Terminal output renders em-dash, en-dash,
  // minus sign, AND middle dot as the SAME ambiguous glyph, so an
  // anchor copied from tool output can carry any of them where the
  // file has another (three separate session failures traced to this).
  // ASCII "-" joins because it is the habitual model guess for a bar.
  ["\u2014", "\u2013", "\u2212", "\u00B7", "-"],
  ["\u201C", '\"'], // curly double quotes / straight
  ["\u201D", '\"'],
  ["\u2018", "'"], // curly single quotes / straight
  ["\u2019", "'"],
  ["\u2192", "->"], // arrow vs ASCII arrow
  // Left-right arrow (group default names use "a \u2194 b"); "<->"
  // is the ASCII guess a model types for the same glyph.
  ["\u2194", "<->"],
  // Ellipsis: \u2026 renders as an ambiguous dot-run in terminal
  // output; models habitually type "." or "..." for it. Canon is
  // the single dot (last member) so all three forms flatten equal.
  ["\u2026", "...", "."],
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

/**
 * Punctuation-tolerant find — the THIRD matching tier (after exact and
 * whitespace-fuzzy).
 *
 * Terminal output and OCR render em/en dashes as "-" and curly quotes as
 * straight ones, so an anchor copied FROM TERMINAL OUTPUT can be visually
 * identical to the file yet differ byte-wise. The fuzzy tier relaxes
 * WHITESPACE only, so these bounced with "not found" against a visually
 * identical block — the model retried the same anchor forever, and 3 such
 * bounces latched the file into the write_file-only escape hatch.
 * Diagnosing the near-miss (the not-found hint) was necessary but not
 * sufficient: the fix is to MATCH and APPLY.
 *
 * Matching: every punct-variant member in the needle becomes an ALTERNATION
 * over its whole equivalence class (multi-char members like "->" included,
 * longest-first so they win over their single-char neighbors). Whitespace
 * runs keep the fuzzy tier's tolerance. Each punct position is a CAPTURE
 * group, so the caller learns which variant the FILE uses at each position.
 *
 * Carry-over: applyPunctCarry rewrites new_string positions that repeat the
 * needle's punct variant to the FILE's variant — but ONLY under a strict
 * same-index + same-char guard, and only for single-char variants. The
 * guard makes corruption structurally impossible: it can never touch a
 * position the needle didn't mark as punctuation, and never rewrites an
 * identifier (the needle's char must be a punct variant at that exact
 * index, and the new char must equal it).
 */
type PunctHit = {
  index: number;
  length: number;
  line: number;
  /** The file's own text for the matched region (whole-line-extended). */
  carry: string;
  /** Per punct position: the variant the FILE uses (aligned with punctIdx). */
  captures: string[];
  /** Indices (into the TRIMMED needle) of the punct positions, in order. */
  punctIdx: number[];
};

/** member -> every variant it may represent (union across classes).
 *  A straight quote is a member of BOTH the open and close curly classes -
 *  a member->class map kept only the last one and the opening curly quote
 *  could never match its straight form. */
const PUNCT_MEMBER_VARIANTS = new Map<string, string[]>();
for (const cls of PUNCT_CLASSES) {
  for (const member of cls) {
    const seen = new Set<string>(PUNCT_MEMBER_VARIANTS.get(member) ?? []);
    for (const v of cls) seen.add(v);
    PUNCT_MEMBER_VARIANTS.set(member, [...seen]);
  }
}
const PUNCT_MEMBERS_LONGEST = [...PUNCT_MEMBER_VARIANTS.keys()].sort((a, b) => b.length - a.length);

function punctAlternation(cls: string[]): string {
  const sorted = [...cls].sort((a, b) => b.length - a.length);
  return "(" + sorted.map(escapeRe).join("|") + ")";
}

/**
 * Build the relaxed pattern for a needle. Returns the pattern source plus
 * the punct position bookkeeping. Multi-char members are consumed
 * greedily (longest first) so "a -> b" sees "->" as ONE punct position,
 * not "-" + ">".
 */
function buildPunctPattern(needle: string): {
  pattern: string;
  punctIdx: number[];
  anyPunct: boolean;
} {
  const trimmed = needle.replace(/^\s+|\s+$/g, "");
  const parts = trimmed.split(/(\s+)/);
  let pattern = "";
  const punctIdx: number[] = [];
  let anyPunct = false;
  let absIdx = 0; // index into trimmed
  for (const part of parts) {
    if (part === "") continue;
    if (/^\s+$/.test(part)) {
      pattern += part.includes("\n") ? "[\\s]*\\n[\\s]*" : "[ \\t\\u00a0]*";
      absIdx += part.length;
      continue;
    }
    let i = 0;
    while (i < part.length) {
      let matched = "";
      for (const member of PUNCT_MEMBERS_LONGEST) {
        if (part.startsWith(member, i)) {
          matched = member;
          break;
        }
      }
      if (matched && PUNCT_MEMBER_VARIANTS.has(matched)) {
        pattern += punctAlternation(PUNCT_MEMBER_VARIANTS.get(matched)!);
        punctIdx.push(absIdx);
        anyPunct = true;
        i += matched.length;
        absIdx += matched.length;
      } else {
        const ch = part[i]!;
        pattern += escapeRe(ch);
        i += 1;
        absIdx += 1;
      }
    }
  }
  return { pattern, punctIdx, anyPunct };
}

function punctHits(content: string, needle: string, maxHits = MAX_FUZZY_HITS): PunctHit[] | null {
  const { pattern, punctIdx, anyPunct } = buildPunctPattern(needle);
  if (!pattern || !anyPunct) return null; // no punct positions — tier inactive
  let re: RegExp;
  try {
    re = new RegExp(pattern, "g");
  } catch {
    return null;
  }
  const hits: PunctHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1; // pathological empty match guard
      continue;
    }
    let index = m.index;
    let end = m.index + m[0].length;
    // Same whole-line coverage extension as the fuzzy tier: a match that
    // spans a line's entire non-whitespace content owns the full line(s).
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
      line: content.slice(0, index).split("\n").length,
      carry: content.slice(index, end),
      captures: m.slice(1) as string[],
      punctIdx,
    });
    if (hits.length > maxHits) break;
  }
  return hits.length > 0 ? hits : null;
}

/**
 * Rewrite new_string's punct variants to the FILE's variants at positions
 * the needle marked. Strict guard per position i:
 *  - both variants single chars (length-changing classes like → vs -> are
 *    skipped: index alignment is not guaranteed there);
 *  - newTrimmed[i] === oldTrimmed[i] (the model repeated its own variant);
 *  - oldTrimmed[i] differs from the file's variant (a REAL variant diff).
 * Everything else passes through untouched. Worst case misfire: a hyphen
 * becomes an em-dash in prose — visually identical, self-healing on the
 * next edit, and never a code identifier.
 */
function applyPunctCarry(
  oldNorm: string,
  newNorm: string,
  hit: PunctHit,
): string {
  const oldTrimmed = oldNorm.replace(/^\s+|\s+$/g, "");
  const newTrimmed = newNorm.replace(/^\s+|\s+$/g, "");
  const lead = newNorm.slice(0, newNorm.indexOf(newTrimmed) === -1 ? 0 : newNorm.indexOf(newTrimmed));
  const out = newTrimmed.split("");
  for (let g = 0; g < hit.punctIdx.length; g++) {
    const i = hit.punctIdx[g]!;
    const fileVariant = hit.captures[g] ?? "";
    // Length guard, BOTH sides: resolve the needle's own member at
    // this punct index and require it to match the file variant's
    // length. The old check was file-side only, so a needle "->"
    // (one member, 2 chars) matching a file "\u2192" (1 char)
    // harmonized just the "-" to "\u2192" and left the ">" behind
    // - splicing "\u2192>" into new_string (same for "..." vs
    // "\u2026"). Multi-char matches still apply as a whole - only
    // the single-char HARMONIZATION is gated.
    let memberLen = 1;
    for (const member of PUNCT_MEMBERS_LONGEST) {
      if (oldTrimmed.startsWith(member, i)) {
        memberLen = member.length;
        break;
      }
    }
    if (fileVariant.length !== memberLen) continue;
    const needleChar = oldTrimmed[i] ?? "";
    if (needleChar === fileVariant) continue; // not a real variant diff
    if (i >= out.length) continue;
    if (out[i] === needleChar) out[i] = fileVariant; // model repeated its variant -> harmonize
  }
  return lead + out.join("");
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
    // Recovery guidance for the punct-tier escape hatch: since these
    // variants render identically in tool output, re-reading alone
    // does not always fix a repeat - the terminal renders the fresh
    // read's dashes/quotes as the same ambiguous glyph. The reliable
    // fix is to build old_string from the RAW read (copy the exact
    // bytes), or use replace_exact with byte-true anchors.
    return `${wsDiag}${punctuationDiag} Fix: re-read the file and cut the changed characters from the fresh read (terminal output renders these characters ambiguously), or fall back to replace_exact with byte-exact strings.`;
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

  // Delegate in-memory matching (exact -> fuzzy whitespace -> punctuation
  // equivalence, replace_all, line_hint, CRLF preservation) to the single
  // shared computeEdits engine.
  const computed = await computeEdits(original, abs, edits);
  if (!computed.ok) {
    return {
      ok: false,
      error: computed.error,
      path: abs,
      editIndex: computed.editIndex,
    };
  }

  const content = computed.content;
  const totalReplacements = computed.replacements;

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
        "Replace exact text in one existing file. Emit `path` first. Copy `old_string` verbatim from `read_file` (unique unless `replace_all` or `line_hint` is set). For multiple edits (to one file or several), use `batch_edit` instead of parallel `edit` calls.",
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe("Target file path (absolute or relative to cwd). Emit first."),
        old_string: z
          .string()
          .describe("Exact text to find (unique unless replace_all or line_hint)."),
        new_string: z.string().describe("Replacement text."),
        replace_all: z
          .boolean()
          .optional()
          .describe("Replace every occurrence."),
        line_hint: z
          .number()
          .optional()
          .describe("Approximate 1-based line number when old_string repeats."),
      }),
      needsApproval: true,
      execute: async ({ path: pathArg, old_string, new_string, replace_all, line_hint }) => {
        // PATH RECOVERY (defense-in-depth alongside repairEditToolCall):
        // infer missing `path` via content-verified cache lookup before
        // bouncing.
        let path = pathArg ?? "";
        let pathRecovered = false;
        if (!path) {
          const recovered = await recoverEditTargetPathByContent(
            ctx,
            old_string,
            { replace_all, line_hint },
          );
          if (recovered) {
            path = recovered;
            pathRecovered = true;
          }
        }
        if (!path)
          return {
            error:
              'path is required and could not be inferred - put `path` first in the arguments (before old_string/new_string), or read_file the target first.',
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
              `Re-read the file (force: true) and retry edit with anchors copied VERBATIM, or use replace_exact with byte-exact strings.`,
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
            return pathRecovered
              ? { ...result, note: `path field was missing from the call - applied to (${abs}). Always include path explicitly; if wrong, checkpoint_undo.` }
              : result;
          }
          // If old_string wasn't found, re-read the file (a prior concurrent
          // edit to the same file may have shifted content) and retry once.
          const retryable =
            result.error.startsWith("old_string not found");
          if (retryable) {
            // Force cache refresh so applyEdits re-reads from disk.
            ctx.readCache.delete(abs);
            const retry = await applyEdits(abs, edits, "edit", ctx.readCache, native);
            if (retry.ok) {
              getEditFailures(ctx).delete(abs);
              ctx.fileTracker.markModified(abs);
              await commitCheckpointBatch(checkpoint);
              return pathRecovered
                ? { ...retry, note: `path field was missing from the call - applied to (${abs}). Always include path explicitly; if wrong, checkpoint_undo.` }
                : retry;
            }
            // Retry also failed — count the strike so the 3-strike latch and
            // replace_exact recovery gate unlock properly.
            getEditFailures(ctx).set(abs, failures + 1);
            return {
              ...result,
              error:
                result.error +
                `\n\n(Attempt ${failures + 1}/${MAX_EDIT_RETRIES} failed on ${abs}. Re-read with force: true and copy old_string verbatim, use batch_edit for sequential same-file edits, or use replace_exact for raw byte quirks.)`,
            };
          }
          getEditFailures(ctx).set(abs, failures + 1);
          return result;
        });
      },
    }),

    checkpoint_undo: tool({
      description:
        "Revert the most recent file-mutation batch (`write_file`, `edit`, `batch_edit`, `replace_exact`) to its automatic pre-write snapshot.",
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