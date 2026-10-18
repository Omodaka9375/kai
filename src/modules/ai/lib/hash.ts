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
 *
 * `coverage` records how much of the file the model ACTUALLY saw.
 *  - undefined: the entry was written from full content (mutations of the
 *    whole file are safe — the model's view is the whole file).
 *  - { full: true }: every byte was seen (possibly across multiple paged
 *    reads) — same safety as above.
 *  - { full: false, lines: totalLines }: the model saw a TRUNCATED view
 *    (read_file line/byte caps, or the unchanged-preview). write_file must
 *    REFUSE to overwrite in that state, else it silently truncates the
 *    file to the model's partial view — data loss with a success result.
 */
export function readCacheEntry(
  content: string,
  coverage?: {
    full: boolean;
    lines?: number;
    /** Highest line index (exclusive) covered by contiguous-from-0 pages. */
    seenThrough?: number;
  },
): {
  size: number;
  hash: number;
  coverage?: {
    full: boolean;
    lines?: number;
    seenThrough?: number;
  };
} {
  return {
    size: content.length,
    hash: djb2(content),
    ...(coverage ? { coverage } : {}),
  };
}
