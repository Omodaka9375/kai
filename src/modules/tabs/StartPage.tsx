import { cn } from "@/lib/utils";
import { IS_MAC, KEY_SEP } from "@/lib/platform";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { SHORTCUTS, getBindingTokens, type ShortcutId } from "@/modules/shortcuts/shortcuts";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiChat01Icon,
  ApiIcon,
  IncognitoIcon,
  InformationCircleIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { useCallback, useMemo } from "react";

type Props = {
  /** Spawn a terminal tab (uses the current workspace cwd). */
  onNewTerminal: () => void;
  /** Spawn a private terminal tab (hidden from the AI agent). */
  onNewPrivateTerminal: () => void;
  /** Spawn an API tester tab. */
  onNewApiTester: () => void;
};

/** User bindings override defaults (same resolution as the Header). */
function useShortcutLabel(id: ShortcutId): string {
  const userBindings = usePreferencesStore((s) => s.shortcuts);
  const s = SHORTCUTS.find((x) => x.id === id);
  const bindings = userBindings[id] || s?.defaultBindings;
  if (!bindings || bindings.length === 0) return "";
  return getBindingTokens(bindings[0]).join(KEY_SEP);
}

/**
 * Neutral start page — rendered when there are no tabs. Replaces the old
 * launch auto-spawn: user-initiated terminal spawns can't race the first
 * paint / window-state restore / font-gate the way a mount-time PTY did
 * (the renderer-bind race class). Everything here is pure DOM until the
 * user acts.
 *
 * Theming: only shadcn tokens (background/card/accent/border/muted-
 * foreground/ring) — nothing hard-coded; radius and text sizes follow the
 * app's dense compact scale (rounded-md/lg, text-[11..13px]).
 */
export function StartPage({
  onNewTerminal,
  onNewPrivateTerminal,
  onNewApiTester,
}: Props) {
  const openPanel = useChatStore((s) => s.openPanel);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const focusInput = useChatStore((s) => s.focusInput);
  const openMini = useChatStore((s) => s.openMini);
  const closeMini = useChatStore((s) => s.closeMini);
  const togglePanel = useChatStore((s) => s.togglePanel);
  const newTerminalHint = useShortcutLabel("tab.new");
  const chatHint = useShortcutLabel("ai.toggle");

  const openChat = useCallback(() => {
    // Same contract as the status-bar agent button (f1411bb): the panel and
    // the mini window open/close TOGETHER. StartPage's button used to open
    // only the bottom panel, so the agent window never appeared.
    if (panelOpen) {
      togglePanel();
      closeMini();
    } else {
      openPanel();
      openMini();
      focusInput(null);
    }
  }, [panelOpen, togglePanel, openPanel, openMini, closeMini, focusInput]);

  const actions = useMemo(
    () => [
      {
        key: "terminal",
        label: "New terminal",
        hint: newTerminalHint,
        icon: TerminalIcon,
        onClick: onNewTerminal,
      },
      {
        key: "chat",
        label: "Open chat",
        hint: chatHint,
        icon: AiChat01Icon,
        onClick: openChat,
      },
      {
        key: "private",
        label: "Private terminal",
        hint: "",
        icon: IncognitoIcon,
        onClick: onNewPrivateTerminal,
      },
      {
        key: "api-tester",
        label: "API tester",
        hint: "",
        icon: ApiIcon,
        onClick: onNewApiTester,
      },
    ],
    [onNewTerminal, onNewPrivateTerminal, onNewApiTester, openChat, newTerminalHint, chatHint],
  );

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center overflow-auto bg-background px-6">
      <div className="flex w-full max-w-xl flex-col gap-6 py-10">
        {/* Quick actions */}
        <div className="grid w-full grid-cols-2 gap-2">
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={a.onClick}
              className={cn(
                "group flex flex-col items-start gap-2.5 rounded-lg border border-border/60 bg-card/60 px-3 py-3 text-left",
                "transition-colors hover:border-border hover:bg-accent/60",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
            >
              <HugeiconsIcon
                icon={a.icon}
                size={16}
                strokeWidth={1.75}
                className="text-muted-foreground group-hover:text-foreground"
              />
              <span className="flex w-full items-center justify-between gap-1.5">
                <span className="text-[12px] font-medium text-foreground">
                  {a.label}
                </span>
                {a.hint ? (
                  <kbd className="rounded border border-border/60 bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {a.hint}
                  </kbd>
                ) : null}
              </span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
          <HugeiconsIcon
            icon={InformationCircleIcon}
            size={12}
            strokeWidth={1.75}
            className="shrink-0"
          />
          <span>
            Terminals spawn on demand — {IS_MAC ? "⌘T" : "Ctrl+T"} opens one
            anytime.
          </span>
        </div>
      </div>
    </div>
  );
}
