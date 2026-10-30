/**
 * The ONE multi-edit tool — applies edits across one or MANY files in a
 * single all-or-nothing batch. Consolidates the retired multi_edit (same
 * engine) into batch_edit's natural per-edit-path shape, which is what
 * models reach for by default; the old top-level-path multi_edit schema
 * was a shape trap that bounced every natural call.
 *
 * Per file it runs the hardened matcher from edit.ts (EOL normalize +
 * restore, Aider-style whitespace-tolerant fallback, replace_all,
 * line_hint, did-you-mean hints, no-op skipping) over in-memory content;
 * only after every edit in the batch computes cleanly does anything touch
 * disk. A write failure mid-phase rolls back the already-written files.
 *
 * Stale-read guard, read-before-edit, the 3-strike failure counter, plan
 * mode queueing, and checkpoint snapshots are all shared with edit.ts.
 *
 * Depends on checkpoint snapshots for rollback.
 */

import { tool } from "ai";
import { z } from "zod";
import { djb2, readCacheEntry } from "../lib/hash";
import { checkWritableCanonical } from "../lib/security";
import { nativeForContext, sandboxOverrideForContext, resolvePath, type ToolContext } from "./context";
import { createCheckpointBatch, snapshotFileForBatch, commitCheckpointBatch } from "../lib/checkpoints";
import { withFileMutationLock } from "../lib/mutationLock";
import {
  computeEdits,
  EDIT_MAX_RETRIES,
  ensureReadCache,
  getEditFailures,
} from "./edit";
import { newQueuedEditId, usePlanStore } from "../store/planStore";

type BatchEditResult =
  | { ok: true; files: number; replacements: number }
  | { ok: false; error: string; file?: string; changed?: boolean; failedEdit?: number };

