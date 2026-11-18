/**
 * Shared chat font-size control for the AI-chat and group-chat panels.
 *
 * One persisted preference (Settings → General → Chat), consumed by every
 * chat surface. SCALING MODEL (2026-11-18 fix): the preference px is
 * converted to a RATIO over the default (12px) and applied as CSS `zoom`
 * on the TRANSCRIPT wrapper — not as font-size overrides. Why zoom: the
 * transcript is a soup of fixed text utilities (text-[11px],
 * text-[11.5px], text-sm…), so a font override only ever moved the pieces
 * it named (the old `[&_.text-sm]` shim scaled SOME blocks while
 * MessageContent's hardcoded text-[12px] never moved — "code blocks grow,
 * conversation text doesn't"). zoom scales EVERYTHING by the same factor,
 * font sizes AND spacing AND borders, exactly like browser Ctrl+scroll —
 * symmetric by construction. Applied to the wrapper (not the panel root)
 * so input bars, headers and strips keep their fixed UI size.
 */
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setChatFontSize, CHAT_FONT_SIZE_DEFAULT } from "@/modules/settings/store";

export const CHAT_ZOOM_BASE_PX = CHAT_FONT_SIZE_DEFAULT;

export function useChatFontSize(): {
  px: number;
  /** Zoom ratio for the TRANSCRIPT wrapper (1 at the default size). */
  zoom: number;
  /** Inline style for the transcript wrapper: CSS zoom. */
  rootStyle: React.CSSProperties;
} {
  const px = usePreferencesStore((s) => s.chatFontSize);
  const zoom = Math.round((px / CHAT_ZOOM_BASE_PX) * 100) / 100;
  return {
    px,
    zoom,
    rootStyle: { zoom },
  };
}

/** Apply Ctrl+scroll and Ctrl +/-/0 chat zoom while the pointer or focus is
 *  inside an AI/group chat panel. Idempotent: multiple mounts install once. */
let listenersInstalled = false;

function targetInsideChat(e: { target: EventTarget | null }): boolean {
  const el = e.target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return Boolean(
    el.closest("[data-ai-mini-window], [data-group-chat-panel], [data-ai-chat-panel]"),
  );
}

export function installChatZoomShortcuts(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;

  const bump = (delta: number) => {
    const cur = usePreferencesStore.getState().chatFontSize;
    void setChatFontSize(cur + delta);
  };

  window.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey || !targetInsideChat(e)) return;
      e.preventDefault();
      bump(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );

  window.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || e.metaKey) return;
    if (!targetInsideChat(e)) return;
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      bump(1);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      bump(-1);
    } else if (e.key === "0") {
      e.preventDefault();
      void setChatFontSize(12);
    }
  });
}

/** Convenience for tests/dev: reset the install guard. */
export function resetChatZoomShortcutsForTest(): void {
  listenersInstalled = false;
}
