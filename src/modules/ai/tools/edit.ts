import { tool } from "ai";
import { z } from "zod";
import { djb2, readCacheEntry } from "../lib/hash";
import { native } from "../lib/native";
import { checkReadableCanonical, checkWritableCanonical } from "../lib/security";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import { nativeForContext, sandboxOverrideForContext, resolvePath, type ToolContext } from "./context";
import { createCheckpointBatch, snapshotFileForBatch, commitCheckpointBatch } from "../lib/checkpoints";
import { withFileMutationLock } from "../lib/mutationLock";

type EditResult =
  | { ok: true; replacements: number; bytesWritten: number; path: string }
  | { ok: false; error: string; path: string };

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
    return `${wsDiag} Read the file again to get the exact content and indentation.`;
  }

  matches.sort((a, b) => b.score - a.score);
  const best = matches.slice(0, 3);
  return `${wsDiag} Similar lines in file:\n${best.map((m) => `  L${m.lineNum}: ${JSON.stringify(m.content.trimEnd())}`).join("\n")}`;
}

async function applyEdits(
  abs: string,
  edits: { old_string: string; new_string: string; replace_all?: boolean; line_hint?: number }[],
  kind: "edit" | "multi_edit",
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
  // sequential multi_edit calls — each edit's position shift compounds.
  const useCrlf = original.includes("\r\n");
  let content = normEol(original);
  let totalReplacements = 0;
  let skippedIdentical = 0;

  for (const rawEdit of edits) {
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
      return { ok: false, error: "old_string cannot be empty", path: abs };
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
          };
        }
        if (fz.length > MAX_FUZZY_HITS) {
          return {
            ok: false,
            error: `old_string matched more than ${MAX_FUZZY_HITS} locations after whitespace relaxation — refusing to rewrite that broadly. Narrow old_string.`,
            path: abs,
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
 */
async function ensureReadCache(
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
 *  Scoped per ToolContext so cross-session counters don't interfere. */
const editFailures = new WeakMap<ToolContext, Map<string, number>>();
const MAX_EDIT_RETRIES = 3;

function getEditFailures(ctx: ToolContext): Map<string, number> {
  let map = editFailures.get(ctx);
  if (!map) {
    map = new Map();
    editFailures.set(ctx, map);
  }
  return map;
}

export function buildEditTools(ctx: ToolContext) {
  const native = nativeForContext(ctx);
  return {
    edit: tool({
      description:
        "Replace text in an existing file. HOW IT WORKS: the tool searches the file for old_string and swaps it for new_string. RULES: (1) old_string must be copied EXACTLY from the file — every character, space, and indent; never invent or paraphrase it. (2) To INSERT without deleting, set old_string to the line before/after the spot and repeat that line inside new_string with your addition. (3) If old_string appears more than once, either widen it with surrounding lines to make it unique, or pass line_hint. (4) To create a NEW file use write_file instead. (5) If you need multiple changes to the SAME file, use multi_edit — it applies edits sequentially inside one atomic write. Never emit separate edit calls for the same file in one step (they race each other). Asks for user approval. The prior content is auto-checkpointed — revert a bad edit with `checkpoint_undo`.",
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
            error: `edit failed ${MAX_EDIT_RETRIES} times on this file. Use write_file to replace the entire file content instead.`,
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
                "\n\n(Still not found after re-read. This usually means another edit to the same file already consumed or displaced the target text. Re-read the file to get the current content, then resubmit. Better: use multi_edit for all same-file changes — it runs edits sequentially in one atomic operation instead of racing.)",
            };
          }
          getEditFailures(ctx).set(abs, failures + 1);
          return result;
        });
      },
    }),

    multi_edit: tool({
      description:
        "Apply several replacements to ONE file in a single atomic call. The file path goes in the TOP-LEVEL `path` field — do NOT put a `path` inside each edit object (an edit-level path is tolerated as a fallback but the top-level field is the contract). `line_hint` per edit is accepted and used to disambiguate repeated old_strings; never omit an edit because you fear it. Same exact-match rules as edit: every old_string must be copied verbatim from the file's current content. Edits apply in order; an edit that fails to match is reported individually and the rest still land. Prefer this over repeated edit calls when changing several spots in the same file. Asks for user approval. The prior content is auto-checkpointed — revert a bad batch with `checkpoint_undo`.",
      inputSchema: z.object({
        path: z.string().optional(),
        edits: z
          .array(
            z.object({
              old_string: z.string(),
              new_string: z.string(),
              replace_all: z.boolean().optional(),
              line_hint: z
                .number()
                .optional()
                .describe("Approximate 1-based line number where the edit should apply. Used to disambiguate when old_string appears more than once."),
              path: z.string().optional(),
            }),
          )
          .min(1),
      }),
      needsApproval: true,
      execute: async ({ path: pathArg, edits }) => {
        // Some models put `path` inside each edit instead of at the top level.
        const path = pathArg ?? edits[0]?.path ?? "";
        if (!path)
          return {
            error:
              'path is required — multi_edit applies edits to ONE file; set the top-level "path" field to it (a per-edit "path" is also accepted). Example: {"path":"src/app.ts","edits":[{"old_string":"...","new_string":"..."}]}',
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
            error: `multi_edit failed ${MAX_EDIT_RETRIES} times on this file. Use write_file to replace the entire file content instead.`,
            path: abs,
          };
        }
        // STALE-READ GUARD: the model authors all old_strings against the
        // content it last READ. If anything changed the file since (another
        // agent edit, a background process, a formatter), the batch would
        // fail with confusing not-found errors — or worse, partially apply
        // against content the model never saw. Compare the cached read hash
        // against disk up front and bounce with one clear instruction.
        // HASH ONLY: size is disk bytes here but UTF-16 length in the cache
        // (they disagree on any non-ASCII file), so comparing it produced a
        // false "file changed" bounce after every one of this tool's own
        // writes — the loop that made models abandon multi_edit for edit.
        // The bounce is COUNTED so a model that resubmits regardless hits
        // the escape hatch above instead of looping forever.
        const cachedBefore = ctx.readCache.get(abs);
        if (cachedBefore) {
          const r = await native.readFile(abs);
          if (r.kind === "text" && djb2(r.content) !== cachedBefore.hash) {
            getEditFailures(ctx).set(abs, failures + 1);
            return {
              error:
                "file changed since your last read — edited by something outside this session's write pipeline (another agent, a formatter, a process). Read it again with force: true and re-author the edits against the current content before submitting.",
              path: abs,
            };
          }
        }
        return withFileMutationLock([abs], async () => {
          const checkpoint = createCheckpointBatch(
            ctx.getRealWorkspaceRoot?.() ?? ctx.getWorkspaceRoot() ?? "",
            ctx.getSessionId() ?? "",
            native,
          );
          await snapshotFileForBatch(checkpoint, abs);
          // Try batch first — fast path when all old_strings match.
          let result = await applyEdits(
            abs,
            edits,
            "multi_edit",
            ctx.readCache,
            native,
          );
          // Retry once if old_string wasn't found (concurrent same-file edit
          // shifted content). Re-read from disk fresh.
          if (
            "error" in result &&
            result.error.startsWith("old_string not found")
          ) {
            ctx.readCache.delete(abs);
            result = await applyEdits(
              abs,
              edits,
              "multi_edit",
              ctx.readCache,
              native,
            );
          }
          if (result.ok) {
            getEditFailures(ctx).delete(abs);
            ctx.fileTracker.markModified(abs);
            await commitCheckpointBatch(checkpoint);
            return result;
          }
          // Batch failed — retry each edit individually so correct edits
          // still land and only the mismatched ones are reported.
          const succeeded: Array<{
            old_string: string;
            replacements: number;
          }> = [];
          const failed: Array<{
            old_string: string;
            error: string;
          }> = [];
          for (let i = 0; i < edits.length; i++) {
            const e = edits[i];
            const r = await applyEdits(
              abs,
              [e],
              "edit",
              ctx.readCache,
              native,
            );
            if ("ok" in r && r.ok) {
              succeeded.push({
                old_string: e.old_string.slice(0, 80),
                replacements: (r as Extract<EditResult, { ok: true }>).replacements,
              });
            } else {
              const err = r as Extract<EditResult, { ok: false }>;
              failed.push({
                old_string: e.old_string.slice(0, 80),
                error: err.error,
              });
            }
          }
          if (succeeded.length === 0) {
            getEditFailures(ctx).set(abs, failures + 1);
            return {
              ok: false,
              error:
                `All ${edits.length} edits failed. ` +
                (failed.length === 1
                  ? `Reason: ${failed[0].error}`
                  : `First failure: ${failed[0].error}`),
              path: abs,
              applied: 0,
              failed: edits.length,
            } as EditResult;
          }
          // Partial success — reset failure counter, mark file modified.
          // Commit anyway: the edits that DID land still need an undo point,
          // and leaving the batch pending would fold these files into the
          // NEXT tool call's checkpoint instead.
          getEditFailures(ctx).delete(abs);
          ctx.fileTracker.markModified(abs);
          await commitCheckpointBatch(checkpoint);
          return {
            ok: true as const,
            replacements: succeeded.reduce((sum, s) => sum + s.replacements, 0),
            bytesWritten: 0,
            path: abs,
            applied: succeeded.length,
            failed: failed.length,
            failures: failed.map((f) => f.error),
            note:
              failed.length > 0
                ? `${succeeded.length} of ${edits.length} edits applied. The remaining ${failed.length} must be redone with corrected old_string values.`
                : undefined,
          };
        });
      },
    }),

    checkpoint_undo: tool({
      description:
        "Revert the last AI-write batch (write_file / edit / multi_edit / batch_edit) to its pre-write snapshot — every one of those tools auto-checkpoints before mutating, so this is always available after a write. Call it when an edit produced an unexpected result, when the user says 'undo that' / 'revert', or when you need to abandon a partial change set and retry a different approach. Takes no arguments; reverts the most recent batch only.",
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