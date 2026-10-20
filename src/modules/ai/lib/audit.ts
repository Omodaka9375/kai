/**
 * Audit trail client — append-only record of security-relevant agent actions.
 *
 * The file lives outside the project (~/.kai/audit/audit.jsonl) so
 * workspace-confined code cannot rewrite history. The Rust side scrubs
 * credential-shaped values before they hit disk.
 *
 * Fire-and-forget by design: audit_append is never awaited on a tool's
 * critical path, and a failed append must never break the audited flow.
 */

import { invoke } from "@tauri-apps/api/core";

export type AuditEvent = {
  ts: number;
  kind: string;
  subject: string;
  summary: string;
  root: string;
};

/** Event kinds (mirrors the Rust module). */
export const AUDIT_KINDS = {
  toolExec: "tool.exec",
  approvalApprove: "approval.approve",
  approvalDeny: "approval.deny",
  securityDeny: "security.deny",
  sandboxChange: "sandbox.change",
  assistantExec: "assistant.exec",
} as const;

/** Fire-and-forget append. Errors are swallowed (logged in Rust). */
export function auditAppend(
  kind: string,
  subject: string,
  summary: string,
  root: string,
): void {
  void invoke("audit_append", { kind, subject, summary, root }).catch((e) =>
    console.warn("[kai:audit] append failed:", e),
  );
}

/** Read recent events, newest first. */
export function auditRecent(limit: number): Promise<AuditEvent[]> {
  return invoke<AuditEvent[]>("audit_recent", { limit });
}

/** Wipe the trail. */
export function auditClear(): Promise<void> {
  return invoke<void>("audit_clear");
}

/** Path of the audit dir on disk (Settings → Security "open folder"). */
export function auditDirPath(): Promise<string> {
  return invoke<string>("audit_dir_path");
}
