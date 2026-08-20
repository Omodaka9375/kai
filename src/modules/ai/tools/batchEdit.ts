/**
 * Multi-file atomic edit tool — applies edits across multiple files in a single
 * all-or-nothing batch. If any edit fails, all changes are rolled back.
 *
 * Depends on checkpoint snapshots for rollback.
 */

import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { checkWritableCanonical } from "../lib/security";
import { resolvePath, type ToolContext } from "./context";
import { snapshotFile } from "../lib/checkpoints";
import { djb2 } from "../lib/hash";

/** Normalize line endings to \n for comparison purposes only. */
function normEol(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/** Strip trailing whitespace from each line, preserving line endings. */
function stripTrailingWs(s: string, filePath: string): string {
  if (/\.(md|mdx)$/i.test(filePath)) return s;
  return s.replace(/[^\S\n\r]+$/gm, "");
}

type BatchEditResult =
  | { ok: true; files: number; replacements: number }
  | { ok: false; error: string; file?: string };

export function buildBatchEditTools(ctx: ToolContext) {
  return {
    batch_edit: tool({
      description:
        "Apply edits to MULTIPLE files atomically. All edits succeed or all are rolled back. Each edit entry has { path, old_string, new_string }. Use this instead of multiple separate edit calls when changes span several files (e.g. renaming a function across its definition, call sites, and tests). Asks for user approval — shows all diffs at once.",
      inputSchema: z.object({
        edits: z
          .array(
            z.object({
              path: z.string(),
              old_string: z.string(),
              new_string: z.string(),
            }),
          )
          .min(1)
          .max(10),
      }),
      needsApproval: true,
      execute: async ({ edits }): Promise<BatchEditResult> => {
        const snapshots: Map<string, string | null> = new Map();
        const results: { path: string; newContent: string }[] = [];

        // Phase 1: validate all paths and snapshot originals.
        for (const edit of edits) {
          const reqPath = resolvePath(edit.path, ctx.getCwd());
          const safety = await checkWritableCanonical(reqPath, native.canonicalize);
          if (!safety.ok) return { ok: false, error: safety.reason, file: reqPath };
          const abs = safety.canonical;

          // Snapshot original content for potential rollback.
          try {
            const r = await native.readFile(abs);
            if (r.kind === "text") {
              snapshots.set(abs, r.content);
            } else if (r.kind === "binary") {
              return { ok: false, error: `binary file: ${abs}`, file: reqPath };
            }
          } catch {
            // File doesn't exist — will be created.
            snapshots.set(abs, null);
          }
        }

        // Phase 2: apply all edits in memory first.
        for (const edit of edits) {
          const reqPath = resolvePath(edit.path, ctx.getCwd());
          const safety = await checkWritableCanonical(reqPath, native.canonicalize);
          if (!safety.ok) {
            await rollback(snapshots);
            return { ok: false, error: safety.reason, file: reqPath };
          }
          const abs = safety.canonical;

          let current = snapshots.get(abs) ?? "";
          if (current === null) current = "";

          // Normalize line endings to LF for matching, same as edit.ts.
          const useCrlf = current.includes("\r\n");
          const currentNorm = normEol(current);
          const oldNorm = normEol(edit.old_string);
          const newNorm = stripTrailingWs(normEol(edit.new_string), abs);

          if (oldNorm === newNorm) {
            await rollback(snapshots);
            return {
              ok: false,
              error: `old_string and new_string are identical in "${abs}"`,
              file: reqPath,
            };
          }

          const idx = currentNorm.indexOf(oldNorm);
          if (idx === -1) {
            await rollback(snapshots);
            return {
              ok: false,
              error: `old_string not found in "${abs}": ${JSON.stringify(oldNorm.slice(0, 80))}`,
              file: reqPath,
            };
          }
          // Check uniqueness.
          const secondIdx = currentNorm.indexOf(oldNorm, idx + 1);
          if (secondIdx !== -1) {
            await rollback(snapshots);
            return {
              ok: false,
              error: `old_string is not unique in "${abs}". Provide more surrounding context.`,
              file: reqPath,
            };
          }

          // Work entirely in LF-normalized space (idx is relative to currentNorm,
          // not current). Then restore original line-ending style.
          let newContentNorm =
            currentNorm.slice(0, idx) +
            newNorm +
            currentNorm.slice(idx + oldNorm.length);
          let newContent = useCrlf
            ? newContentNorm.replace(/\n/g, "\r\n")
            : newContentNorm;
          results.push({ path: abs, newContent });
          // Update in-memory snapshot for subsequent edits on same file.
          snapshots.set(abs, newContent);
        }

        // Phase 3: write all results to disk.
        const written: string[] = [];
        let totalReplacements = 0;
        try {
          for (const { path, newContent } of results) {
            // Snapshot before write for checkpoint undo.
            await snapshotFile(path);
            await native.writeFile(path, newContent);
            written.push(path);
            totalReplacements += 1;
            ctx.readCache.set(path, {
              size: newContent.length,
              hash: djb2(newContent),
            });
            ctx.fileTracker.markModified(path);
            window.dispatchEvent(new CustomEvent("Kai:fs-changed", { detail: path }));
          }
        } catch (e) {
          // Roll back written files on failure.
          for (const path of written) {
            const original = snapshots.get(path);
            try {
              if (original === null) {
                await native.deleteFile(path);
              } else if (original !== undefined) {
                await native.writeFile(path, original);
              }
            } catch {
              // Best-effort rollback.
            }
          }
          return { ok: false, error: `write failed: ${String(e)}` };
        }

        return { ok: true, files: written.length, replacements: totalReplacements };
      },
    }),
  } as const;
}

async function rollback(snapshots: Map<string, string | null>): Promise<void> {
  for (const [path, content] of snapshots) {
    try {
      if (content === null) {
        await native.deleteFile(path);
      } else {
        await native.writeFile(path, content);
      }
    } catch {
      // Best-effort rollback.
    }
  }
}