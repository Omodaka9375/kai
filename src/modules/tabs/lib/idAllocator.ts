let nextWorkspaceTabId = 3;

/** Process-wide tab/leaf IDs. PTYs, renderer slots, and native sessions are
 * app-global keyed by these numbers, so per-project counters must never
 * produce the same id twice. */
export function allocateWorkspaceTabIds(count = 1): number {
  const first = nextWorkspaceTabId;
  nextWorkspaceTabId += count;
  return first;
}
