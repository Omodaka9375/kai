import { tool } from "ai";
import { z } from "zod";
import { djb2 } from "../lib/hash";
import { native } from "../lib/native";
import { checkReadableCanonical, checkWritableCanonical } from "../lib/security";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import { resolvePath, type ToolContext } from "./context";
import { snapshotFile } from "../lib/checkpoints";

type EditResult =
  | { ok: true; replacements: number; bytesWritten: number; path: string }
  | { ok: false; error: string; path: string };

/** Strip trailing whitespace from each line, preserving line endings.
 *  Exempt .md/.mdx where trailing spaces are meaningful (hard line breaks). */
function stripTrailingWs(s: string, filePath: string): string {
  if (/\.(md|mdx)$/i.test(filePath)) return s;
  return s.replace(/[^\S\n\r]+$/gm, "");
}

/**
 * Fuzzy-find `needle` in `haystack` by progressively relaxing whitespace
 * matching. Returns the start index in the original haystack, or -1.
 */
function fuzzyFind(haystack: string, needle: string): number {
  // Level 1: trim trailing whitespace per line.
  const trimEnd = (s: string) => s.split("\n").map((l) => l.trimEnd()).join("\n");
  const h1 = trimEnd(haystack);
  const n1 = trimEnd(needle);
  const i1 = h1.indexOf(n1);
  if (i1 !== -1) return mapFuzzyIndex(haystack, h1, i1, n1);

  // Level 2: normalize all leading whitespace to consistent spaces
  // (tabs → 2 spaces), then trim trailing.
  const normIndent = (s: string) =>
    s.split("\n").map((l) => l.replace(/\t/g, "  ").trimEnd()).join("\n");
  const h2 = normIndent(haystack);
  const n2 = normIndent(needle);
  const i2 = h2.indexOf(n2);
  if (i2 !== -1) return mapFuzzyIndex(haystack, h2, i2, n2);

  // Level 3: collapse all runs of whitespace to single space, per line.
  const collapseWs = (s: string) =>
    s.split("\n").map((l) => l.trim().replace(/\s+/g, " ")).join("\n");
  const h3 = collapseWs(haystack);
  const n3 = collapseWs(needle);
  const i3 = h3.indexOf(n3);
  if (i3 !== -1) return mapFuzzyIndex(haystack, h3, i3, n3);

  return -1;
}

/** Map a position from a normalized string back to the original by line count. */
function mapFuzzyIndex(
  original: string,
  normalized: string,
  normIndex: number,
  normNeedle: string,
): number {
  const linesBefore = normalized.slice(0, normIndex).split("\n").length - 1;
  const matchLines = normNeedle.split("\n").length;
  const origLines = original.split("\n");
  const matchedOriginal = origLines.slice(linesBefore, linesBefore + matchLines).join("\n");
  const lineStart = origLines.slice(0, linesBefore).join("\n").length + (linesBefore > 0 ? 1 : 0);
  const idx = original.indexOf(matchedOriginal, lineStart > 0 ? lineStart : 0);
  return idx >= 0 ? idx : -1;
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
): Promise<EditResult> {
  const r = await native.readFile(abs);
  if (r.kind === "binary")
    return { ok: false, error: "binary file refused", path: abs };
  if (r.kind === "toolarge")
    return { ok: false, error: `file too large (${r.size} bytes)`, path: abs };

  const original = r.content;

  // Stale-write guard: update cache if file changed, but allow editing if old_string matches.
  const cached = readCache.get(abs);
  if (cached) {
    const freshHash = djb2(original);
    if (cached.hash !== freshHash || cached.size !== original.length) {
      readCache.set(abs, { size: original.length, hash: freshHash });
    }
  }

  // Normalize the entire file content to \n before applying edits, then
  // restore the original line-ending style at the end. This avoids
  // positional drift that occurs when mapping CRLF↔LF per edit in
  // sequential multi_edit calls — each edit's position shift compounds.
  const useCrlf = original.includes("\r\n");
  let content = normEol(original);
  let totalReplacements = 0;

  for (const rawEdit of edits) {
    const oldNorm = normEol(rawEdit.old_string);
    // Strip trailing whitespace from new_string to prevent model-generated
    // trailing spaces from dirtying the file.
    const newNorm = stripTrailingWs(normEol(rawEdit.new_string), abs);

    if (oldNorm === newNorm) {
      return {
        ok: false,
        error: "old_string and new_string are identical",
        path: abs,
      };
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
        return {
          ok: false,
          error: `old_string not found: ${JSON.stringify(oldNorm.slice(0, 80))}.${getDidYouMeanHint(content, oldNorm)}`,
          path: abs,
        };
      }
      totalReplacements += n;
    } else {
      let idx = content.indexOf(oldNorm);
      if (idx === -1) {
        idx = fuzzyFind(content, oldNorm);
      }
      if (idx === -1) {
        return {
          ok: false,
          error: `old_string not found: ${JSON.stringify(oldNorm.slice(0, 80))}.${getDidYouMeanHint(content, oldNorm)}`,
          path: abs,
        };
      }
      // Check uniqueness: search for a second occurrence AFTER the first
      // match. Use exact matching only (not fuzzy whitespace) so indentation
      // variants aren't falsely flagged as duplicates.
      const secondIdx = content.indexOf(oldNorm, idx + oldNorm.length);
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
        content.slice(chosenIdx + oldNorm.length);
      totalReplacements += 1;
    }
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
    await native.writeFile(abs, content);
    readCache.set(abs, { size: content.length, hash: djb2(content) });
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
): Promise<{ error: string; path: string } | null> {
  if (ctx.readCache.has(abs)) return null;
  const safety = await checkReadableCanonical(abs, native.canonicalize);
  if (!safety.ok) return { error: safety.reason, path: abs };
  try {
    const r = await native.readFile(safety.canonical);
    if (r.kind === "binary") return { error: "binary file refused", path: abs };
    if (r.kind === "toolarge")
      return { error: `file too large (${r.size} bytes)`, path: abs };
    ctx.readCache.set(abs, { size: r.size, hash: djb2(r.content) });
    ctx.fileTracker.markRead(abs);
    return null;
  } catch (e) {
    return {
      error: `cannot edit "${abs}": read failed (${String(e)}). If the file does not exist yet, use write_file to create it.`,
      path: abs,
    };
  }
}