export function buildBatchEditTools(ctx: ToolContext) {
  const native = nativeForContext(ctx);
  return {
    batch_edit: tool({
      description:
        "Apply edits to MULTIPLE files atomically — all edits succeed or all are rolled back. REQUIRED shape: {edits: [{path: \"src/app.ts\", old_string: \"...\", new_string: \"...\"}, ...]} — every edit carries its OWN path; use it for several files OR several changes to one file. Each old_string must match the current file exactly; widen it for uniqueness, or use replace_all / line_hint. If ANY edit fails, NOTHING is written and the error names the failing edit. Re-read the file and resubmit corrected edits instead of falling back to PowerShell or write_file. Asks for user approval — shows all diffs at once. Every write is auto-checkpointed — revert the whole batch with `checkpoint_undo`.",
      inputSchema: z.object({
        edits: z
          .array(
            z
              .object({
                path: z
                  .string()
                  .min(1)
                  .describe("The file to edit, absolute or relative to the terminal cwd."),
                old_string: z.string(),
                new_string: z.string(),
                replace_all: z.boolean().optional(),
                line_hint: z
                  .number()
                  .optional()
                  .describe("Approximate 1-based line number for a repeated old_string."),
              })
              .strict(),
          )
          .min(1)
          .max(25),
      }),
      needsApproval: true,
      execute: async ({ edits }): Promise<BatchEditResult> => {
        // Phase 1: resolve every path, validate writability, run the
        // read-before-edit guard per file. Abs paths collected for locking.
        const absPaths: string[] = [];
        const override = await sandboxOverrideForContext(ctx);
        for (const edit of edits) {
          const reqPath = resolvePath(edit.path, ctx.getCwd());
          const safety = await checkWritableCanonical(reqPath, native.canonicalize, override);
          if (!safety.ok) return { ok: false, error: safety.reason, file: reqPath };
          const guard = await ensureReadCache(safety.canonical, ctx, native);
          if (guard) return { ok: false, error: guard.error, file: reqPath };
          absPaths.push(safety.canonical);
        }

        // 3-strike escape hatch, shared counter with edit — a model that
        // keeps bouncing on the same file gets pointed to write_file.
        for (const abs of absPaths) {
          if ((getEditFailures(ctx).get(abs) ?? 0) >= EDIT_MAX_RETRIES) {
            return {
              ok: false,
              error: `edit tools failed ${EDIT_MAX_RETRIES} times on ${abs}. Use write_file to replace the entire file content instead.`,
              file: abs,
            };
          }
        }

        // STALE-READ GUARD (hash-only — size is disk bytes vs UTF-16 length,
        // they disagree on non-ASCII files; comparing size bounced every
        // self-write). The model authors old_strings against the content it
        // last READ; an external change means confusing not-found errors or
        // partial application against content it never saw.
        for (const abs of absPaths) {
          const cachedBefore = ctx.readCache.get(abs);
          if (!cachedBefore) continue;
          const r = await native.readFile(abs);
          if (r.kind === "text" && djb2(r.content) !== cachedBefore.hash) {
            for (const a of absPaths) getEditFailures(ctx).set(a, (getEditFailures(ctx).get(a) ?? 0) + 1);
            return {
              ok: false,
              error:
                "file changed since your last read — edited by something outside this session's write pipeline (another agent, a formatter, a process). Read it again with force: true and re-author the edits against the current content before submitting.",
              file: abs,
              changed: false,
            };
          }
        }

        return withFileMutationLock(absPaths, async () => {
          // Phase 2: snapshot originals (disk truth, before any write).
          const snapshots = new Map<string, string | null>();
          for (const abs of absPaths) {
            try {
              const r = await native.readFile(abs);
              if (r.kind === "binary") return { ok: false, error: `binary file: ${abs}`, file: abs };
              if (r.kind === "toolarge") return { ok: false, error: `file too large (${r.size} bytes): ${abs}`, file: abs };
              if (r.kind === "text") snapshots.set(abs, r.content);
            } catch {
              snapshots.set(abs, null); // will be created
            }
          }

          // Phase 3: compute all edits in memory. Edits are grouped per
          // FILE first so the engine's no-op semantics stay correct: ONE
          // computeEdits call per file handles all its edits in order (they
          // compound), and an identical old/new edit is skipped UNLESS the
          // whole group is no-ops. Calling per-edit here would misread a
          // lone no-op inside a batch as "everything is a no-op". The
          // hardened matcher (fuzzy fallback, replace_all, line_hint, EOL
          // restore) comes along for free. NOTHING has been written on any
          // failure path — no in-memory "rollback" that writes partial
          // content (the multi_edit corruption class).
          const groups = new Map<
            string,
            { edits: typeof edits; startIndex: number }
          >();
          for (let ei = 0; ei < edits.length; ei++) {
            const abs = absPaths[ei];
            const g = groups.get(abs);
            if (g) g.edits.push(edits[ei]);
            else groups.set(abs, { edits: [edits[ei]], startIndex: ei });
          }
          const computed = new Map<string, string>();
          let totalReplacements = 0;
          for (const [abs, group] of groups) {
            const current = snapshots.get(abs) ?? "";
            const r = await computeEdits(current, abs, group.edits);
            if (!r.ok) {
              for (const a of absPaths) getEditFailures(ctx).set(a, (getEditFailures(ctx).get(a) ?? 0) + 1);
              const failedIdx = group.startIndex + r.editIndex;
              return {
                ok: false,
                error: `${r.error}\n\nNo changes were written (failed edit #${failedIdx + 1} of ${edits.length}). Re-read the file and resubmit corrected edits; do not retry blindly.`,
                file: edits[failedIdx]?.path ?? abs,
                changed: false,
                failedEdit: failedIdx,
              };
            }
            computed.set(abs, r.content);
            totalReplacements += r.replacements;
          }

          // Plan mode: queue each affected file as one review entry.
          if (usePlanStore.getState().active) {
            for (const abs of computed.keys()) {
              usePlanStore.getState().enqueue({
                id: newQueuedEditId(),
                kind: "batch_edit",
                path: abs,
                originalContent: snapshots.get(abs) ?? "",
                proposedContent: computed.get(abs) ?? "",
                isNewFile: snapshots.get(abs) === null,
              });
            }
            return { ok: true, files: computed.size, replacements: totalReplacements };
          }

          // Phase 4: write everything. Checkpoint FIRST so a mid-phase
          // failure is recoverable; written files roll back on error.
          const checkpoint = createCheckpointBatch(
            ctx.getRealWorkspaceRoot?.() ?? ctx.getWorkspaceRoot() ?? "",
            ctx.getSessionId() ?? "",
            native,
          );
          const written: string[] = [];
          try {
            for (const [abs, newContent] of computed) {
              await snapshotFileForBatch(checkpoint, abs);
              await native.writeFile(abs, newContent);
              written.push(abs);
              ctx.readCache.set(abs, readCacheEntry(newContent));
              ctx.fileTracker.markModified(abs);
              window.dispatchEvent(new CustomEvent("Kai:fs-changed", { detail: abs }));
            }
            await commitCheckpointBatch(checkpoint);
          } catch (e) {
            for (const path of written) {
              const original = snapshots.get(path);
              try {
                if (original === null) await native.deleteFile(path);
                else if (original !== undefined) await native.writeFile(path, original);
              } catch {
                // best-effort rollback; the checkpoint still holds the truth
              }
            }
            return { ok: false, error: `write failed: ${String(e)}`, changed: false };
          }

          for (const abs of absPaths) getEditFailures(ctx).delete(abs);
          return { ok: true, files: computed.size, replacements: totalReplacements };
        });
      },
    }),
  } as const;
}
