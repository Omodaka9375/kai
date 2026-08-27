/**
 * Per-file mutation lock — serializes file mutations (edit, multi_edit,
 * write_file, batch_edit) on a per-path basis.
 *
 * Why: the AI SDK executes multiple tool calls from a single assistant step
 * concurrently. When the agent emits several edits to the *same* file in one
 * turn (common with auto-approval off, where a batch of edits is approved at
 * once), each tool performs an independent read-modify-write against the same
 * stale snapshot. The last writer wins, silently clobbering earlier edits, or
 * a later edit's old_string no longer matches. Serializing per-path makes the
 * result deterministic: each edit reads the file *after* the previous one
 * landed, so disjoint edits both apply and overlapping edits fail cleanly with
 * a "re-read the file" error instead of corrupting content.
 *
 * Edits to *different* paths still run in parallel.
 */

const tails = new Map<string, Promise<void>>();

function keyFor(path: string): string {
  // Canonical-ish key: forward slashes, lowercased. Case-folding matters on
  // case-insensitive filesystems (macOS/Windows) so "Foo.ts" and "foo.ts"
  // serialize against each other.
  return path.replace(/\\/g, "/").toLowerCase();
}

/**
 * Run `fn` while holding the mutation lock for every path in `paths`.
 * Overlapping calls (any shared path) are serialized; disjoint paths run
 * concurrently.
 */
export function withFileMutationLock<T>(
  paths: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(paths.map(keyFor))].sort();

  // Resolve when all current tails for the involved keys have settled.
  const prev = Promise.all(
    keys.map((k) => tails.get(k) ?? Promise.resolve()),
  ).then(() => undefined);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Our tail is the previous tails followed by our gate. Register it for every
  // involved key so a future call touching *any* of these paths waits for us.
  const tail = prev.then(() => gate);
  for (const k of keys) tails.set(k, tail);

  // Prune stale entries once our tail resolves (if we're still the current one).
  tail.then(() => {
    for (const k of keys) {
      if (tails.get(k) === tail) tails.delete(k);
    }
  });

  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
}
