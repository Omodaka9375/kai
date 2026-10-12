/** DJB2 hash — fast, non-cryptographic string hash for dedup/caching. */
export function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/**
 * Canonical read-cache entry. EVERY cache writer must construct entries
 * through this helper: size and hash are derived from the SAME string, so a
 * guard comparing cache vs a fresh disk read can never disagree on units
 * (disk bytes vs UTF-16 length) — the false-"file changed" bug class.
 */
export function readCacheEntry(
  content: string,
): { size: number; hash: number } {
  return { size: content.length, hash: djb2(content) };
}
