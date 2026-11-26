/**
 * Standing-authority "Always Allow" grants — the per-tool bypass the user
 * clicks on the approval card (2026-11-16 ask).
 *
 * Rationale: the 2026-11-15 fix stopped standing-authority tools
 * (settings_update_restricted, mcp_add_server, create_skill, update_skill,
 * watch_create, delete_persona, save_memory) from auto-approving under
 * Allow mode — correct, but it buried the user in cards for tools they
 * rationally trust (e.g. save_memory on every memory write). "Always Allow"
 * is the middle path: a per-tool, explicit, revocable grant that silences
 * the card in BOTH Ask and Allow modes. It is the USER's decision, made on
 * a card showing the exact tool — fundamentally different from session
 * Allow silently covering permanent authority.
 *
 * PER-PROJECT SCOPING (2026-11-25 security hardening): the grant list used
 * to be one GLOBAL flat list — a "yes" clicked in project A silenced the
 * approval card in every OTHER project too, including freshly cloned /
 * untrusted ones. A permission is an expression of trust in a project, so
 * each "yes" now counts only in the project where it was given:
 *  - new grants write the per-project map (standingAuthorityGrantProjects,
 *    keyed by canonical project id);
 *  - the legacy flat list (standingAuthorityAlwaysAllowed) remains as the
 *    migration source and a fallback — but ONLY for projects with no map
 *    entry AND only while the project is TRUSTED. An untrusted project
 *    inherits nothing.
 *
 * Storage: the preferences store (Kai-settings.json), NOT the OS keychain —
 * it is a plain allowlist, not a credential. Revocation: Settings →
 * Security → "Always allowed" card. The grants are validated against
 * STANDING_AUTHORITY_TOOLS on both write and load, so a tampered or stale
 * store entry naming a non-authority tool is dropped (belt: store.ts's
 * setter also filters).
 */

import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setStandingAuthorityAlwaysAllowed,
  setStandingAuthorityGrantProjects,
  type Preferences,
} from "@/modules/settings/store";
import { STANDING_AUTHORITY_TOOLS } from "./autoApprovePrediction";
import { isWorkspaceTrusted } from "@/modules/workspace/workspaceTrust";

/** Grants snapshot for one decision point. Carries BOTH shapes so callers
 *  that already hold a preferences slice don't need a second read. */
export type AuthorityGrantSnapshot = Pick<
  Preferences,
  "standingAuthorityAlwaysAllowed" | "standingAuthorityGrantProjects"
>;

function readSnapshot(): AuthorityGrantSnapshot {
  const s = usePreferencesStore.getState();
  return {
    standingAuthorityAlwaysAllowed: s.standingAuthorityAlwaysAllowed,
    standingAuthorityGrantProjects: s.standingAuthorityGrantProjects,
  };
}

/** Shared stable empty array so Zustand v5 / useSyncExternalStore selectors
 *  calling effectiveAuthorityGrants(...) for untrusted or rootless projects
 *  return the SAME reference across renders. Returning a fresh `[]` literal
 *  violated uSES snapshot stability (`Object.is([], []) === false`) and
 *  crashed the whole app with Minified React error #185 the instant an
 *  untrusted new project mounted its AgentRunBridge. */
const EMPTY_AUTHORITY_GRANTS: readonly string[] = Object.freeze([]);

/**
 * The effective grant list for a project: what predictAutoApproval /
 * isAlwaysAllowedAuthorityTool should be fed when gating a call that
 * belongs to `projectId`.
 *
 * Resolution order:
 *  1. per-project map entry (a null projectId reads as no entry);
 *  2. legacy flat list — ONLY when the project is trusted. Legacy grants
 *     predate per-project scoping; keeping them for trusted projects
 *     preserves every existing user's convenience, while an untrusted /
 *     newly opened project inherits NOTHING until the user says yes there.
 *
 * `projectId` is the canonical id (projectIdFor(root, env)) — the same id
 * the trust registry and the session preference store use.
 */
export function effectiveAuthorityGrants(
  projectId: string | null | undefined,
  prefs: AuthorityGrantSnapshot = readSnapshot(),
): readonly string[] {
  const perProject = projectId
    ? prefs.standingAuthorityGrantProjects[projectId]
    : undefined;
  if (perProject) return perProject;
  if (!projectId) return EMPTY_AUTHORITY_GRANTS;
  // Legacy fallback: trusted projects only. isWorkspaceTrusted returns
  // true for no-project sessions (fail-open for the rootless surface, same
  // contract as the trust gate).
  if (!isWorkspaceTrusted(projectId)) return EMPTY_AUTHORITY_GRANTS;
  return prefs.standingAuthorityAlwaysAllowed;
}

/** Back-compat reader: the raw per-project map (reactive inside a
 *  selector). Callers deciding for a project must use
 *  effectiveAuthorityGrants instead. */
export function getStandingAuthorityGrants(
  prefs: Pick<Preferences, "standingAuthorityAlwaysAllowed">,
): string[] {
  return prefs.standingAuthorityAlwaysAllowed;
}

/** True when this exact tool carries a user grant FOR THIS PROJECT. */
export function hasStandingAuthorityGrant(
  toolName: string,
  prefs: AuthorityGrantSnapshot,
  projectId?: string | null,
): boolean {
  return effectiveAuthorityGrants(projectId, prefs).includes(toolName);
}

/** Grant "Always Allow" to a tool IN A PROJECT. Only authority tools are
 *  accepted — anything else is a no-op (the card only renders the button
 *  for the authority set anyway).
 *
 * projectId null/undefined (rootless surfaces: group personas, StartPage)
 * falls back to the legacy flat list — there is no project to scope the
 * grant to, and the group/persona gate already resolves grants through
 * the coordinator's project (or none). */
export async function grantStandingAuthorityAlwaysAllow(
  toolName: string,
  projectId?: string | null,
): Promise<void> {
  if (!STANDING_AUTHORITY_TOOLS.has(toolName)) return;
  const s = usePreferencesStore.getState();
  if (!projectId) {
    if (s.standingAuthorityAlwaysAllowed.includes(toolName)) return;
    await setStandingAuthorityAlwaysAllowed([
      ...s.standingAuthorityAlwaysAllowed,
      toolName,
    ]);
    return;
  }
  const current = { ...s.standingAuthorityGrantProjects };
  const existing = current[projectId] ?? [];
  if (existing.includes(toolName)) return;
  current[projectId] = [...existing, toolName];
  await setStandingAuthorityGrantProjects(current);
}

/** Revoke a grant (Settings → Security, or programmatically). `projectId`
 *  null/undefined revokes from the legacy flat list (the Settings card
 *  shows per-project grants with their own project id). */
export async function revokeStandingAuthorityAlwaysAllow(
  toolName: string,
  projectId?: string | null,
): Promise<void> {
  const s = usePreferencesStore.getState();
  if (!projectId) {
    if (!s.standingAuthorityAlwaysAllowed.includes(toolName)) return;
    await setStandingAuthorityAlwaysAllowed(
      s.standingAuthorityAlwaysAllowed.filter((n) => n !== toolName),
    );
    return;
  }
  const current = { ...s.standingAuthorityGrantProjects };
  const existing = current[projectId];
  if (!existing || !existing.includes(toolName)) return;
  const next = existing.filter((n) => n !== toolName);
  if (next.length === 0) delete current[projectId];
  else current[projectId] = next;
  await setStandingAuthorityGrantProjects(current);
}
