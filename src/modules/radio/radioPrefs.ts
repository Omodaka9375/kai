/**
 * Radio preferences — persisted via the settings store (LazyStore), same
 * pattern as every other General-section pref. Both setters are fire-safe:
 * a store failure (locked file, corrupt JSON) logs and resolves — the radio
 * is decoration and must never block the app.
 */
import { LazyStore } from "@tauri-apps/plugin-store";
import { emit } from "@tauri-apps/api/event";

const STORE_PATH = "Kai-settings.json";
const KEY_ENABLED = "radioEnabled";
const KEY_STATION = "radioStationId";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

const RADIO_EVENT = "Kai://prefs-changed";

export async function getRadioEnabled(): Promise<boolean> {
  try {
    const v = await store.get<boolean>(KEY_ENABLED);
    return typeof v === "boolean" ? v : false;
  } catch {
    return false;
  }
}

export async function setRadioEnabled(value: boolean): Promise<void> {
  try {
    await store.set(KEY_ENABLED, value);
    await store.save();
    await emit(RADIO_EVENT, { key: KEY_ENABLED, value });
  } catch (err) {
    console.warn("[radio] failed to persist enable toggle:", err);
  }
}

export async function getRadioStationId(): Promise<string | null> {
  try {
    const v = await store.get<string>(KEY_STATION);
    if (typeof v !== "string" || !v) return null;
    return v;
  } catch {
    return null;
  }
}

export async function setRadioStationId(id: string | null): Promise<void> {
  try {
    await store.set(KEY_STATION, id);
    await store.save();
    await emit(RADIO_EVENT, { key: KEY_STATION, value: id });
  } catch (err) {
    console.warn("[radio] failed to persist station:", err);
  }
}