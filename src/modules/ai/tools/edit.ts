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
  edits: { old_string: string; new_string: string; replace_all?: boolean }[],
  kind: "edit" | "multi_edit",
  readCache: Map<string, { size: number; hash: number }>,
): Promise<EditResult> {
  const r = await native.readFile(abs);
  if (r.kind === "binary")
    return { error: "binary file refused", path: abs };
  if (r.kind === "toolarge")
    return { error: `file too large (${r.size} bytes)`, path: abs };

  const original = r.content;
  // Detect line-ending style so new_string insertions match the file.
  const useCrlf = original.includes("\r\n");
  let content = original;
  let totalReplacements = 0;

  for (const rawEdit of edits) {
    // Normalize the model's strings to \n, then re-apply the file's
    // line-ending style to new_string so we don't introduce mixed endings.
    const oldNorm = normEol(rawEdit.old_string);
    const newNorm = normEol(rawEdit.new_string);
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
          error: `old_string not found: ${JSON.stringify(oldNorm.slice(0, 80))}`,
          path: abs,
        };
      }
      totalReplacements += n;
    } else {
      const match = eolAwareFind(content, oldNorm);
      if (!match) {
        return {
          error: `old_string not found: ${JSON.stringify(oldNorm.slice(0, 80))}`,
          path: abs,
        };
      }
      // Check uniqueness: search for a second occurrence AFTER the first
      // match. Use exact eol-normalized matching only (not fuzzy whitespace)
      // so indentation variants aren't falsely flagged as duplicates.
      const exactSecond = eolAwareExactFind(content, oldNorm, match.start + match.length);
      if (exactSecond) {
        return {
          error:
            "old_string is not unique. Provide more surrounding context, or set replace_all=true.",
          path: abs,
        };
      }
      content =
        content.slice(0, match.start) +
        newForFile +
        content.slice(match.start + match.length);
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

/** Per-path edit failure counter. Resets on success. */
const editFailures = new Map<string, number>();
const MAX_EDIT_RETRIES = 3;

export function buildEditTools(ctx: ToolContext) {
  return {
    edit: tool({
      description:
        "Replace an exact string in a file. Requires read_file on this path first in the current session — this prevents blind edits. `old_string` must be unique in the file unless `replace_all: true`. Asks for user approval before writing.",
      inputSchema: z.object({
        path: z.string(),
        old_string: z
          .string()
          .describe("Exact substring to replace. Must be unique unless replace_all."),
        new_string: z.string().describe("Replacement substring."),
        replace_all: z.boolean().optional(),
      }),
      needsApproval: true,
      execute: async ({ path, old_string, new_string, replace_all }) => {
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
          [{ old_string, new_string, replace_all }],
          "edit",
          ctx.readCache,
        );
        if ("error" in result) {
          editFailures.set(abs, failures + 1);
        } else {
          editFailures.delete(abs);
        }
        return result;
      },
    }),

    multi_edit: tool({
      description:
        "Apply several exact-string replacements to a single file atomically. Each edit is applied in order to the running buffer; if any edit's old_string is missing or non-unique, the whole batch aborts before writing. Requires prior read_file on the path. Asks for user approval before writing.",
      inputSchema: z.object({
        path: z.string(),
        edits: z
          .array(
            z.object({
              old_string: z.string(),
              new_string: z.string(),
              replace_all: z.boolean().optional(),
            }),
          )
          .min(1),
      }),
      needsApproval: true,
      execute: async ({ path, edits }) => {
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
        }
        return result;
      },
    }),
  } as const;
}
