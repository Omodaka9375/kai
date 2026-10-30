/**
 * Per-file mutation lock — serializes file mutations (edit, batch_edit,
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
/**
 * Independent tails map for named exclusive resources (agent shells, etc.)
 * — kept separate from the file-path map so a raw key can never collide
 * with a path key.
 */
const exclusiveTails = new Map<string, Promise<void>>();

/**
 * Run `fn` while holding an exclusive lock identified by an opaque verbatim
 * key (NO path normalization here — the caller's key IS the identity).
 * Concurrent holders of the same key serialize in arrival order; different
 * keys run in parallel.
 *
 * Use for any shared stateful resource the AI SDK may dispatch concurrently
 * within one step: notably the per-session persistent agent shell — two
 * `bash_run` calls issued in one step would otherwise interleave on one PTY
 * (output corruption + cwd races).
 */
export function withExclusiveLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = exclusiveTails.get(key) ?? Promise.resolve();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const tail = prev.then(() => gate);
  exclusiveTails.set(key, tail);
  tail.then(() => {
    if (exclusiveTails.get(key) === tail) exclusiveTails.delete(key);
  });

  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
}

/**
 * Serialize file mutations across ALL calls touching a given path, matching
 * withExclusiveLock semantics but with canonical path keys (forward slashes,
 * case-folded; see keyFor).
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
