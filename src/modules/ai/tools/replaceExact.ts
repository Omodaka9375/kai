/**
 * Recovery-only byte-exact replacement. `edit` / `batch_edit` remain the
 * normal editing tools; this bypasses their relaxed matcher ONLY after they
 * have failed or their failure latch is active. The actual match + write
 * happens in Rust on raw bytes so EOLs, BOM, whitespace and EOF are preserved.
 */

import { tool } from "ai";
import { z } from "zod";
import { readCacheEntry } from "../lib/hash";
import { checkWritableCanonical } from "../lib/security";
import {
  createCheckpointBatch,
  snapshotFileForBatch,
  commitCheckpointBatch,
} from "../lib/checkpoints";
import { withFileMutationLock } from "../lib/mutationLock";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import {
  nativeForContext,
  resolvePath,
  sandboxOverrideForContext,
  type ToolContext,
} from "./context";
import { ensureReadCache, getEditFailures } from "./edit";

export function buildReplaceExactTools(ctx: ToolContext) {
  const native = nativeForContext(ctx);
  return {
    replace_exact: tool({
      description:
        "RECOVERY-ONLY byte-for-byte replacement in an existing UTF-8 text file. Use ONLY after edit/batch_edit has failed or its failure latch is active — never as the default editor. old_string and new_string are literal UTF-8 bytes: NO whitespace/punctuation relaxation, EOL conversion, BOM removal, trailing-space stripping, or final-newline changes. expected_occurrences defaults to 1 and MUST exactly equal the non-overlapping exact-match count; zero or ambiguous matches write nothing and return match diagnostics. Keeps normal path security, locking, plan/diff review, approval, and checkpoint_undo protections. Successful replacement clears the file's edit-failure latch. No retries or fallback matching.",
      inputSchema: z
        .object({
          path: z.string().min(1),
          old_string: z.string().min(1),
          new_string: z.string(),
          expected_occurrences: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .describe("Required exact non-overlapping occurrence count; defaults to 1."),
        })
        .strict(),
      needsApproval: true,
      execute: async ({ path, old_string, new_string, expected_occurrences = 1 }) => {
        if (new_string === old_string) {
          return { error: "old_string and new_string are identical; nothing to change", changed: false };
        }
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkWritableCanonical(
          reqPath,
          native.canonicalize,
          await sandboxOverrideForContext(ctx),
        );
        if (!safety.ok) return { error: safety.reason, path: reqPath, changed: false };
        const abs = safety.canonical;
        const guard = await ensureReadCache(abs, ctx, native);
        if (guard) return { ...guard, changed: false };
        const failures = getEditFailures(ctx).get(abs) ?? 0;
        if (failures === 0) {
          return {
            error:
              "replace_exact is recovery-only. Try edit/batch_edit first; use this tool only when their matcher fails or their failure latch is active.",
            path: abs,
            changed: false,
          };
        }

        return withFileMutationLock([abs], async () => {
          // Read the decoded view solely for plan/diff approval and cache
          // refresh. The mutation itself uses raw bytes in Rust.
          const original = await native.readFile(abs);
          if (original.kind === "binary") {
            return { error: "replace_exact requires UTF-8 text; binary file refused", path: abs, changed: false };
          }
          if (original.kind === "toolarge") {
            return { error: `file too large (${original.size} bytes)`, path: abs, changed: false };
          }

          if (usePlanStore.getState().active) {
            // Plan mode never writes. Validate in pure JS (mirror of the Rust
            // count check; the exact byte semantics are re-verified by Rust
            // at apply time, which is the only place that can write).
            const found = original.content.split(old_string).length - 1;
            if (found !== expected_occurrences) {
              return {
                error: `old_string matched ${found} occurrence(s) in the decoded view; expected ${expected_occurrences}. Nothing was changed.`,
                path: abs,
                changed: false,
              };
            }
            const proposed = original.content.split(old_string).join(new_string);
            const onApplied = async () => {
              const reread = await native.readFile(abs);
              if (reread.kind === "text") {
                ctx.readCache.set(abs, readCacheEntry(reread.content));
              }
              getEditFailures(ctx).delete(abs);
              ctx.fileTracker.markModified(abs);
              window.dispatchEvent(new CustomEvent("Kai:fs-changed", { detail: abs }));
            };
            usePlanStore.getState().enqueue({
              id: newQueuedEditId(),
              kind: "replace_exact",
              path: abs,
              originalContent: original.content,
              proposedContent: proposed,
              isNewFile: false,
              exactReplacement: {
                oldString: old_string,
                newString: new_string,
                expectedOccurrences: expected_occurrences,
              },
              onApplied,
            });
            return {
              queued: true,
              replacements: expected_occurrences,
              bytesWritten: new TextEncoder().encode(proposed).length,
              path: abs,
            };
          }

          const checkpoint = createCheckpointBatch(
            ctx.getRealWorkspaceRoot?.() ?? ctx.getWorkspaceRoot() ?? "",
            ctx.getSessionId() ?? "",
            native,
          );
          await snapshotFileForBatch(checkpoint, abs);
          try {
            const result = await native.replaceExact(
              abs,
              old_string,
              new_string,
              expected_occurrences,
            );
            const reread = await native.readFile(abs);
            if (reread.kind === "text") {
              ctx.readCache.set(abs, readCacheEntry(reread.content));
            } else {
              ctx.readCache.delete(abs);
            }
            getEditFailures(ctx).delete(abs);
            ctx.fileTracker.markModified(abs);
            await commitCheckpointBatch(checkpoint);
            window.dispatchEvent(new CustomEvent("Kai:fs-changed", { detail: abs }));
            return { ok: true, ...result, path: abs };
          } catch (error) {
            return { error: String(error), path: abs, changed: false };
          }
        });
      },
    }),
  } as const;
}