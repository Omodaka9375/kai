/**
 * Open-group UI id (2026-11-26 group-input unification): the group panel's
 * openGroupId is component-local; the panel mirrors it here so any app-level
 * surface can read WHICH group owns the right-gutter slot synchronously.
 * The main input bar (composer.tsx submit) routes group sends through
 * this; the Workspaces cards read it for their group badges (via the
 * ProjectChatGrid re-exports).
 *
 * Module-level (not React state) so submit-time callers can read it
 * imperatively. The panel keeps it in sync: mirrorOpenGroupId(surface ===
 * "group" ? openGroupId : null) - a null mirror means NO group owns the
 * slot and the input bar submits to the foreground session as usual.
 */
let openGroupUiId: string | null = null;
const listeners = new Set<() => void>();

export function mirrorOpenGroupId(id: string | null): void {
  if (openGroupUiId === id) return;
  openGroupUiId = id;
  for (const l of listeners) l();
}

export function getOpenGroupUiId(): string | null {
  return openGroupUiId;
}

export function subscribeOpenGroupUi(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
