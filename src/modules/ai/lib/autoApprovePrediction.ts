/**
 * UI-side prediction of the bridge's auto-approve gate.
 *
 * AgentRunBridge's auto-approve effect is the AUTHORITATIVE decider — this
 * module is a deliberate MIRROR of its carve-outs (kept in lockstep by
 * autoApprovePrediction.test.ts, which pins the bridge source to the same
 * checks in the same order). Why it exists: in autoApprove "all" mode the
 * bridge approves each pending call on a `setTimeout(0)` after the next
 * messages update — up to a throttle cycle AFTER the approval part first
 * renders. The approval card used to paint the FULL bordered card for that
 * window and then collapse to the flat one-row chip, which read as a
 * blink/glitch on every single tool call. The card consults this predictor
 * and renders the flat row from the FIRST frame for calls the bridge is
 * guaranteed to approve.
 *
 * If the mirror ever diverges from the bridge, the failure mode is bounded:
 * a flat row for a call the bridge then leaves pending. The lockstep test
 * is what prevents that; keep both sides in sync when editing either.
 */

/**
 * Tools whose approval card is a PRIVACY boundary — auto-approve never
 * applies, even under autoApprove: "all". Mirrors the bridge's
 * PRIVACY_APPROVAL_TOOLS (see screenConsent.test.ts for the enforcement
 * pins on the bridge copy).
 */
const PRIVACY_APPROVAL_TOOLS: ReadonlySet<string> = new Set([
  "look_at_screen",
]);

/** Detect a `git commit` invocation (not commit-tree) inside a bash_run
 *  command. Mirrors the bridge's isGitCommitCommand. */
function isGitCommitCommand(command: string | undefined): boolean {
  if (!command) return false;
  return (
    /\bgit\s+commit(?:\s|$)/.test(command) &&
    !/\bgit\s+commit-tree\b/.test(command)
  );
}

export type AutoApprovalPrediction = {
  /** The owning session's auto-approve mode ("off" | "all"). */
  autoApprove: "off" | "all";
  toolName: string;
  input: Record<string, unknown> | undefined;
  /** Commit signing is set to "ask for approval". */
  signingApprovalRequired: boolean;
};

/** True when the bridge WILL auto-approve this pending call. Mirrors the
 *  bridge's per-part gate exactly (elevated → privacy → signed commit).
 *  The carve-outs are SHAPE-based, not name-based — MCP (`server__*`)
 *  wrappers of shell execution or git commits stop for the same clicks
 *  their first-party equivalents do. */
export function predictAutoApproval(
  args: AutoApprovalPrediction,
): boolean {
  if (args.autoApprove !== "all") return false;
  // Elevation is a stronger trust boundary — never auto-approved, even
  // under "all". The user must click the elevation card.
  if (args.input?.elevated === true) {
    return false;
  }
  // Screen capture's approval card IS the privacy boundary.
  if (PRIVACY_APPROVAL_TOOLS.has(args.toolName)) return false;
  // Commit-signing "ask for approval" outranks autoApprove: "all". Command-
  // shaped inputs across first-party and MCP shapes (command/cmd/script —
  // the same field set the central tool guards probe).
  if (
    args.signingApprovalRequired &&
    isGitCommitCommand(
      (args.input?.command ?? args.input?.cmd ?? args.input?.script) as
        | string
        | undefined,
    )
  ) {
    return false;
  }
  return true;
}
