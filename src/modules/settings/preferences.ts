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
  setCustomContextLimit("openai-compatible-custom", prefs.openaiCompatibleContextSize ?? 0);
}

/** Push the user's group-name pool into the group store (empty = defaults).
 *  LAZY import: groupChatStore transitively pulls mcpManager/mcpOAuth whose
 *  module top-levels call createProxyFetch — a static import here creates
 *  an import cycle that leaves proxyFetch half-initialized (broke
 *  domain/web/assemblyai suites). Import at call time instead. */
function syncGroupNamePool(raw: string) {
  void import("@/modules/ai/store/groupChatStore").then((m) => {
    m.setGroupNamePool(
      raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    );
  });
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
    if (prefs.groupNamePool) syncGroupNamePool(prefs.groupNamePool);
    void onPreferencesChange((key, value) => {
      set({ [key]: value } as Partial<State>);
      if (key === "openaiCompatibleContextSize") {
        syncContextOverrides({
          ...usePreferencesStore.getState(),
          [key]: value as number,
        });
      }
      if (key === "groupNamePool") syncGroupNamePool(String(value ?? ""));
    });
  },
}));
