/**
 * Shared chat font-size control for the AI-chat and group-chat panels.
 *
 * One persisted preference (Settings → General → Chat), consumed by both
 * chat surfaces: the panel root gets `fontSize: <n>px` inline (inherited
 * base) plus a `--kai-chat-font` variable the transcript wrapper uses to
 * scale its fixed text utilities. Ctrl+scroll and Ctrl+plus/minus/0 work
 * while the pointer or focus is inside an AI/group panel.
 */
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setChatFontSize } from "@/modules/settings/store";

export function useChatFontSize(): { px: number; rootStyle: React.CSSProperties } {
  const px = usePreferencesStore((s) => s.chatFontSize);
  return {
    px,
    rootStyle: { fontSize: `${px}px`, ["--kai-chat-font" as string]: `${px}px` },
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
