import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { HugeiconsIcon } from "@hugeicons/react";
import { SentIcon } from "@hugeicons/core-free-icons";
import { useEffect, useState } from "react";
import { useChatStore, projectIdForSession } from "../store/chatStore";
import { useProjectRuntime } from "@/modules/workspace";

/**
 * "Monitor via Telegram" - the desktop-side half of "send project to
 * assistant". Binding a project:
 *   - pings the owner's Telegram when the project's agent finishes a reply
 *     or needs an approval, and
 *   - lets the owner prompt the project from the phone (/tell, or plain
 *     text when exactly one project is bound).
 *
 * The row reads the CURRENT binding state on every menu open (prefs live
 * in kai-assistant.json, cross-window) and toggles. The assistant runtime
 * is imported lazily: the bridge module pulls chatStore-side machinery we
 * don't want in every dropdown render, and the settings window must never
 * transitively load it through this component.
 *
 * Shown only when the Telegram bridge is enabled (a binding without the
 * bot running is dead weight in the menu - and a confusing toggle).
 */
export function TelegramMonitorMenuItem() {
  const runtime = useProjectRuntime();
  const sessionId = useChatStore((s) => s.activeSessionId);
  const [bound, setBound] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setBound(null);
    setError("");
    void (async () => {
      try {
        const { loadAssistantPrefs } = await import("@/modules/assistant/prefs");
        const prefs = await loadAssistantPrefs();
        if (!alive) return;
        if (!prefs.enabled) {
          setBound(null);
          return;
        }
        const projectId = runtime?.id ?? (sessionId ? projectIdForSession(sessionId) : null);
        setBound(projectId != null && Object.prototype.hasOwnProperty.call(prefs.boundProjects, projectId));
      } catch {
        if (alive) setBound(null);
      }
    })();
    return () => {
      alive = false;
    };
    // Re-resolve on every open: the menu remounts per open anyway, but the
    // sessionId dep keeps a mid-session switch honest.
  }, [runtime?.id, sessionId]);

  if (bound === null) return null;

  const toggle = async () => {
    if (busy) return;
    const projectId = runtime?.id ?? (sessionId ? projectIdForSession(sessionId) : null);
    if (!projectId) return;
    setBusy(true);
    setError("");
    try {
      const root = useChatStore.getState().live.getWorkspaceRoot();
      const name = root ? root.split(/[\\/]/).filter(Boolean).pop() ?? root : null;
      if (!root || !name) return;
      const mod = await import("@/modules/assistant/projectBridge");
      if (bound) {
        await mod.unbindProjectFromTelegram(projectId);
      } else {
        await mod.bindProjectForTelegramWith(projectId, root, name, sessionId);
      }
      setBound(!bound);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DropdownMenuItem
        onSelect={(e) => {
          e.preventDefault();
          void toggle();
        }}
        disabled={busy}
        className="gap-2 text-xs"
        title="Ping your Telegram when this project's agent replies or needs approval, and prompt it from your phone via /tell"
      >
        <HugeiconsIcon icon={SentIcon} size={12} strokeWidth={1.75} />
        {busy ? "Working." : bound ? "Stop Telegram monitoring" : "Monitor via Telegram"}
      </DropdownMenuItem>
      {error ? (
        <div className="px-2 py-1 text-[10.5px] leading-snug text-red-500">{error}</div>
      ) : null}
    </>
  );
}
