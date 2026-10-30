import { useCallback } from "react";
import { useChatStore } from "@/modules/ai";
import {
  AiOpenButton,
  AiStatusBarControls,
} from "@/modules/ai/components/AiStatusBarControls";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProjectsMenu } from "@/app/projectsMenu";
import { IncognitoIcon, UserMultiple02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { CwdBreadcrumb } from "./CwdBreadcrumb";
import { WorkspaceEnvSelector } from "./WorkspaceEnvSelector";
import { RadioMarquee } from "@/modules/radio";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { WorkspaceEnv } from "@/modules/workspace";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
  onWorkspaceChange: (env: WorkspaceEnv) => void;
  /** Only rendered when the AI panel is open and a key is loaded. */
  hasComposer: boolean;
  privateActive: boolean;
};

export function StatusBar({
  cwd,
  filePath,
  home,
  onCd,
  onWorkspaceChange,
  hasComposer,
  privateActive,
}: Props) {
  const panelOpen = useChatStore((s) => s.panelOpen);
  const radioEnabled = usePreferencesStore((s) => s.radioEnabled);
  const togglePanel = useChatStore((s) => s.togglePanel);
  const openMini = useChatStore((s) => s.openMini);
  const closeMini = useChatStore((s) => s.closeMini);
  // Cross-project group chats need at least two open projects to exist.
  const projectsMenu = useProjectsMenu();
  const canStartGroup = (projectsMenu?.items.length ?? 0) >= 2;

  const handleOpenAgent = useCallback(() => {
    if (panelOpen) {
      togglePanel();
      closeMini();
    } else {
      togglePanel();
      openMini();
    }
  }, [panelOpen, togglePanel, openMini, closeMini]);

  // Group-chat toggle — sits immediately LEFT of the AI panel toggle in
  // both states (Close AI panel button / Open agent pill).
  const groupToggleButton = canStartGroup ? (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent("Kai:new-group-chat"))}
      title="Start a cross-project group chat"
      aria-label="Start a cross-project group chat"
      className="flex h-6 w-6 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground"
    >
      <HugeiconsIcon icon={UserMultiple02Icon} size={13} strokeWidth={1.75} />
    </button>
  ) : null;

  return (
    <footer className="grid h-9 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 overflow-hidden border-t border-border/60 bg-card/60 px-3 pb-0.5 text-[11px]">
      <div className="flex min-w-0 items-center gap-2">
        <WorkspaceEnvSelector onSelect={onWorkspaceChange} />
        <CwdBreadcrumb cwd={cwd} filePath={filePath} home={home} onCd={onCd} />
        {privateActive ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex shrink-0 cursor-default items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
                <HugeiconsIcon icon={IncognitoIcon} size={11} strokeWidth={2} />
                <span>Private: hidden from AI</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-64 text-[11px] leading-relaxed">
              AI can't see this terminal's output. Use it for secrets, SSH, or
              anything you don't want sent to the model.
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {/* Center column — the radio marquee lives here, truly centered. */}
      <div className="flex min-w-0 items-center justify-center">
        {radioEnabled ? <RadioMarquee /> : null}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-1.5">
        {panelOpen && hasComposer ? (
          <AiStatusBarControls left={groupToggleButton} />
        ) : (
          <>
            {groupToggleButton}
            <AiOpenButton onOpen={handleOpenAgent} />
          </>
        )}
      </div>
    </footer>
  );
}