/** Per-path edit failure counter. Resets on success or session switch. */
const editFailures = new Map<string, number>();
const MAX_EDIT_RETRIES = 3;

/** Clear the edit failure counter — call on session switch/delete. */
export function resetEditFailures(): void {
  editFailures.clear();
}

export function buildEditTools(ctx: ToolContext) {
  return {
    edit: tool({
      description:
        "Replace text in an existing file. HOW IT WORKS: the tool searches the file for old_string and swaps it for new_string. RULES: (1) old_string must be copied EXACTLY from the file — every character, space, and indent; never invent or paraphrase it. (2) To INSERT without deleting, set old_string to the line before/after the spot and repeat that line inside new_string with your addition. (3) If old_string appears more than once, either widen it with surrounding lines to make it unique, or pass line_hint. (4) To create a NEW file use write_file instead. Asks for user approval.",
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
        if (!path) return { error: "path is required" };
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkWritableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        const guard = await ensureReadCache(abs, ctx);
        if (guard) return guard;
        const failures = editFailures.get(abs) ?? 0;
        if (failures >= MAX_EDIT_RETRIES) {
          editFailures.delete(abs);
          return {
            error: `edit failed ${MAX_EDIT_RETRIES} times on this file. Use write_file to replace the entire file content instead.`,
            path: abs,
          };
        }
        // Snapshot before mutation for checkpoint undo.
        await snapshotFile(abs);
        const result = await applyEdits(
          abs,
          [{ old_string, new_string, replace_all, line_hint }],
          "edit",
          ctx.readCache,
        );
        if ("error" in result) {
          editFailures.set(abs, failures + 1);
        } else {
          editFailures.delete(abs);
          ctx.fileTracker.markModified(abs);
        }
        return result;
      },
    }),

    multi_edit: tool({
      description:
        "Apply several replacements to ONE file in a single call. Same exact-match rules as edit: every old_string must be copied verbatim from the file. Edits apply in order to the running buffer; if any old_string is missing or non-unique, NOTHING is written (all-or-nothing). Prefer this over repeated edit calls when changing several spots in the same file. Asks for user approval.",
      inputSchema: z.object({
        path: z.string().optional(),
        edits: z
          .array(
            z.object({
              old_string: z.string(),
              new_string: z.string(),
              replace_all: z.boolean().optional(),
              path: z.string().optional(),
            }),
          )
          .min(1),
      }),
      needsApproval: true,
      execute: async ({ path: pathArg, edits }) => {
        // Some models put `path` inside each edit instead of at the top level.
        const path = pathArg ?? edits[0]?.path ?? "";
        if (!path) return { error: "path is required" };
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkWritableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        const guard = await ensureReadCache(abs, ctx);
        if (guard) return guard;
        const failures = editFailures.get(abs) ?? 0;
        if (failures >= MAX_EDIT_RETRIES) {
          editFailures.delete(abs);
          return {
            error: `multi_edit failed ${MAX_EDIT_RETRIES} times on this file. Use write_file to replace the entire file content instead.`,
            path: abs,
          };
        }
        const result = await applyEdits(
          abs,
          edits,
          "multi_edit",
          ctx.readCache,
        );
        if ("error" in result) {
          editFailures.set(abs, failures + 1);
        } else {
          editFailures.delete(abs);
          ctx.fileTracker.markModified(abs);
        }
        return result;
      },
    }),

    checkpoint_undo: tool({
      description:
        "Restore files from the last AI edit checkpoint. Reverts the most recent batch of write_file/edit/multi_edit operations. Use this to undo AI changes when the result isn't what you expected. Auto-executes (no approval needed — user must explicitly invoke this tool).",
      inputSchema: z.object({}),
      execute: async () => {
        const root = ctx.getWorkspaceRoot();
        if (!root) return { error: "no workspace root — cannot find checkpoints" };
        const { listCheckpoints, restoreCheckpoint } = await import("../lib/checkpoints");
        const records = await listCheckpoints(root);
        if (records.length === 0) {
          return { message: "no checkpoints found — nothing to undo" };
        }
        const last = records[records.length - 1];
        const result = await restoreCheckpoint(last);
        // Delete the checkpoint file after successful restore.
        try {
          const ckDir = `${root.replace(/\\/g, "/").replace(/\/$/, "")}/.kai/checkpoints`;
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
          errors: result.errors.length > 0 ? result.errors : undefined,
          checkpoint_age_seconds: Math.round((Date.now() - last.timestamp) / 1000),
        };
      },
    }),
  } as const;
}
