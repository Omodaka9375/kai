import { useEffect, useRef } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  SHORTCUTS,
  collidesWithTerminal,
  matchBinding,
  type ShortcutId,
} from "../shortcuts";

export type ShortcutHandler = (e: KeyboardEvent) => void;
export type ShortcutHandlers = Partial<Record<ShortcutId, ShortcutHandler>>;

export type UseGlobalShortcutsOptions = {
  isDisabled?: (id: ShortcutId, e: KeyboardEvent) => boolean;
};

export function useGlobalShortcuts(
  handlers: ShortcutHandlers,
  options?: UseGlobalShortcutsOptions,
) {
  const latest = useRef({ handlers, options });
  latest.current = { handlers, options };

  // Access the shortcuts from the store
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { handlers, options } = latest.current;
      // A focused terminal owns its shell control keys on Windows/Linux
      // (Ctrl+R/D/W/…) — those chords are the PTY's, not KAI's, so let them
      // through instead of hijacking them in the capture phase.
      const target = e.target as HTMLElement | null;
      const inTerminal = !!target?.closest?.(".xterm");
      for (const s of SHORTCUTS) {
        if (e.repeat && !s.allowRepeat) continue;
        const bindings = userShortcuts[s.id] || s.defaultBindings;
        const matched = bindings.find((b) => matchBinding(e, b, s.id));
        if (!matched) continue;
        if (inTerminal && collidesWithTerminal(matched)) continue;
        if (options?.isDisabled?.(s.id, e)) return;
        const h = handlers[s.id];
        if (!h) continue;
        e.preventDefault();
        e.stopImmediatePropagation();
        h(e);
        return;
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [userShortcuts]);
}
