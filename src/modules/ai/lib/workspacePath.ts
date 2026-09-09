/**
 * Canonical workspace-path identity.
 *
 * Normalizes separators (backslash → forward slash), strips a trailing slash,
 * and lowercases. Lowercasing unconditionally (rather than per-platform) keeps
 * this helper in lockstep with the Rust `project_key()` in `src-tauri/src/lib.rs`,
 * which also lowercases — the two MUST agree or sessions and window state would
 * target different files for the same project.
 *
 * Lowercasing is a deliberate identity choice: Windows and macOS are
 * case-insensitive, so `D:/Code/KAI` and `d:/code/kai` are the same project.
 * On Linux this can fold two genuinely-distinct sibling dirs differing only by
 * case into one key — an acceptable, vanishingly-rare tradeoff for the
 * guarantee that a project's key never depends on how the path was typed.
 *
 * NOTE: the fold is ASCII-focused. JS `toLowerCase()` and Rust
 * `to_lowercase()` agree on the ASCII range used by real project paths; exotic
 * Unicode case-collision behavior is intentionally out of scope.
 */
export function normalizeWorkspacePath(
  p: string | null | undefined,
): string | null {
  const n = p?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!n || n.length === 0) return null;
  return n.toLowerCase();
}
