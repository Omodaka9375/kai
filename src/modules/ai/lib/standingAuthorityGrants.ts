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
  type Preferences,
} from "@/modules/settings/store";
import { STANDING_AUTHORITY_TOOLS } from "./autoApprovePrediction";

/** Read the current grant list (reactive when used inside a selector). */
export function getStandingAuthorityGrants(
  prefs: Pick<Preferences, "standingAuthorityAlwaysAllowed">,
): string[] {
  return prefs.standingAuthorityAlwaysAllowed;
}

/** True when this exact tool carries a user grant. */
export function hasStandingAuthorityGrant(
  toolName: string,
  prefs: Pick<Preferences, "standingAuthorityAlwaysAllowed">,
): boolean {
  return prefs.standingAuthorityAlwaysAllowed.includes(toolName);
}

/** Grant "Always Allow" to a tool. Only authority tools are accepted —
 *  anything else is a no-op (the card only renders the button for the
 *  authority set anyway). */
export async function grantStandingAuthorityAlwaysAllow(
  toolName: string,
): Promise<void> {
  if (!STANDING_AUTHORITY_TOOLS.has(toolName)) return;
  const current =
    usePreferencesStore.getState().standingAuthorityAlwaysAllowed;
  if (current.includes(toolName)) return;
  await setStandingAuthorityAlwaysAllowed([...current, toolName]);
}

/** Revoke a grant (Settings → Security, or programmatically). */
export async function revokeStandingAuthorityAlwaysAllow(
  toolName: string,
): Promise<void> {
  const current =
    usePreferencesStore.getState().standingAuthorityAlwaysAllowed;
  if (!current.includes(toolName)) return;
  await setStandingAuthorityAlwaysAllowed(
    current.filter((n) => n !== toolName),
  );
}
