import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setFavoriteModelIds,
  setProjectModelId,
  setRecentModelIds,
} from "@/modules/settings/store";

const RECENTS_MAX = 5;

export async function toggleFavoriteModel(id: string): Promise<void> {
  const current = usePreferencesStore.getState().favoriteModelIds;
  const next = current.includes(id)
    ? current.filter((x) => x !== id)
    : [...current, id];
  await setFavoriteModelIds(next);
}

export async function pushRecentModel(id: string): Promise<void> {
  const current = usePreferencesStore.getState().recentModelIds;
  const next = [id, ...current.filter((x) => x !== id)].slice(0, RECENTS_MAX);
  if (
    next.length === current.length &&
    next.every((x, i) => x === current[i])
  ) {
    return;
  }
  await setRecentModelIds(next);
}

/** Save the model choice for the current project so it's restored on next open. */
export async function persistProjectModel(id: string, workspaceRoot: string | null): Promise<void> {
  if (!workspaceRoot) return;
  const key = workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "");
  await setProjectModelId(key, id);
}
