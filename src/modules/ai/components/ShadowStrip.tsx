import {
  AlertCircleIcon,
  Copy02Icon,
  Delete02Icon,
  Shield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import {
  createShadow,
  discardShadow,
  formatMergeReport,
  loadShadow,
  mergeShadow,
} from "../lib/shadow";
import type { ShadowInfo } from "../lib/native";
import { useChatStore } from "../store/chatStore";
import { Button } from "@/components/ui/button";

type Props = {
  sessionId: string | null;
};

/**
 * Shadow session strip (Layer 3) — shows the active shadow copy state with
 * Merge / Discard controls. Lives above the composer; renders nothing when
 * no project is open.
 */
export function ShadowStrip({ sessionId }: Props) {
  const root = useChatStore((s) => s.live.getWorkspaceRoot());
  const [shadow, setShadow] = useState<ShadowInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    let alive = true;
    setShadow(null);
    setMessage("");
    if (!root) return;
    void loadShadow(root).then((info) => {
      if (alive) setShadow(info);
    });
    return () => {
      alive = false;
    };
  }, [root, sessionId]);

  const onStart = async () => {
    if (!root || busy) return;
    setBusy(true);
    setMessage("");
    setIsError(false);
    try {
      const info = await createShadow(root);
      setShadow(info);
    } catch (e) {
      setIsError(true);
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onMerge = async () => {
    if (!root || busy) return;
    setBusy(true);
    try {
      const report = await mergeShadow(root, false);
      setShadow(null);
      setMessage(formatMergeReport(report));
      setIsError(report.conflicts.length > 0);
    } catch (e) {
      setIsError(true);
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDiscard = async () => {
    if (!root || busy) return;
    setBusy(true);
    setMessage("");
    try {
      await discardShadow(root);
      setShadow(null);
    } catch (e) {
      setIsError(true);
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!root) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-border/80 bg-primary/5 px-3 py-1.5">
      <HugeiconsIcon
        icon={Shield01Icon}
        size={12}
        strokeWidth={1.75}
        className={cn("shrink-0", shadow ? "text-primary" : "text-muted-foreground")}
      />
      {shadow ? (
        <>
          <span className="min-w-0 flex-1 truncate text-[11px]">
            <span className="font-medium">Shadow session active</span>
            <span className="text-muted-foreground">
              {" "}— edits go to an isolated copy{shadow.sharedDirs.length > 0 ? ` (${shadow.sharedDirs.join(", ")} shared)` : ""}
            </span>
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            disabled={busy}
            onClick={() => void onMerge()}
            title="Copy the shadow's changes back into the real project"
          >
            <HugeiconsIcon icon={Copy02Icon} size={11} strokeWidth={1.75} />
            Merge
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            disabled={busy}
            onClick={() => void onDiscard()}
            title="Delete the shadow copy — the real project keeps nothing from it"
          >
            <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.75} />
            Discard
          </Button>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {message || "Agent edits apply directly to the real project."}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            disabled={busy}
            onClick={() => void onStart()}
            title="Work in an isolated copy; merge or discard at the end"
          >
            Start shadow session
          </Button>
        </>
      )}
      {message && shadow ? (
        <span
          className={cn(
            "flex items-center gap-1 truncate text-[11px]",
            isError ? "text-amber-500" : "text-muted-foreground",
          )}
          title={message}
        >
          {isError ? (
            <HugeiconsIcon icon={AlertCircleIcon} size={11} strokeWidth={1.75} className="shrink-0" />
          ) : null}
          <span className="truncate">{message}</span>
        </span>
      ) : null}
      {isError && !shadow ? (
        <span className="truncate text-[11px] text-red-500" title={message}>
          {message}
        </span>
      ) : null}
    </div>
  );
}
