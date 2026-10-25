/**
 * Pure helpers for "reveal a path in the tree" (VSCode-style auto-reveal
 * when an editor tab becomes active).
 *
 * Tree keys are built by joinPath(rootPath, entry.name) chains — canonical
 * forward slashes, FS casing. Tab paths are canonical too in practice, but
 * come from several sources (OSC 7, the agent, the explorer itself) so both
 * separators and casing can drift; everything here canonicalizes and the
 * caller matches entry names case-insensitively on drive-letter roots.
 */

export function canonPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** "C:/..."-style absolute path → case-insensitive filesystem semantics.
 *  Decided from the path shape, not the runtime platform, so behavior is
 *  identical in tests and on every OS (a WSL root stays case-sensitive). */
export function isDrivePath(p: string): boolean {
  return /^[A-Za-z]:\//.test(canonPath(p));
}

/** True when `path` is `root` itself or nested under it. */
export function pathWithinRoot(path: string, root: string): boolean {
  let p = canonPath(path);
  let r = canonPath(root);
  if (!r) return false;
  if (isDrivePath(r)) {
    p = p.toLowerCase();
    r = r.toLowerCase();
  }
  return p === r || p.startsWith(`${r}/`);
}

/** Path segments of `path` relative to `root` ([] when outside or equal). */
export function relativeSegments(path: string, root: string): string[] {
  if (!pathWithinRoot(path, root)) return [];
  let p = canonPath(path);
  let r = canonPath(root);
  if (isDrivePath(r)) {
    p = p.toLowerCase();
    // slice by LENGTH of the original root — lowercasing preserves length
  }
  if (p === r) return [];
  return canonPath(path).slice(canonPath(root).length + 1).split("/").filter(Boolean);
}

/** Directory chain to expand for `path`'s row to exist: excludes the root
 *  (always listed) and `path` itself. Keys are joinPath-built from `root`,
 *  so they match the tree's own key form. */
export function ancestorDirs(path: string, root: string): string[] {
  const segs = relativeSegments(path, root);
  const out: string[] = [];
  let acc = canonPath(root);
  for (let i = 0; i < segs.length - 1; i++) {
    acc = `${acc}/${segs[i]}`;
    out.push(acc);
  }
  return out;
}
