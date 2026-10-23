/**
 * Radio preferences — THIN wrapper over the settings store.
 *
 * Previously this module opened its OWN LazyStore on Kai-settings.json with
 * duplicate keys/setters. Two handles on the same file can interleave
 * `set`+`save()` and lose updates, and the parallel key set invites drift —
 * now all persistence goes through the single settings store (which also
 * emits `Kai://prefs-changed` for cross-window sync via writePref).
 *
 * The fire-safe contract is preserved: a store failure logs and resolves —
 * the radio is decoration and must never block the app.
 */
import {
  setRadioEnabled as storeSetRadioEnabled,
  setRadioStationId as storeSetRadioStationId,
} from "@/modules/settings/store";
import { usePreferencesStore } from "@/modules/settings/preferences";

export async function getRadioEnabled(): Promise<boolean> {
  try {
    return usePreferencesStore.getState().radioEnabled;
  } catch {
    return false;
  }
}

export async function setRadioEnabled(value: boolean): Promise<void> {
  try {
    await storeSetRadioEnabled(value);
  } catch (err) {
    console.warn("[radio] failed to persist enable toggle:", err);
  }
}

export async function getRadioStationId(): Promise<string | null> {
  try {
    const v = usePreferencesStore.getState().radioStationId;
    return v || null;
  } catch {
    return null;
  }
}

export async function setRadioStationId(id: string | null): Promise<void> {
  try {
    await storeSetRadioStationId(id ?? "");
  } catch (err) {
    console.warn("[radio] failed to persist station:", err);
  }
}
