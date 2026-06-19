import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { checkWritableCanonical } from "../lib/security";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import { resolvePath, type ToolContext } from "./context";

type EditResult =
  | { ok: true; replacements: number; bytesWritten: number; path: string }
  | { error: string; path: string };

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

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

/**
 * Strict eol-normalized find (no fuzzy whitespace). Used for uniqueness
 * checks so indentation variants aren't falsely flagged as duplicates.
 */
function eolAwareExactFind(
  haystack: string,
  needle: string,
  startFrom = 0,
): { start: number; length: number } | null {
  const hNorm = normEol(haystack);
  const nNorm = normEol(needle);
  const normIdx = hNorm.indexOf(nNorm, startFrom);
  if (normIdx === -1) return null;
  let origPos = 0;
  let normPos = 0;
  while (normPos < normIdx && origPos < haystack.length) {
    if (haystack[origPos] === "\r" && haystack[origPos + 1] === "\n") {
      origPos += 2;
      normPos += 1;
    } else {
      origPos++;
      normPos++;
    }
  }
  const origStart = origPos;
  let matchNormLen = nNorm.length;
  let origEnd = origStart;
  let consumed = 0;
  while (consumed < matchNormLen && origEnd < haystack.length) {
    if (haystack[origEnd] === "\r" && haystack[origEnd + 1] === "\n") {
      origEnd += 2;
      consumed += 1;
    } else {
      origEnd++;
      consumed++;
    }
  }
  return { start: origStart, length: origEnd - origStart };
}

/**
 * Find `needle` in `haystack` with line-ending-insensitive matching.
 * Returns { start, length } in the ORIGINAL haystack, or null.
 */
function eolAwareFind(
  haystack: string,
  needle: string,
  startFrom = 0,
): { start: number; length: number } | null {
  const hNorm = normEol(haystack);
  const nNorm = normEol(needle);

  // Try exact match on normalized form.
  let normIdx = hNorm.indexOf(nNorm, startFrom);
  if (normIdx === -1) {
    // Fuzzy fallback (whitespace normalization).
    normIdx = fuzzyFind(hNorm, nNorm);
  }
  if (normIdx === -1) return null;

  // Map the normalized index back to the original haystack.
  // Walk the original and normalized strings together to find the
  // corresponding position and length.
  let origPos = 0;
  let normPos = 0;
  while (normPos < normIdx && origPos < haystack.length) {
    if (haystack[origPos] === "\r" && haystack[origPos + 1] === "\n") {
      origPos += 2;
      normPos += 1;
    } else {
      origPos++;
      normPos++;
    }
  }
  const origStart = origPos;

  // Find end position for the match length.
  let matchNormLen = nNorm.length;
  let origEnd = origStart;
  let consumed = 0;
  while (consumed < matchNormLen && origEnd < haystack.length) {
    if (haystack[origEnd] === "\r" && haystack[origEnd + 1] === "\n") {
      origEnd += 2;
      consumed += 1;
    } else {
      origEnd++;
      consumed++;
    }
  }

  return { start: origStart, length: origEnd - origStart };
}

