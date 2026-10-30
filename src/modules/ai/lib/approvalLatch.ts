/**
 * Denial latch for tool approvals — makes approval decisions monotonic.
 *
 * An approval response can arrive from several independent listeners: the
 * human click (via the store's approval responder), the auto-approve-all
 * effect, and the scoped-allowlist path — the latter two deferred through
 * `setTimeout` / promise `.then` callbacks to dodge React update-depth
 * limits. Without a latch, a deferred `approved: true` scheduled before the
 * human clicked Deny can land AFTER the denial and re-permit the call (the
 * AI SDK is last-writer-wins). A reaped stale approval is likewise an
 * absence of permission that nothing else records.
 *
 * The latch is the fix: once an approval id is denied (explicitly or by
 * reaping), it is denied FOREVER. Every respond path checks it before
 * calling `addToolApprovalResponse`. This is the deny-only pattern from
 * agent-harness policy design: a guard whose decisions can only reduce
 * permission, so listener ORDER can never turn a denial back into
 * permission.
 *
 * WINDOW SCOPE: the latch is per-JS-context by design. Approval cards and
 * responders live ONLY in the main webview — the settings window imports
 * the assistant's prefs split (modules/assistant/prefs.ts) precisely so no
 * chat/approval machinery loads there, and the Telegram assistant is a
 * separate headless process with approval tools stripped entirely. A second
 * window therefore cannot call `addToolApprovalResponse` on another
 * window's Chat, so no cross-window denial can be overturned. If a future
 * surface ever renders approval cards in a second webview, route latch
 * writes through one canonical owner (e.g. a Kai://approval-denied event
 * fanned out from the main window) BEFORE shipping that surface.
 *
 * Bounded by TIME, not by count: approval ids are per tool-call and never
 * reused, and the relevant race window (deferred auto-approve vs a just-made
 * denial) is seconds wide. A FIFO CAP eviction could drop a still-relevant
 * denial in a long-running session (>1000 approvals evicts the OLDEST,
 * which may be minutes old and still attached to a live card). Entries now
 * expire only when older than LATCH_TTL_MS, so an id that was denied within
 * the last TTL can never be evicted while its race is still possible.
 */

const LATCH_TTL_MS = 30 * 60 * 1000; // 30 minutes
const denied = new Map<string, number>();

/** Current time, overridable in tests. */
let now = () => Date.now();

function sweep(): void {
  const t = now();
  for (const [id, at] of denied) {
    if (t - at > LATCH_TTL_MS) denied.delete(id);
  }
}

/** Record that an approval id was denied (human click, or a stale
 *  approval reaped without a decision — absence of permission is denial). */
export function noteApprovalDenied(approvalId: string): void {
  if (!approvalId) return;
  if (denied.has(approvalId)) {
    denied.set(approvalId, now()); // refresh TTL on repeat notes
    return;
  }
  denied.set(approvalId, now());
  if (denied.size > 1) sweep();
}

/** True when this approval id was denied at some point. Every deferred
 *  `approved: true` response must check this AT FIRE TIME, not just at
 *  schedule time — the denial can arrive in between. */
export function isApprovalDenied(approvalId: string): boolean {
  return denied.has(approvalId);
}

/** Test helper only: forget all latched denials. */
export function __resetApprovalLatchForTests(): void {
  denied.clear();
}

/** Test helper only: pin the clock for TTL testing. */
export function __setLatchClockForTests(fn: (() => number) | null): void {
  now = fn ?? (() => Date.now());
}
