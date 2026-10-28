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
 * Bounded FIFO: approval ids are per tool-call and never reused within a
 * session's life, but sessions churn; the cap keeps the set from growing
 * without limit. Eviction is safe — an id whose denial was evicted would
 * need a still-pending deferred approval from long after its call settled
 * to do any harm, which the SDK's own stale-call throw already bounces.
 */

const LATCH_CAP = 1000;
const denied = new Set<string>();

/** Record that an approval id was denied (human click, or a stale
 *  approval reaped without a decision — absence of permission is denial). */
export function noteApprovalDenied(approvalId: string): void {
  if (!approvalId) return;
  if (denied.has(approvalId)) return;
  denied.add(approvalId);
  while (denied.size > LATCH_CAP) {
    const oldest = denied.values().next().value;
    if (oldest === undefined) break;
    denied.delete(oldest);
  }
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
