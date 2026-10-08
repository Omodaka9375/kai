import { cn } from "@/lib/utils";
import { IS_MAC, KEY_SEP } from "@/lib/platform";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { SHORTCUTS, getBindingTokens, type ShortcutId } from "@/modules/shortcuts/shortcuts";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiChat01Icon,
  ArrowUpRightIcon,
  FolderOpenIcon,
  InformationCircleIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { useCallback, useMemo } from "react";

type Props = {
  /** Spawn a terminal tab (uses the current workspace cwd). */
  onNewTerminal: () => void;
  /** Open a project folder (re-roots the workspace). */
  onOpenProject: (path: string) => void;
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
export function StartPage({ onNewTerminal, onOpenProject }: Props) {
  const recentProjects = usePreferencesStore((s) => s.recentProjects) || [];
  const lastWorkspaceCwd = usePreferencesStore((s) => s.lastWorkspaceCwd);
  const openPanel = useChatStore((s) => s.openPanel);
  const focusInput = useChatStore((s) => s.focusInput);
  const newTerminalHint = useShortcutLabel("tab.new");
  const chatHint = useShortcutLabel("ai.toggle");

  const openChat = useCallback(() => {
    openPanel();
    focusInput(null);
  }, [openPanel, focusInput]);

  const pickProject = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const selected = await invoke<string | null>("pick_project_folder");
      if (selected) onOpenProject(selected);
    } catch (e) {
      console.error("Open project failed:", e);
    }
  }, [onOpenProject]);

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
        key: "project",
        label: "Open project…",
        hint: "",
        icon: FolderOpenIcon,
        onClick: () => void pickProject(),
      },
    ],
    [onNewTerminal, openChat, pickProject, newTerminalHint, chatHint],
  );

  const basename = (p: string) => {
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? p;
  };

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center overflow-auto bg-background px-6">
      <div className="flex w-full max-w-xl flex-col gap-6 py-10">
        {/* Quick actions */}
        <div className="grid w-full grid-cols-3 gap-2">
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

        {/* Recent projects */}
        {recentProjects.length > 0 && (
          <div className="w-full">
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              Recent projects
            </div>
            <div className="flex flex-col">
              {recentProjects.slice(0, 6).map((path) => {
                const norm = (p: string) =>
                  p.replace(/\\/g, "/").replace(/\/$/, "");
                const active = norm(path) === norm(lastWorkspaceCwd ?? "");
                return (
                  <button
                    key={path}
                    type="button"
                    onClick={() => onOpenProject(path)}
                    className={cn(
                      "group flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60",
                      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    )}
                  >
                    <HugeiconsIcon
                      icon={ArrowUpRightIcon}
                      size={12}
                      strokeWidth={1.75}
                      className="shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground"
                    />
                    <span className="shrink-0 text-[12px] font-medium text-foreground">
                      {basename(path)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground/70">
                      {path}
                    </span>
                    {active ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        current
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        )}

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
