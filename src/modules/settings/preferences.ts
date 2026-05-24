import { setCustomContextLimit } from "@/modules/ai/config";
import { create } from "zustand";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  onPreferencesChange,
  type Preferences,
} from "./store";

type State = Preferences & {
  hydrated: boolean;
  /** Subscribe & hydrate. Idempotent — safe to call from multiple windows. */
  init: () => Promise<void>;
};

function syncContextOverrides(prefs: Preferences) {
  setCustomContextLimit("lmstudio-local", prefs.lmstudioContextSize ?? 0);
  setCustomContextLimit("openai-compatible-custom", prefs.openaiCompatibleContextSize ?? 0);
}

let initialized = false;

export const usePreferencesStore = create<State>((set) => ({
  ...DEFAULT_PREFERENCES,
  hydrated: false,
  init: async () => {
    if (initialized) return;
    initialized = true;
    const prefs = await loadPreferences();
    set({ ...prefs, hydrated: true });
    // Push custom context sizes into the config module.
    syncContextOverrides(prefs);
    void onPreferencesChange((key, value) => {
      set({ [key]: value } as Partial<State>);
      if (key === "lmstudioContextSize" || key === "openaiCompatibleContextSize") {
        syncContextOverrides({ ...usePreferencesStore.getState(), [key]: value });
      }
    });
  },
}));
