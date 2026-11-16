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

/**
 * Tools that change the agent's STANDING authority or leave persistent
 * artifacts that outlive the run. Even under autoApprove: "all" these must
 * stop for a click — Allow means "do my task without pestering me", not
 * "re-program what I am allowed to do in every future session".
 *
 * The distinction the original gate missed: elevated bash / screen capture /
 * signed commits are the only carve-outs, so every tool below silently
 * auto-approved in Allow mode. That let the agent, with zero prompts:
 *   - rewrite `customInstructions` (text appended to EVERY future prompt)
 *     and `defaultShell` (what every one-shot exec runs through),
 *   - register an MCP server whose tools then load into later sessions,
 *   - author a skill (standing reusable instructions, and a skill's
 *     `mcp_servers` relaunch silently on `#handle`),
 *   - start a watch (recurring unattended shell execution),
 *   - delete a persona (irreversible),
 *   - persist memory entries (`save_memory`): MEMORY.md is injected into
 *     EVERY future session's system prompt — the same standing-authority
 *     archetype as customInstructions, reachable by anything that can steer
 *     the model (fetched page, MCP output, poisoned repo file).
 *
 * This mirrors, for the interactive path, what `personaWorkspace.ts` already
 * does for headless personas ("global user-surface tools that mutate state
 * OUTLIVING the run"). The agent's own leash (`subagentMaxSteps`) rides
 * inside `settings_update_restricted`, so it is covered by the first entry.
 *
 * Only card-bearing tools belong here: a `needsApproval:false` tool never
 * reaches this gate, so listing it would be dead code that reads as a guard.
 */
export const STANDING_AUTHORITY_TOOLS: ReadonlySet<string> = new Set([
  "settings_update_restricted",
  "mcp_add_server",
  "create_skill",
  "update_skill",
  "watch_create",
  "delete_persona",
  "save_memory",
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
  /** Standing-authority tools the user granted "Always Allow" on the
   *  approval card. Read from the preferences store by the callers; kept
   *  as an explicit arg (not a store import) so this module stays pure and
   *  both callers pass the SAME list. Absent = no grants. */
  alwaysAllowedAuthorityTools?: readonly string[];
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
  // Standing-authority changes (app behavior, MCP registration, skills,
  // watches, persona deletion) are never auto-approved — Allow governs the
  // current task, not what the agent may permanently reconfigure. EXCEPT
  // an explicit user grant ("Always Allow" on the card, revocable in
  // Settings → Security): that is a per-tool decision the user already
  // made, not session-level Allow being stretched.
  if (
    STANDING_AUTHORITY_TOOLS.has(args.toolName) &&
    !(args.alwaysAllowedAuthorityTools ?? []).includes(args.toolName)
  ) {
    return false;
  }
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

/** True when NO approval card should wait for the user, in ANY mode — the
 *  one-click grant case. Ask mode never bypasses anything EXCEPT an
 *  explicitly granted authority tool: the user clicked "Always Allow" on
 *  that exact tool, so the card would be a rubber stamp they already
 *  stamped. Everything else (elevated, privacy, signed commits, non-granted
 *  authority tools) still stops in Ask mode. Used by the bridge's manual
 *  pending-count and by the card renderer to know a grant applies. */
export function isAlwaysAllowedAuthorityTool(
  toolName: string,
  alwaysAllowedAuthorityTools: readonly string[] | undefined,
): boolean {
  return (
    STANDING_AUTHORITY_TOOLS.has(toolName) &&
    (alwaysAllowedAuthorityTools ?? []).includes(toolName)
  );
}
