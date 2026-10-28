import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { checkReadable, checkReadableCanonical } from "../lib/security";
import { resolvePath, type ToolContext } from "./context";

/**
 * Per-result secret check. `checkReadableCanonical` is only applied to the
 * `root` argument, so without this a `grep` rooted at $HOME could surface
 * lines from ~/.aws/credentials or ~/.ssh/id_rsa. The Rust side has no
 * deny-list, so this is the only gate on individual result paths.
 *
 * Suppression is silent rather than an error — a partial result is more
 * useful than none, and `files_scanned` still reflects the full walk.
 */
function isReadableResult(path: string): boolean {
  return checkReadable(path).ok;
}

function resolveRoot(
  rawRoot: string | undefined,
  ctx: ToolContext,
): { ok: true; path: string } | { ok: false; error: string } {
  if (rawRoot && rawRoot.trim().length > 0) {
    try {
      return { ok: true, path: resolvePath(rawRoot, ctx.getCwd()) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  const ws = ctx.getWorkspaceRoot();
  if (ws) return { ok: true, path: ws };
  const cwd = ctx.getCwd();
  if (cwd) return { ok: true, path: cwd };
  return {
    ok: false,
    error: "no workspace root or active cwd; pass `root` explicitly.",
  };
}

const MAX_LINE_LEN = 160;

function clipLine(s: string): string {
  if (s.length <= MAX_LINE_LEN) return s;
  return `${s.slice(0, MAX_LINE_LEN)}…[+${s.length - MAX_LINE_LEN}]`;
}

export function buildSearchTools(ctx: ToolContext) {
  return {
    grep: tool({
      description:
        "Search file CONTENTS across the workspace with a regex (ripgrep; honors .gitignore). This is the right tool for \"where is X defined/used?\" and the Windows-safe replacement for Select-String/findstr — it auto-executes with NO approval card, so prefer it over a `bash_run` search pipeline every time. Returns up to `max_results` (default 30, max 500) `{path, line, text}` hits with a `truncated` flag; match lines clip to 160 chars. Narrow with the `glob` arg; raise `max_results` only if the first batch clearly isn't enough. One focused grep beats reading many files — do NOT brute-force read_file across the tree.",
      inputSchema: z.object({
        pattern: z
          .string()
          .describe(
            "Regex pattern (Rust ripgrep dialect). Anchor and escape literal characters as needed.",
          ),
        root: z
          .string()
          .optional()
          .describe(
            "Root to search under. Defaults to workspace root, then active cwd.",
          ),
        glob: z
          .array(z.string())
          .optional()
          .describe(
            "Optional include-globs over relative paths, e.g. ['**/*.ts', 'src/**/*.tsx'].",
          ),
        case_insensitive: z.boolean().optional(),
        max_results: z.number().min(1).max(500).optional(),
      }),
      execute: async ({
        pattern,
        root,
        glob,
        case_insensitive,
        max_results,
      }) => {
        const r = resolveRoot(root, ctx);
        if (!r.ok) return { error: r.error };
        const safety = await checkReadableCanonical(r.path, native.canonicalize, ctx.getSandboxOverride?.() ?? null);
        if (!safety.ok) return { error: safety.reason, root: r.path };
        r.path = safety.canonical;
        const cap = Math.min(max_results ?? 30, 500);
        try {
          const res = await native.grep({
            pattern,
            root: r.path,
            glob,
            caseInsensitive: case_insensitive,
            maxResults: cap,
          });
          return {
            root: r.path,
            hits: res.hits
              .filter((h) => isReadableResult(h.path))
              .map((h) => ({
                path: h.path,
                rel: h.rel,
                line: h.line,
                text: clipLine(h.text),
              })),
            truncated: res.truncated,
            files_scanned: res.files_scanned,
          };
        } catch (e) {
          return { error: String(e), root: r.path };
        }
      },
    }),

    glob: tool({
      description:
        "Find files by path pattern (gitignore-aware). Use over `list_directory` when you want all matches recursively. Patterns use globset syntax: `**/*.ts`, `src/**/test_*.py`. Returns up to `max_results` matches.",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern over relative paths."),
        root: z.string().optional(),
        max_results: z.number().min(1).max(2000).optional(),
      }),
      execute: async ({ pattern, root, max_results }) => {
        const r = resolveRoot(root, ctx);
        if (!r.ok) return { error: r.error };
        const safety = await checkReadableCanonical(r.path, native.canonicalize, ctx.getSandboxOverride?.() ?? null);
        if (!safety.ok) return { error: safety.reason, root: r.path };
        r.path = safety.canonical;
        try {
          const res = await native.glob({
            pattern,
            root: r.path,
            maxResults: max_results,
          });
          return {
            root: r.path,
            hits: res.hits.filter((h) => isReadableResult(h.path)),
            truncated: res.truncated,
          };
        } catch (e) {
          return { error: String(e), root: r.path };
        }
      },
    }),
  } as const;
}
