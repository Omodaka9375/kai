import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { Message01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback } from "react";
import { useChatStore } from "../store/chatStore";
import { ModelDropdown } from "./ModelPicker";

export function AiOpenButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-md border border-border/60 bg-card px-2 text-xs",
        "text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground",
      )}
      title="Open agent"
    >
      <span>Open agent</span>
      <Kbd className="h-4 min-w-4 px-1">{fmtShortcut(MOD_KEY, "I")}</Kbd>
    </button>
  );
}

export function AiStatusBarControls() {
  const togglePanel = useChatStore((s) => s.togglePanel);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const closeMini = useChatStore((s) => s.closeMini);
  const outputTps = useChatStore((s) => s.agentMeta.outputTps);
  const isStreaming = useChatStore((s) => s.agentMeta.status === "streaming");

  const handleToggle = useCallback(() => {
    if (panelOpen) {
      togglePanel();
      closeMini();
    } else {
      togglePanel();
    }
  }, [panelOpen, togglePanel, closeMini]);

  return (
    <div className="flex items-center gap-0.5">
      {isStreaming && outputTps > 0 ? (
        <span className="flex h-5.5 items-center rounded-md border border-border/60 bg-card px-1.5 tabular-nums text-[10px] text-muted-foreground my-1">
          {outputTps} tok/s
        </span>
      ) : null}
      <ModelDropdown />

      <span className="mx-1 h-8 w-px bg-border" aria-hidden />
      <IconBtn
        title={panelOpen ? "Close AI panel" : "Open AI panel"}
        onClick={handleToggle}
      >
        <HugeiconsIcon icon={Message01Icon} size={13} strokeWidth={1.75} />
      </IconBtn>
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  disabled,
  className,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "size-6 rounded-md text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      {children}
    </Button>
  );
}