async function applyEdits(
  abs: string,
  edits: { old_string: string; new_string: string; replace_all?: boolean; line_hint?: number }[],
  kind: "edit" | "multi_edit",
  readCache: Map<string, { size: number; hash: number }>,
): Promise<EditResult> {
  const r = await native.readFile(abs);
  if (r.kind === "binary")
    return { error: "binary file refused", path: abs };
  if (r.kind === "toolarge")
    return { error: `file too large (${r.size} bytes)`, path: abs };

  const original = r.content;

  // Stale-write guard: update cache if file changed, but allow editing if old_string matches.
  const cached = readCache.get(abs);
  if (cached) {
    const freshHash = djb2(original);
    if (cached.hash !== freshHash || cached.size !== original.length) {
      readCache.set(abs, { size: original.length, hash: freshHash });
    }
  }

  // Detect line-ending style so new_string insertions match the file.
  const useCrlf = original.includes("\r\n");
  let content = original;
  let totalReplacements = 0;

  for (const rawEdit of edits) {
    // Normalize the model's strings to \n, then re-apply the file's
    // line-ending style to new_string so we don't introduce mixed endings.
    const oldNorm = normEol(rawEdit.old_string);
    // Strip trailing whitespace from new_string to prevent model-generated
    // trailing spaces from dirtying the file.
    const newNorm = stripTrailingWs(normEol(rawEdit.new_string), abs);
    const newForFile = useCrlf ? newNorm.replace(/\n/g, "\r\n") : newNorm;

    if (oldNorm === newNorm) {
      return {
        error: "old_string and new_string are identical",
        path: abs,
      };
    }
    if (oldNorm.length === 0) {
      return { error: "old_string cannot be empty", path: abs };
    }
    if (rawEdit.replace_all) {
      let n = 0;
      let searchFrom = 0;
      while (searchFrom < content.length) {
        const match = eolAwareFind(content, oldNorm, searchFrom);
        if (!match) break;
        content =
          content.slice(0, match.start) +
          newForFile +
          content.slice(match.start + match.length);
        searchFrom = match.start + newForFile.length;
        n++;
        if (n > 1000) break;
      }
      if (n === 0) {
        return {
          error: `old_string not found: ${JSON.stringify(oldNorm.slice(0, 80))}.${getDidYouMeanHint(content, oldNorm)}`,
          path: abs,
        };
      }
      totalReplacements += n;
    } else {
      const match = eolAwareFind(content, oldNorm);
      if (!match) {
        return {
          error: `old_string not found: ${JSON.stringify(oldNorm.slice(0, 80))}.${getDidYouMeanHint(content, oldNorm)}`,
          path: abs,
        };
      }
      // Check uniqueness: search for a second occurrence AFTER the first
      // match. Use exact eol-normalized matching only (not fuzzy whitespace)
      // so indentation variants aren't falsely flagged as duplicates.
      const exactSecond = eolAwareExactFind(content, oldNorm, match.start + match.length);
      if (exactSecond && !rawEdit.line_hint) {
        return {
          error:
            "old_string is not unique. Provide more surrounding context, set replace_all=true, or provide line_hint to disambiguate.",
          path: abs,
        };
      }
      // When line_hint is provided and there are multiple matches, pick
      // the occurrence closest to the hinted line number.
      let chosen = match;
      if (exactSecond && rawEdit.line_hint) {
        const candidates = [match, exactSecond];
        // Collect remaining occurrences (cap at 50 to avoid runaway)
        let more = exactSecond;
        for (let i = 0; i < 50; i++) {
          const next = eolAwareExactFind(content, oldNorm, more.start + more.length);
          if (!next) break;
          candidates.push(next);
          more = next;
        }
        // Pick the candidate whose start line is closest to line_hint
        chosen = candidates.reduce((best, c) => {
          const cLine = content.slice(0, c.start).split("\n").length;
          const bLine = content.slice(0, best.start).split("\n").length;
          return Math.abs(cLine - rawEdit.line_hint!) < Math.abs(bLine - rawEdit.line_hint!)
            ? c : best;
        });
      }
      content =
        content.slice(0, chosen.start) +
        newForFile +
        content.slice(chosen.start + chosen.length);
      totalReplacements += 1;
    }
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
    return { error: String(err), path: abs };
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
        "Replace an exact string in a file with a new string. BOTH old_string AND new_string are required — old_string is the text to find, new_string is what replaces it. To insert text, set old_string to an adjacent line and new_string to that line plus your insertion. Requires read_file on this path first. Asks for user approval. If old_string matches multiple locations, provide line_hint to disambiguate.",
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
        if (!ctx.readCache.has(abs)) {
          return {
            error:
              "must call read_file on this path first (read-before-edit invariant).",
            path: abs,
          };
        }
        const failures = editFailures.get(abs) ?? 0;
        if (failures >= MAX_EDIT_RETRIES) {
          editFailures.delete(abs);
          return {
            error: `edit failed ${MAX_EDIT_RETRIES} times on this file. Use write_file to replace the entire file content instead.`,
            path: abs,
          };
        }
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
        "Apply several exact-string replacements to a single file atomically. Each edit is applied in order to the running buffer; if any edit's old_string is missing or non-unique, the whole batch aborts before writing. Requires prior read_file on the path. Asks for user approval before writing.",
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
        if (!ctx.readCache.has(abs)) {
          return {
            error:
              "must call read_file on this path first (read-before-edit invariant).",
            path: abs,
          };
        }
        const failures = editFailures.get(abs) ?? 0;
        if (failures >= MAX_EDIT_RETRIES) {
          editFailures.delete(abs);
          return {
            error: `multi_edit failed ${MAX_EDIT_RETRIES} times on this file. Use write_file to replace the entire file content instead.`,
            path: abs,
          };
        }
        const result = await applyEdits(abs, edits, "multi_edit", ctx.readCache);
        if ("error" in result) {
          editFailures.set(abs, failures + 1);
        } else {
          editFailures.delete(abs);
          ctx.fileTracker.markModified(abs);
        }
        return result;
      },
    }),
  } as const;
}
